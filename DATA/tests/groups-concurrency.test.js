'use strict';

// T-5C-18 to T-5C-20: real HTTP races between independent Node processes sharing a
// disposable SQLite file. Seeds and both process logs are included on every failure.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setup, envDefaults } = require('./support/auth');
const { createGroupBuilder, createClock, guardPath } = require('./support/groups');
const { createGroupRepository } = require('../server/database/groupRepository');
const { createRepositories } = require('../server/database/repositories');
const { createRandom } = require('./support/random');

const SEED = 0x5c182020;
const REPEATS = 20;
const MAX_MEMBERS = 50;
const FEATURES = Object.freeze({ groupApi:true, groupMessaging:false, attachmentApi:false,
    groups:Object.freeze({ directAdd:true, maxMembers:MAX_MEMBERS, maxPendingInvitationsPerGroup:50,
        maxPendingInvitationsPerInvitee:50 }) });
const WORKER = path.join(__dirname, 'support', 'groups-worker.cjs');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(predicate, label, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const value = predicate();
        if (value) return value;
        await sleep(1);
    }
    throw new Error(`timed out waiting for ${label}`);
}

function collect(child) {
    const result = { stdout:'', stderr:'', exit:null, error:null };
    child.stdout.setEncoding('utf8').on('data', chunk => { result.stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { result.stderr += chunk; });
    child.once('error', error => { result.error = error.message; });
    child.once('exit', (code, signal) => { result.exit = { code, signal }; });
    return result;
}

async function launch(fixture, barrier, index) {
    const environment = { ...process.env, ...envDefaults, NODE_ENV:'test', HOST:'127.0.0.1', PORT:'0',
        DB_PATH:fixture.filename, SECUBUZZ_ISOLATED_GROUP_WORKER:'1',
        SECUBUZZ_GROUP_WORKER_FEATURES:JSON.stringify(FEATURES),
        SECUBUZZ_GROUP_WORKER_BARRIER:barrier, SECUBUZZ_GROUP_WORKER_INDEX:String(index) };
    const child = spawn(process.execPath, [WORKER], { cwd:path.join(__dirname, '..'), env:environment,
        stdio:['pipe','pipe','pipe'], windowsHide:true });
    fixture.children.push(child);
    const log = collect(child);
    await until(() => log.stdout.match(/^READY (\d+)\r?$/m), `worker ${index} readiness`);
    return { child, log };
}

async function resultLine(worker) {
    await until(() => worker.log.stdout.split(/\r?\n/).filter(line => line.startsWith('{')).length > 0 || worker.log.exit,
        'worker response');
    const line = worker.log.stdout.split(/\r?\n/).find(value => value.startsWith('{'));
    if (!line) throw new Error(`worker exited without JSON: ${JSON.stringify(worker.log)}`);
    return JSON.parse(line);
}

function actorInput(actor, method, route, body) {
    const cookie = [...actor.browser.cookies].map(([key,value]) => `${key}=${value}`).join('; ');
    return { method, path:`/api/groups${route}`, ...(body === undefined ? {} : { body }), cookie, csrf:actor.csrf };
}

async function runPair(fixture, requests, label) {
    assert.equal(requests.length, 2);
    const barrier = guardPath(fs.mkdtempSync(path.join(os.tmpdir(), 'secubuzz-db5-')));
    const workers = [];
    try {
        workers.push(await launch(fixture, barrier, 0));
        workers.push(await launch(fixture, barrier, 1));
        workers[0].child.stdin.write(`${JSON.stringify(requests[0])}\n`);
        workers[1].child.stdin.write(`${JSON.stringify(requests[1])}\n`);
        await until(() => (fs.existsSync(path.join(barrier, 'ready-0')) && fs.existsSync(path.join(barrier, 'ready-1')))
            || workers.some(worker => worker.log.exit),
            'both workers at file barrier');
        if (workers.some(worker => worker.log.exit)) throw new Error('worker exited before both reached the barrier');
        const go = guardPath(path.join(barrier, 'go'));
        fs.writeFileSync(go, 'go\n', { flag:'wx', mode:0o600 });
        const results = await Promise.all(workers.map(resultLine));
        for (const worker of workers) {
            if (worker.log.exit === null) await until(() => worker.log.exit, `worker ${worker.log.index ?? ''} exit`, 10000);
        }
        fixture.lastProcessLogs = workers.map((worker,index) => ({ index, ...worker.log }));
        return results;
    } catch (error) {
        const logs = workers.map((worker,index) => ({ index, ...worker.log }));
        throw new Error(`${label}\nprocess logs: ${JSON.stringify(logs)}`, { cause:error });
    } finally {
        for (const worker of workers) if (worker.child.exitCode === null && worker.child.signalCode === null) {
            const exited = once(worker.child, 'exit'); worker.child.kill(); await exited;
        }
        for (const entry of fs.readdirSync(barrier)) fs.unlinkSync(path.join(barrier, entry));
        fs.rmdirSync(barrier);
    }
}

function responseSet(results) { return results.map(result => result.status).sort((a,b) => a-b); }
function assertNoServerFailures(results, context) {
    assert.ok(results.every(result => result.status !== 500 && result.status !== 503), `${context}: ${JSON.stringify(results)}`);
}

async function fixture(t) {
    const clock = createClock(new Date(Date.now() - 30000).toISOString());
    const f = await setup(t, { now:clock.now, features:FEATURES, limiter:{ consume:() => ({ allowed:true }) } });
    guardPath(f.filename);
    const users = {};
    for (let i=0;i<12;i++) {
        const name = `conc-${i}`;
        const browser = f.browser();
        assert.equal((await browser.register(name)).status, 201, `synthetic registration ${name}`);
        const login = await browser.login(name);
        assert.equal(login.status, 200, `synthetic login ${name}`);
        users[i] = { id:login.body.user.id, browser, csrf:await browser.csrf() };
    }
    let groupNumber = 0;
    const repositories = createRepositories(f.db);
    const builder = createGroupBuilder({ db:f.db, repositories, clock });
    const repository = createGroupRepository(f.db);
    function group({ size=4, roles=[], owner=0, historyPolicy='from_joined' } = {}) {
        if (!Number.isSafeInteger(size) || size < 1 || size > 10) throw new RangeError('group fixture size must use registered actors');
        const key = `concurrency-fixture-${++groupNumber}`;
        const id = builder.createGroup({ ownerId:users[owner].id, title:`Concurrent ${key}`, historyPolicy, idempotencyKey:key });
        const memberSlots = [];
        for (let slot=1;slot<size;slot++) {
            const userIndex = slot;
            builder.addMember(id, users[userIndex].id, { role:roles[slot-1] || 'member' });
            memberSlots.push(userIndex);
        }
        return { id, owner, members:memberSlots, revision:f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(id).membership_revision };
    }
    function state(id) {
        const invariant = repository.invariantReport(id);
        const extension = f.db.prepare('SELECT membership_revision, archived_at FROM GroupExtensions JOIN Conversations USING(conversation_id) WHERE conversation_id=?').get(id);
        const members = f.db.prepare('SELECT user_id, role, left_at FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id').all(id);
        const invitations = f.db.prepare('SELECT invitation_id, invitee_id, inviter_id, state FROM ConversationInvitations WHERE conversation_id=? ORDER BY invitation_id').all(id);
        const audit = f.db.prepare('SELECT event_type, actor_user_id, subject_id FROM AuditLogs WHERE subject_id=? ORDER BY audit_id').all(id);
        const integrity = f.db.pragma('foreign_key_check');
        return { invariant, extension, members, invitations, audit, integrity };
    }
    return { ...f, clock, repositories, builder, users, group, state, repository };
}

function assertGroupInvariant(f, id) {
    const current = f.state(id);
    assert.deepEqual(current.invariant, { activeOwners:1, activeMembers:current.invariant.activeMembers,
        openIntervals:current.invariant.activeMembers, mismatches:0 });
    assert.equal(current.members.filter(member => member.left_at === null && member.role === 'owner').length, 1);
    assert.deepEqual(current.integrity, []);
    return current;
}

function auditCount(f,id,event) { return f.db.prepare('SELECT count(*) AS n FROM AuditLogs WHERE subject_id=? AND event_type=?').get(id,event).n; }
function revision(f,id) { return f.db.prepare('SELECT membership_revision AS n FROM GroupExtensions WHERE conversation_id=?').get(id).n; }
function pending(f,id) { return f.db.prepare("SELECT count(*) AS n FROM ConversationInvitations WHERE conversation_id=? AND state='pending'").get(id).n; }
function isActive(f,id,userId) { const row=f.db.prepare('SELECT left_at FROM ConversationMembers WHERE conversation_id=? AND user_id=?').get(id,userId); return Boolean(row && row.left_at===null); }

test('T-5C-18/19/20: independent-process group concurrency properties', { timeout:30*60*1000 }, async t => {
    const f = await fixture(t);
    const random = createRandom(SEED);
    t.diagnostic(`property=P-02/P-08 seed=${SEED}`);
    let pairCount = 0;
    const check = async (name, build, verify, repeats=REPEATS) => {
        for (let run=0;run<repeats;run++) {
            pairCount++;
            const seed = random.fork(`${name}-${run}`).seed;
            f.lastProcessLogs = [];
            f.lastResults = [];
            try {
                const scenario = build(random.fork(`${name}-${run}`));
                const before = scenario.group ? revision(f, scenario.group.id) : 0;
                const results = await runPair(f, scenario.requests, `${name} seed=${seed} run=${run}`);
                f.lastResults = results;
                assertNoServerFailures(results, `${name} seed=${seed} run=${run}`);
                verify(results, scenario, before);
                if (scenario.group) assertGroupInvariant(f, scenario.group.id);
            } catch (error) {
                throw new Error(`${name} seed=${seed} run=${run}\nresults: ${JSON.stringify(f.lastResults || [])}\nprocess logs: ${JSON.stringify(f.lastProcessLogs || [])}\n${error.message}`, { cause:error });
            }
            if (name.startsWith('P02-')) {
                const probe=make(3);
                const transfer=await f.users[probe.owner].browser.post(`/api/groups/${probe.id}/transfer`,
                    {userId:f.users[probe.members[0]].id},f.users[probe.owner].csrf);
                assert.equal(transfer.status,200,`${name}: stale-owner probe transfer`);
                const stale=await f.users[probe.owner].browser.post(`/api/groups/${probe.id}/transfer`,
                    {userId:f.users[probe.members[1]].id},f.users[probe.owner].csrf);
                assert.equal(stale.status,403,`${name}: former owner must be forbidden`);
                assertGroupInvariant(f,probe.id);
            }
        }
    };
    const req = (user,method,route,body) => actorInput(f.users[user],method,route,body);
    const make = (size=4,roles=[]) => f.group({ size, roles });
    const randomPopulated = (randomCase,firstRole=null) => {
        const size=randomCase.int(3,6);
        const roles=Array.from({length:size-1},()=>randomCase.pick(['member','admin']));
        if(firstRole) roles[0]=firstRole;
        return make(size,roles);
    };
    let fixtureOrdinal=0;

    // T-5C-18 gate pairs.
    await check('transfer-transfer', () => {
        const g=make(4); return { group:g, targets:g.members.slice(0,2), requests:g.members.slice(0,2).map(target=>req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[target].id})) };
    }, (results,s,before) => {
        assert.deepEqual(responseSet(results),[200,403]);
        const current=f.state(s.group.id); assert.equal(current.extension.membership_revision,before+1);
        assert.equal(current.audit.filter(row=>row.event_type==='group.owner.transferred').length,1);
        assert.equal(current.members.filter(row=>row.left_at===null&&row.role==='owner').length,1);
    });

    await check('invite-invite', () => {
        const g=make(3); const invitee=8; const route=`/${g.id}/invitations`;
        return { group:g, requests:[req(g.owner,'POST',route,{userId:f.users[invitee].id}),req(g.owner,'POST',route,{userId:f.users[invitee].id})] };
    }, (results,s,before) => {
        assert.deepEqual(responseSet(results),[201,409]); assert.equal(pending(f,s.group.id),1);
        assert.equal(revision(f,s.group.id),before); assert.equal(auditCount(f,s.group.id,'group.invitation.created'),1);
    });

    await check('accept-remove-inviter', () => {
        const g=make(4,['admin','member','member']); const inviter=g.members[0], invitee=8;
        const key=f.db.prepare('SELECT count(*) AS n FROM ConversationInvitations').get().n+1;
        const invitationId=`race-invitation-${key}`;
        f.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
          VALUES(?,?,?,?,'pending',?,?,NULL)`).run(invitationId,g.id,f.users[invitee].id,f.users[inviter].id,f.clock.iso(),f.clock.iso(7*86400000));
        return { group:g, inviter, invitee, invitationId, requests:[req(invitee,'POST',`/invitations/${invitationId}/accept`),req(g.owner,'DELETE',`/${g.id}/members/${f.users[inviter].id}`)] };
    }, (results,s,before) => {
        assert.ok([[200,204],[204,409]].some(expected=>JSON.stringify(responseSet(results))===JSON.stringify(expected)));
        const current=f.state(s.group.id); const invite=current.invitations.find(row=>row.invitation_id===s.invitationId);
        assert.ok(['accepted','cancelled'].includes(invite.state));
        const accepted=invite.state==='accepted'; assert.equal(isActive(f,s.group.id,f.users[s.invitee].id),accepted);
        assert.equal(isActive(f,s.group.id,f.users[s.inviter].id),false);
        assert.equal(current.extension.membership_revision,before+(accepted?2:1));
        assert.equal(current.audit.filter(row=>['group.invitation.accepted','group.member.removed'].includes(row.event_type)).length,accepted?2:1);
    });

    await check('leave-transfer', () => {
        const g=make(3); const target=g.members[0];
        return { group:g, requests:[req(g.owner,'POST',`/${g.id}/leave`),req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[target].id})] };
    }, (results,s,before) => {
        assert.ok([[200,409],[200,204]].some(expected=>JSON.stringify(responseSet(results))===JSON.stringify(expected)));
        const current=f.state(s.group.id); assert.equal(current.members.filter(row=>row.left_at===null&&row.role==='owner').length,1);
        assert.equal(current.extension.membership_revision,before+(current.audit.some(row=>row.event_type==='group.member.left')?2:1));
        assert.equal(current.audit.filter(row=>row.event_type==='group.owner.transferred').length,1);
    });

    // P-02 ownership changes on randomly populated 3–6 member groups.
    await check('P02-transfer-different-targets', randomCase => {
        const g=randomPopulated(randomCase), targets=g.members.slice(0,2);
        return { group:g, requests:targets.map(target=>req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[target].id})) };
    }, (results,s,before) => {
        assert.deepEqual(responseSet(results),[200,403]); assert.equal(revision(f,s.group.id),before+1);
        assert.equal(auditCount(f,s.group.id,'group.owner.transferred'),1);
    });

    await check('P02-owner-leave-transfer', randomCase => {
        const g=randomPopulated(randomCase); const target=g.members[0];
        return { group:g, requests:[req(g.owner,'POST',`/${g.id}/leave`),req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[target].id})] };
    }, (results,s,before) => {
        assert.ok([[200,409],[200,204]].some(expected=>JSON.stringify(responseSet(results))===JSON.stringify(expected)));
        const current=f.state(s.group.id); assert.equal(current.members.filter(row=>row.left_at===null&&row.role==='owner').length,1);
        assert.equal(current.extension.membership_revision,before+(current.audit.some(row=>row.event_type==='group.member.left')?2:1));
        assert.equal(auditCount(f,s.group.id,'group.owner.transferred'),1);
    });

    await check('P02-remove-admin-transfer', randomCase => {
        const g=randomPopulated(randomCase,'admin'); const target=g.members[0];
        return { group:g, target, requests:[req(g.owner,'DELETE',`/${g.id}/members/${f.users[target].id}`),req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[target].id})] };
    }, (results,s,before) => {
        assert.ok([[200,403],[204,400]].some(expected=>JSON.stringify(responseSet(results))===JSON.stringify(expected)));
        const current=f.state(s.group.id); assert.equal(current.members.filter(row=>row.left_at===null&&row.role==='owner').length,1);
        assert.equal(current.audit.filter(row=>row.event_type==='group.owner.transferred').length,Number(current.members.some(row=>row.user_id===f.users[s.target].id&&row.role==='owner')));
        assert.equal(revision(f,s.group.id),before+1);
        assert.equal(current.audit.filter(row=>row.event_type==='group.member.removed').length,Number(!isActive(f,s.group.id,f.users[s.target].id)));
    });

    await check('P02-accept-transfer', randomCase => {
        const g=randomPopulated(randomCase), invitee=8, invitationId=`p02-inv-${++fixtureOrdinal}`;
        f.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
          VALUES(?,?,?,?,'pending',?,?,NULL)`).run(invitationId,g.id,f.users[invitee].id,f.users[g.owner].id,f.clock.iso(),f.clock.iso(7*86400000));
        return { group:g, invitee, requests:[req(invitee,'POST',`/invitations/${invitationId}/accept`),req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[g.members[0]].id})] };
    }, (results,s,before) => {
        assert.deepEqual(responseSet(results),[200,200]); assert.equal(auditCount(f,s.group.id,'group.owner.transferred'),1);
        assert.equal(revision(f,s.group.id),before+2); assert.equal(isActive(f,s.group.id,f.users[s.invitee].id),true);
    });

    await check('P02-role-transfer', randomCase => {
        const g=randomPopulated(randomCase,'member'), roleTarget=g.members[0], newOwner=g.members[1];
        return { group:g, roleTarget, requests:[req(g.owner,'PATCH',`/${g.id}/members/${f.users[roleTarget].id}`,{role:'admin'}),req(g.owner,'POST',`/${g.id}/transfer`,{userId:f.users[newOwner].id})] };
    }, (results,s,before) => {
        assert.ok([[200,200],[200,403]].some(expected=>JSON.stringify(responseSet(results))===JSON.stringify(expected)));
        const roleChanged=auditCount(f,s.group.id,'group.role.changed');
        assert.equal(revision(f,s.group.id),before+1+roleChanged);
        assert.equal(auditCount(f,s.group.id,'group.owner.transferred'),1); assert.ok(roleChanged===0||roleChanged===1);
    });

    // P-08: each scenario is checked against its serial model and committed audit/revision effects.
    await check('P08-duplicate-invitations', () => {
        const g=make(3), invitee=8, route=`/${g.id}/invitations`;
        return { group:g, requests:[req(g.owner,'POST',route,{userId:f.users[invitee].id}),req(g.owner,'POST',route,{userId:f.users[invitee].id})] };
    }, (r,s,before) => { assert.deepEqual(responseSet(r),[201,409]); assert.equal(pending(f,s.group.id),1); assert.equal(auditCount(f,s.group.id,'group.invitation.created'),1); assert.equal(revision(f,s.group.id),before); });

    await check('P08-create-same-key', () => {
        const key=`race-key-${++fixtureOrdinal}`, body={name:'Idempotent race',historyPolicy:'from_joined',idempotencyKey:key};
        return { group:null, requests:[req(0,'POST','/',body),req(0,'POST','/',body)] };
    }, (r,s) => {
        assert.deepEqual(responseSet(r),[200,201]); const ids=r.map(x=>x.body.group.id); assert.equal(new Set(ids).size,1);
        const count=f.db.prepare('SELECT count(*) AS n FROM Conversations WHERE conversation_id=?').get(ids[0]).n; assert.equal(count,1);
        assert.equal(f.db.prepare("SELECT count(*) AS n FROM AuditLogs WHERE subject_id=? AND event_type='group.created'").get(ids[0]).n,1);
    });

    await check('P08-accept-cancel', () => {
        const g=make(3), invitee=8, invitationId=`p08-cancel-${++fixtureOrdinal}`;
        f.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
          VALUES(?,?,?,?,'pending',?,?,NULL)`).run(invitationId,g.id,f.users[invitee].id,f.users[g.owner].id,f.clock.iso(),f.clock.iso(7*86400000));
        return { group:g, invitationId, invitee, requests:[req(invitee,'POST',`/invitations/${invitationId}/accept`),req(g.owner,'DELETE',`/${g.id}/invitations/${invitationId}`)] };
    }, (r,s,before) => {
        assert.ok([[200,409],[204,409]].some(expected=>JSON.stringify(responseSet(r))===JSON.stringify(expected)));
        const state=f.state(s.group.id), invitation=state.invitations.find(row=>row.invitation_id===s.invitationId);
        assert.ok(['accepted','cancelled'].includes(invitation.state)); assert.equal(isActive(f,s.group.id,f.users[s.invitee].id),invitation.state==='accepted');
        assert.equal(revision(f,s.group.id),before+(invitation.state==='accepted'?1:0));
    });

    await check('P08-accept-remove-inviter', () => {
        const g=make(4,['admin','member','member']), inviter=g.members[0], invitee=8, invitationId=`p08-rm-inviter-${++fixtureOrdinal}`;
        f.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
          VALUES(?,?,?,?,'pending',?,?,NULL)`).run(invitationId,g.id,f.users[invitee].id,f.users[inviter].id,f.clock.iso(),f.clock.iso(7*86400000));
        return { group:g, invitationId, inviter, invitee, requests:[req(invitee,'POST',`/invitations/${invitationId}/accept`),req(g.owner,'DELETE',`/${g.id}/members/${f.users[inviter].id}`)] };
    }, (r,s,before) => {
        assert.ok([[200,204],[204,409]].some(expected=>JSON.stringify(responseSet(r))===JSON.stringify(expected)));
        const current=f.state(s.group.id), invite=current.invitations.find(row=>row.invitation_id===s.invitationId);
        assert.equal(invite.state==='accepted',isActive(f,s.group.id,f.users[s.invitee].id));
        assert.equal(revision(f,s.group.id),before+(invite.state==='accepted'?2:1));
        assert.equal(isActive(f,s.group.id,f.users[s.inviter].id),false);
        assert.equal(current.audit.filter(row=>['group.invitation.accepted','group.member.removed'].includes(row.event_type)).length,
            invite.state==='accepted'?2:1);
    });

    await check('P08-add-same-user', () => {
        const g=make(3), target=8;
        return { group:g, requests:[req(g.owner,'POST',`/${g.id}/members`,{userId:f.users[target].id}),req(g.owner,'POST',`/${g.id}/members`,{userId:f.users[target].id})] };
    }, (r,s,before) => { assert.deepEqual(responseSet(r),[201,409]); assert.equal(isActive(f,s.group.id,f.users[8].id),true); assert.equal(revision(f,s.group.id),before+1); assert.equal(auditCount(f,s.group.id,'group.member.added'),1); });

    await check('P08-add-capacity', () => {
        const g=make(10,['admin','member','member']);
        const capacityRun=++fixtureOrdinal;
        for(let index=10;index<49;index++) {
            const userId=`capacity-user-${capacityRun}-${index}`;
            const user=f.repositories.users.create({user_id:userId,username:userId,display_name:userId});
            f.builder.addMember(g.id,user.user_id);
        }
        return { group:g, requests:[
            req(g.owner,'POST',`/${g.id}/members`,{userId:f.users[10].id}),
            req(g.owner,'POST',`/${g.id}/members`,{userId:f.users[11].id})
        ] };
    }, (r,s,before) => { assert.deepEqual(responseSet(r),[201,409]); assert.equal(revision(f,s.group.id),before+1); assert.equal(auditCount(f,s.group.id,'group.member.added'),1); assert.equal(f.state(s.group.id).invariant.activeMembers,MAX_MEMBERS); });

    await check('P08-duplicate-removal', () => {
        const g=make(4), target=g.members[0];
        return { group:g, target, requests:[req(g.owner,'DELETE',`/${g.id}/members/${f.users[target].id}`),req(g.owner,'DELETE',`/${g.id}/members/${f.users[target].id}`)] };
    }, (r,s,before) => { assert.deepEqual(responseSet(r),[204,404]); assert.equal(revision(f,s.group.id),before+1); assert.equal(auditCount(f,s.group.id,'group.member.removed'),1); assert.equal(isActive(f,s.group.id,f.users[s.target].id),false); });

    await check('P08-duplicate-leave', () => {
        const g=make(4,['member','member','admin']), target=g.members[0];
        return { group:g, target, requests:[req(target,'POST',`/${g.id}/leave`),req(target,'POST',`/${g.id}/leave`)] };
    }, (r,s,before) => { assert.deepEqual(responseSet(r),[204,404]); assert.equal(revision(f,s.group.id),before+1); assert.equal(auditCount(f,s.group.id,'group.member.left'),1); assert.equal(isActive(f,s.group.id,f.users[s.target].id),false); });

    await check('P08-remove-role-change', () => {
        const g=make(4), target=g.members[0];
        return { group:g, target, requests:[req(g.owner,'DELETE',`/${g.id}/members/${f.users[target].id}`),req(g.owner,'PATCH',`/${g.id}/members/${f.users[target].id}`,{role:'admin'})] };
    }, (r,s,before) => {
        assert.ok([[200,204],[204,404]].some(expected=>JSON.stringify(responseSet(r))===JSON.stringify(expected)));
        const current=f.state(s.group.id), changed=current.audit.some(row=>row.event_type==='group.role.changed');
        assert.equal(revision(f,s.group.id),before+1+Number(changed)); assert.equal(auditCount(f,s.group.id,'group.member.removed'),1);
    });

    await check('P08-accept-decline', () => {
        const g=make(3), invitee=8, invitationId=`p08-decline-${++fixtureOrdinal}`;
        f.db.prepare(`INSERT INTO ConversationInvitations(invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at)
          VALUES(?,?,?,?,'pending',?,?,NULL)`).run(invitationId,g.id,f.users[invitee].id,f.users[g.owner].id,f.clock.iso(),f.clock.iso(7*86400000));
        return { group:g, invitationId, invitee, requests:[req(invitee,'POST',`/invitations/${invitationId}/accept`),req(invitee,'POST',`/invitations/${invitationId}/decline`)] };
    }, (r,s,before) => {
        assert.ok([[200,409],[204,409]].some(expected=>JSON.stringify(responseSet(r))===JSON.stringify(expected)));
        const current=f.state(s.group.id), invitation=current.invitations.find(row=>row.invitation_id===s.invitationId);
        assert.ok(['accepted','declined'].includes(invitation.state)); assert.equal(isActive(f,s.group.id,f.users[s.invitee].id),invitation.state==='accepted');
        assert.equal(revision(f,s.group.id),before+Number(invitation.state==='accepted'));
    });

    // Transaction boundary and stale-revision checks under the same independent worker path.
    const rollbackGroup=make(3), rollbackBefore=f.state(rollbackGroup.id), rollbackRevision=revision(f,rollbackGroup.id);
    f.db.exec(`CREATE TRIGGER concurrency_test_fail_transfer_audit BEFORE INSERT ON AuditLogs WHEN NEW.subject_id='${rollbackGroup.id}' AND NEW.event_type='group.owner.transferred' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`);
    const failure=await runPair(f,[
        req(rollbackGroup.owner,'POST',`/${rollbackGroup.id}/transfer`,{userId:f.users[rollbackGroup.members[0]].id}),
        req(rollbackGroup.owner,'POST',`/${rollbackGroup.id}/transfer`,{userId:f.users[rollbackGroup.members[1]].id})
    ], 'audit rollback probe');
    assert.deepEqual(responseSet(failure),[500,500]);
    f.db.exec('DROP TRIGGER concurrency_test_fail_transfer_audit');
    assert.equal(revision(f,rollbackGroup.id),rollbackRevision); assert.equal(auditCount(f,rollbackGroup.id,'group.owner.transferred'),0);
    assert.equal(f.state(rollbackGroup.id).members.filter(row=>row.left_at===null&&row.role==='owner').length,1);
    assert.ok(rollbackBefore);

    const staleGroup=make(3), staleRevision=revision(f,staleGroup.id);
    const staleResponse=await f.users[staleGroup.owner].browser.post(`/api/groups/${staleGroup.id}/transfer`,
        { userId:f.users[staleGroup.members[0]].id, membershipRevision:staleRevision-1 }, f.users[staleGroup.owner].csrf);
    assert.equal(staleResponse.status,409); assert.equal(revision(f,staleGroup.id),staleRevision);
    assert.equal(auditCount(f,staleGroup.id,'group.owner.transferred'),0);
    assert.equal(pairCount, 19*REPEATS, 'all specified concurrency pairs ran');
});
