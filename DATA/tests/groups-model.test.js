'use strict';

// T-5C-03: Group_Service infrastructure (DB5-R12.1, R12.5, R12.6, R12.8, R12.9, R13.5, DB5-R02.3, DB5-R06.2, NFR-01).
// Real sessions and real CSRF proofs from the loopback application of support/groups.js. No operation or route exists yet,
// so every test drives groupRead, groupWrite, visibleGroup, requireRole, audit and rate directly.
// Temporary databases only (support/groups.js guards every path); the real database file is never opened.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Database = require('better-sqlite3');
const { httpGroupFixture, snapshot, createClock, openLimiter } = require('./support/groups');
const { setup } = require('./support/contract');
const { createRepositories } = require('../server/database/repositories');
const { createGroupRepository, RepositoryError } = require('../server/database/groupRepository');
const { openDatabase } = require('../server/database/connection');
const { createSqliteRateLimiter } = require('../server/auth/rateLimiter');
const { actorRequest } = require('./support/groups');
const { createRandom, forAll } = require('./support/random');
const { roleMatrix, removalDecision, transferDecision } = require('../server/groups/policy');
const { AuthError } = require('../server/auth/errors');
const { DISABLED_FEATURES } = require('../server/features/config');
const service = require('../server/groups/service');

const { createGroupService, notFound, toAuthError, DEFAULT_RATE_LIMITS, AUDIT_EVENTS } = service;
const P41_RUNS = 50;
const P41_STEPS = 20;
const P41_SEED = 0x5c5341;
const P41_FEATURES = Object.freeze({ groupApi:true, groups:Object.freeze({ maxMembers:50,
    maxPendingInvitationsPerGroup:50, maxPendingInvitationsPerInvitee:50, directAdd:false }) });

const SENTINEL = 'SENTINEL-DB-TEXT-5c03';
const thrown = work => {
    try { work(); } catch (error) { return error; }
    return assert.fail('expected a throw');
};
const signature = error => JSON.stringify({ name: error.name, code: error.code, status: error.status, fields: error.fields, message: error.message });
function assertAuth(error, code, status) {
    assert.ok(error instanceof AuthError, `an AuthError, got ${error && error.name}`);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.deepEqual(error.fields, []);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
}
// A real session and the CSRF proof bound to it, as the middleware and csrfProof produce them.
function actorContext(f, actor) {
    const token = actor.browser.cookies.get(f.config.sessionCookie);
    const row = f.application.auth.resolveToken(token).row;
    return Object.freeze({
        context: Object.freeze({ userId: row.user_id, sessionId: row.session_id }),
        proof: f.application.auth.csrfProof(token, null, actor.token)
    });
}
const laterThan = (...times) => new Date(Math.max(...times.filter(Boolean).map(time => Date.parse(time))) + 1000).toISOString();

// First P-03 boundary: a member cannot remove anyone. The role refusal must
// precede target lookup (DB5-R05.16 and design Operations and their refusal order).
// Keep this failing evidence if an existing service violates the canonical rule;
// do not derive the oracle from the service's observed response.
test('P-03 prerequisite: member removal refusal precedes target lookup (DB5-R05.16)', async t => {
    const seed = 0x5c032023;
    const random = createRandom(seed);
    t.diagnostic(`property=P-03 seed=${seed}`);
    const f = await httpGroupFixture(t, { features: { groupApi:true, groups: { maxMembers:10,
        directAdd:true, maxPendingInvitationsPerGroup:20, maxPendingInvitationsPerInvitee:20 } } });
    const permission = roleMatrix('member', 'removeMember');
    assert.equal(permission.refusal, 'role');
    const failures = [];
    const targets = [f.actors.owner.id, f.actors.admin.id, f.actors.member.id,
        f.actors.nonMember.id, f.actors.removedMember.id, 'unknown-target'];
    for (const target of random.shuffle(targets)) {
        const before = snapshot(f.db);
        const response = await actorRequest(f.actors.member, 'DELETE', `/api/groups/${f.groupId}/members/${target}`);
        assert.equal(snapshot(f.db).total, before.total, 'refusal changes no group or audit row');
        if (response.status !== 403 || response.body.code !== 'FORBIDDEN') {
            failures.push({ targetClass: target === 'unknown-target' ? 'unknown' :
                Object.keys(f.actors).find(key => f.actors[key].id === target), status:response.status, body:response.body });
        }
    }
    assert.deepEqual(failures, [], 'member removal must return 403 FORBIDDEN for every target class');
});

test('P-41: seeded 50x20 API sequences preserve creation-time History_Policy through every operation',
    { timeout:300000 }, async t => {
        const random = createRandom(P41_SEED);
        const invalidPolicies = [null, 'ALL', 'From_Joined', '', 7, {}, []];
        const patchValues = ['all','from_joined','stored','other',null,7];
        const patchActors = ['owner','admin','member','nonMember'];
        const fixtureFeatures = P41_FEATURES;
        const fixtureClockStart = '2031-01-01T00:00:00.000Z';
        const template = await httpGroupFixture(t,{clock:createClock(fixtureClockStart),features:fixtureFeatures,createGroup:false});
        await template.application.close();
        template.db.pragma('wal_checkpoint(TRUNCATE)');
        template.db.close();
        const operationNames = ['invite-admin','accept-admin','invite-member','accept-member','patch-owner',
            'sql-policy-update','invite-outsider','patch-admin','cancel','reinvite-outsider','decline-outsider',
            'clock-advance','role-change','patch-member','transfer','sql-policy-update','remove','leave','archive','patch-archived-owner'];
        const operationCoverage = new Set();
        const valueCoverage = new Set();
        const actorCoverage = new Set();
        const groupCounts = new Set();

        for (let run = 0; run < P41_RUNS; run += 1) {
            const clock = createClock(fixtureClockStart);
            const f = await httpGroupFixture(t, { clock, features:fixtureFeatures, createGroup:false,
                databaseTemplate:template.filename,actorTemplate:template.actors });
            const policy = random.pick([undefined,'all','from_joined']);
            const key = `p41-create-${run}`;
            const createBody = { name:`P41 group ${run}`, description:'fixed policy property', idempotencyKey:key };
            if (policy !== undefined) createBody.historyPolicy = policy;
            const create = await actorRequest(f.actors.owner, 'POST', '/api/groups', { body:createBody });
            assert.equal(create.status, 201, `seed=${P41_SEED} run=${run} group create`);
            const id = create.body.group.id;
            const fixedPolicy = policy ?? 'from_joined';
            const fixedPolicies = new Map([[id,fixedPolicy]]);
            assert.equal(create.body.group.historyPolicy, fixedPolicy);
            const extensionPolicy = () => f.db.prepare('SELECT history_policy FROM GroupExtensions WHERE conversation_id=?').get(id).history_policy;
            const groupIds = [id];
            if (run % 2 === 1) {
                const otherPolicy = fixedPolicy === 'all' ? 'from_joined' : 'all';
                const second = await actorRequest(f.actors.owner, 'POST', '/api/groups', { body:{
                    name:`P41 secondary ${run}`, description:'second generated group', historyPolicy:otherPolicy,
                    idempotencyKey:`p41-secondary-${run}`
                } });
                assert.equal(second.status, 201);
                groupIds.push(second.body.group.id);
                fixedPolicies.set(second.body.group.id,otherPolicy);
                assert.equal(second.body.group.historyPolicy, otherPolicy);
            }
            groupCounts.add(groupIds.length);
            // A same-key create must fingerprint the policy: different policy conflicts; the identical request replays.
            const alternate = { ...createBody, historyPolicy:fixedPolicy === 'all' ? 'from_joined' : 'all' };
            const conflict = await actorRequest(f.actors.owner, 'POST', '/api/groups', { body:alternate });
            assert.deepEqual([conflict.status, conflict.body.code], [409, 'IDEMPOTENCY_CONFLICT'], `seed=${P41_SEED} run=${run} policy fingerprint`);
            const replay = await actorRequest(f.actors.owner, 'POST', '/api/groups', { body:createBody });
            assert.equal(replay.status, 200, `seed=${P41_SEED} run=${run} same-key replay`);
            assert.equal(replay.body.group.id, id);

            const invalid = invalidPolicies[run % invalidPolicies.length];
            const invalidBefore = snapshot(f.db);
            const invalidResponse = await actorRequest(f.actors.owner, 'POST', '/api/groups', { body:{
                name:`P41 invalid ${run}`, idempotencyKey:`p41-invalid-${run}`, historyPolicy:invalid
            } });
            assert.equal(invalidResponse.status, 400);
            assert.equal(invalidResponse.body.code, 'VALIDATION_ERROR');
            assert.ok(invalidResponse.body.fields.includes('historyPolicy'));
            assert.deepEqual(snapshot(f.db), invalidBefore, `seed=${P41_SEED} run=${run} invalid creation creates no group`);

            const inviter = f.actors.owner;
            let currentOwner = inviter;
            const activeUsers = new Set([inviter.id]);
            let pendingId = null;
            let archived = false;
            const stored = groupId => f.db.prepare('SELECT history_policy FROM GroupExtensions WHERE conversation_id=?').get(groupId).history_policy;
            const assertPolicies = async operation => {
                for (const groupId of groupIds) {
                    const expected = fixedPolicies.get(groupId);
                    assert.equal(stored(groupId), expected, `seed=${P41_SEED} run=${run} ${operation} SQL policy`);
                    const reader = groupId === id ? currentOwner : inviter;
                    const projection = await actorRequest(reader, 'GET', `/api/groups/${groupId}`);
                    assert.equal(projection.status, 200, `seed=${P41_SEED} run=${run} ${operation} G03 visibility`);
                    assert.equal(projection.body.group.historyPolicy, expected, `seed=${P41_SEED} run=${run} ${operation} G03 policy`);
                }
            };
            const patchPolicy = async (position, actorName, value, selectedActor = f.actors[actorName]) => {
                const actor = selectedActor;
                const shown = value === 'stored' ? fixedPolicy : value;
                const body = { historyPolicy:shown };
                if ((run + position) % 2) body.name = `P41 attempted rename ${run}-${position}`;
                const before = snapshot(f.db);
                const response = await actorRequest(actor, 'PATCH', `/api/groups/${id}`, { body });
                let expected;
                if (archived && actor === currentOwner) expected = [409,'CONFLICT'];
                else if (actor === currentOwner) expected = [400,'VALIDATION_ERROR'];
                else if (activeUsers.has(actor.id)) expected = [403,'FORBIDDEN'];
                else expected = [404,'NOT_FOUND'];
                assert.deepEqual([response.status,response.body.code], expected, `seed=${P41_SEED} run=${run} step=${position} actor=${actorName}`);
                if (response.status === 400) assert.ok(response.body.fields.includes('historyPolicy'));
                assert.deepEqual(snapshot(f.db), before, `seed=${P41_SEED} run=${run} step=${position} refused PATCH is atomic`);
                actorCoverage.add(actorName === 'currentOwner' ? 'owner' : actorName);
                valueCoverage.add(shown === fixedPolicy ? 'stored' : String(shown));
                await assertPolicies(`PATCH-${position}`);
            };

            const revisionNow = () => f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(id).membership_revision;
            const inviteUser = async user => {
                const response = await actorRequest(currentOwner, 'POST', `/api/groups/${id}/invitations`, { body:{ userId:user.id } });
                return response;
            };
            for (let step = 0; step < P41_STEPS; step += 1) {
                const operation = operationNames[step];
                operationCoverage.add(operation);
                if (operation === 'invite-admin') {
                    const response = await inviteUser(f.actors.admin); assert.equal(response.status,201); pendingId=response.body.invitation.id;
                } else if (operation === 'accept-admin') {
                    assert.equal((await actorRequest(f.actors.admin,'POST',`/api/groups/invitations/${pendingId}/accept`)).status,200);
                    activeUsers.add(f.actors.admin.id);
                } else if (operation === 'invite-member') {
                    const response = await inviteUser(f.actors.member); assert.equal(response.status,201); pendingId=response.body.invitation.id;
                } else if (operation === 'accept-member') {
                    assert.equal((await actorRequest(f.actors.member,'POST',`/api/groups/invitations/${pendingId}/accept`)).status,200);
                    activeUsers.add(f.actors.member.id);
                } else if (operation === 'patch-owner') {
                    const value = patchValues[random.int(0,patchValues.length-1)]; await patchPolicy(step,'owner',value);
                } else if (operation === 'sql-policy-update') {
                    const before = stored(id); const proposed = before === 'all' ? 'from_joined' : 'all';
                    assert.throws(() => f.db.prepare('UPDATE GroupExtensions SET history_policy=? WHERE conversation_id=?').run(proposed,id));
                    assert.equal(stored(id),before,`seed=${P41_SEED} run=${run} direct policy UPDATE is rejected`);
                } else if (operation === 'invite-outsider' || operation === 'reinvite-outsider') {
                    const response = await inviteUser(f.actors.nonMember); assert.equal(response.status,201); pendingId=response.body.invitation.id;
                    assert.equal((await actorRequest(currentOwner,'GET',`/api/groups/${id}/invitations`)).status,200);
                } else if (operation === 'patch-admin') {
                    const actorName = patchActors[run % patchActors.length]; await patchPolicy(step,actorName,patchValues[random.int(0,patchValues.length-1)]);
                } else if (operation === 'cancel') {
                    assert.ok(pendingId); assert.equal((await actorRequest(currentOwner,'DELETE',`/api/groups/${id}/invitations/${pendingId}`)).status,204);
                } else if (operation === 'decline-outsider') {
                    const response = await actorRequest(f.actors.nonMember,'POST',`/api/groups/invitations/${pendingId}/decline`);
                    assert.equal(response.status,204);
                } else if (operation === 'clock-advance') clock.advance(1000);
                else if (operation === 'role-change') {
                    assert.equal((await actorRequest(currentOwner,'PATCH',`/api/groups/${id}/members/${f.actors.admin.id}`, {
                        body:{ role:'admin', membershipRevision:revisionNow() }
                    })).status,200);
                } else if (operation === 'patch-member') {
                    const actorName = patchActors[(run + 1) % patchActors.length]; await patchPolicy(step,actorName,patchValues[random.int(0,patchValues.length-1)]);
                } else if (operation === 'transfer') {
                    assert.equal((await actorRequest(currentOwner,'POST',`/api/groups/${id}/transfer`, {
                        body:{ userId:f.actors.member.id, membershipRevision:revisionNow() }
                    })).status,200);
                    currentOwner=f.actors.member;
                } else if (operation === 'remove') {
                    assert.equal((await actorRequest(currentOwner,'DELETE',`/api/groups/${id}/members/${f.actors.admin.id}`)).status,204);
                    activeUsers.delete(f.actors.admin.id);
                } else if (operation === 'leave') {
                    assert.equal((await actorRequest(inviter,'POST',`/api/groups/${id}/leave`)).status,204);
                    activeUsers.delete(inviter.id);
                } else if (operation === 'archive') {
                    assert.equal((await actorRequest(currentOwner,'POST',`/api/groups/${id}/archive`)).status,200); archived=true;
                } else if (operation === 'patch-archived-owner') {
                    await patchPolicy(step,'currentOwner',patchValues[random.int(0,patchValues.length-1)],currentOwner);
                }
                await assertPolicies(operation);
            }
            t.diagnostic(`P-41 seed=${P41_SEED} run=${run} operations=${P41_STEPS} groups=${groupIds.length} policy=${fixedPolicy}`);
            await f.application.close();
            for (const connection of f.connections) if(connection.open) connection.close();
        }
        assert.equal(operationCoverage.size, new Set(operationNames).size);
        assert.deepEqual([...groupCounts].sort(), [1,2]);
        assert.deepEqual([...actorCoverage].sort(), ['admin','member','nonMember','owner'].sort());
        assert.ok(valueCoverage.has('stored') && valueCoverage.has('all') && valueCoverage.has('from_joined'));
        t.diagnostic(`P-41 seed=${P41_SEED} sequences=${P41_RUNS} operations=${P41_RUNS*P41_STEPS} categories=${operationCoverage.size} group-counts=${[...groupCounts].join(',')}`);
    });

const P03_RUNS = 300;
const P03_SEED = 0x5c032022;
test('P-03: generated group role/state operations agree with the pure policy model', {timeout:180000}, async t => {
    const f=await httpGroupFixture(t);
    const base=createRepositories(f.db), repository=createGroupRepository(f.db);
    const pool=[f.actors.owner,f.actors.admin,f.actors.member];
    for(let i=0;i<5;i++) {
        const browser=f.browser(),name=`p03-extra-${i}`;
        assert.equal((await browser.register(name)).status,201);
        const login=await browser.login(name);assert.equal(login.status,200);
        pool.push({id:login.body.user.id,browser,token:await browser.csrf()});
    }
    const operations=['remove','leave','role','transfer','archive','update','invite','cancel','add','former'];
    const classes=['owner','admin','member','former','nonMember','pendingInvitee'];
    const coverage={operations:new Set(),actors:new Set(),targets:new Set(),sizes:new Set(),blocks:new Set(),maxima:new Set(),archive:new Set(),spoofs:new Set(),success:new Set(),refused:new Set()};
    const rows=id=>f.db.prepare('SELECT * FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id').all(id);
    // This is the specification's policy oracle, deliberately independent of service
    // validators and SQL. Policy literals themselves are pinned in groups-policy.
    function expected(c) {
        if(c.operation==='add'&&!c.directAdd)return [503,'FEATURE_UNAVAILABLE'];
        const action={remove:'removeMember',leave:'leave',role:'changeRole',transfer:'transferOwnership',archive:'archive',update:'updateMetadata',invite:'invite',cancel:'cancelInvitation',add:'addMember',former:'read'}[c.operation];
        const permission=roleMatrix(c.actorRole,action,{archived:c.archived});
        if(permission.refusal==='notMember')return [404,'NOT_FOUND'];
        if(c.operation==='leave'&&c.actorRole==='owner')return [409,'CONFLICT'];
        if(permission.refusal==='role')return [403,'FORBIDDEN'];
        if(c.operation==='former'&&c.actorRole==='member')return [403,'FORBIDDEN'];
        if(permission.refusal==='archived')return [409,'CONFLICT'];
        if(c.spoof&&['role','transfer','update','invite','add'].includes(c.operation))return [400,'VALIDATION_ERROR'];
        if(c.operation==='remove') {
            if(!c.targetRole)return [404,'NOT_FOUND'];
            const decision=removalDecision(c.actorRole,c.targetRole);
            if(decision!=='allow')return decision==='forbidden'?[403,'FORBIDDEN']:[409,'CONFLICT'];
        }
        if(c.operation==='role') {
            if(!c.targetRole)return [404,'NOT_FOUND'];
            if(c.stale)return [409,'STALE_STATE'];
            if(c.targetRole==='owner'||c.targetRole===c.newRole)return [409,'CONFLICT'];
        }
        if(c.operation==='transfer') {
            const decision=transferDecision({actorId:c.actor.id,actorRole:c.actorRole,targetId:c.target.id,
                targetRole:c.targetRole,archived:c.archived,revision:c.revision,precondition:c.stale?c.revision+1:c.revision});
            const refusals={notFound:[404,'NOT_FOUND'],forbidden:[403,'FORBIDDEN'],conflict:[409,'CONFLICT'],invalid:[400,'VALIDATION_ERROR'],stale:[409,'STALE_STATE']};
            if(refusals[decision.decision])return refusals[decision.decision];
        }
        if(c.operation==='update'&&c.stale)return [409,'STALE_STATE'];
        if(['add','invite'].includes(c.operation)) {
            if(c.blocked)return [404,'NOT_FOUND'];
            if(c.targetRole)return [409,'CONFLICT'];
            if(c.operation==='add'&&c.size>=c.maximum)return [409,'CONFLICT'];
            if(c.operation==='invite'&&c.targetClass==='pendingInvitee')return [409,'CONFLICT'];
        }
        return [{remove:204,leave:204,role:200,transfer:200,archive:200,update:200,invite:201,cancel:204,add:201,former:200}[c.operation],null];
    }
    const describe=c=>JSON.stringify(Object.fromEntries(Object.entries(c).filter(([,value])=>value===null||['string','number','boolean'].includes(typeof value))));
    await forAll('P-03',{runs:P03_RUNS,seed:P03_SEED,onRun:line=>t.diagnostic(line),describe},(r,info)=>{
        const c={
        operation:r.pick(info.run%10===0?['role','transfer','update','invite','add']:operations),actorClass:r.pick(classes),targetClass:r.pick(classes),size:r.int(2,8),
        maximum:r.int(2,10),blockCount:r.int(0,3),archived:r.bool(),newRole:r.pick(['admin','member']),
        stale:r.bool(),directAdd:r.bool(0.8),roles:Array.from({length:7},()=>r.pick(['admin','member']))
        };
        c.validDraw=r.bool();
        if(c.validDraw) {
            c.actorClass='owner';c.archived=false;c.stale=false;c.directAdd=true;c.blockCount=0;
            c.targetClass=['add','invite'].includes(c.operation)?r.pick(['former','nonMember']):r.pick(['admin','member']);
            if(c.operation==='leave')c.actorClass=r.pick(['admin','member']);
            c.maximum=r.int(c.size+1,10);
        }
        const needed=[...new Set([c.actorClass,c.targetClass].filter(role=>['admin','member'].includes(role)))];
        c.size=Math.max(c.size,needed.length+1);
        needed.forEach((role,i)=>{c.roles[i]=role;});
        if(c.validDraw&&c.operation==='role')c.newRole=c.targetClass==='member'?'admin':'member';
        return c;
    },async(c,info)=>{
        // All rows belong exclusively to this test's guarded temporary fixture.
        // Reset synthetic block edges so every generated case has exactly 0..3.
        f.db.prepare('DELETE FROM Blocks').run();
        const id=f.builder.createGroup({ownerId:pool[0].id,idempotencyKey:`p03-${info.run}`});
        for(let i=1;i<c.size;i++)f.builder.addMember(id,pool[i].id,{role:c.roles[i-1]});
        f.builder.addMember(id,f.actors.removedMember.id);f.builder.removeMember(id,f.actors.removedMember.id);
        const invitation=f.builder.invite(id,pool[0].id,f.actors.pendingInvitee.id);
        f.clock.advance(2000);
        if(c.archived)base.conversations.archive(id,f.clock.iso());
        const active=rows(id).filter(row=>row.left_at===null);
        const resolve=kind=>kind==='owner'?pool[0]:kind==='former'?f.actors.removedMember:
            kind==='nonMember'?f.actors.nonMember:kind==='pendingInvitee'?f.actors.pendingInvitee:
            pool.find(user=>active.some(row=>row.user_id===user.id&&row.role===kind));
        c.actor=resolve(c.actorClass);c.target=resolve(c.targetClass);
        c.actorRole=active.find(row=>row.user_id===c.actor.id)?.role||null;
        c.targetRole=active.find(row=>row.user_id===c.target.id)?.role||null;
        const edges=[];
        if(c.blockCount&&c.actor.id!==c.target.id)edges.push([c.actor.id,c.target.id]);
        for(const a of [...pool,f.actors.nonMember])for(const b of pool)if(edges.length<c.blockCount&&a.id!==b.id&&!edges.some(([x,y])=>x===a.id&&y===b.id))edges.push([a.id,b.id]);
        for(const[a,b]of edges)f.db.prepare("INSERT INTO Blocks(blocker_id,blocked_id,origin,created_at) VALUES(?,?,'authenticated',?)").run(a,b,f.clock.iso());
        c.blocked=edges.some(([a,b])=>(a===c.actor.id&&b===c.target.id)||(b===c.actor.id&&a===c.target.id));
        c.revision=f.db.prepare('SELECT membership_revision AS n FROM GroupExtensions WHERE conversation_id=?').get(id).n;
        c.spoof=info.run%10===0?['actorId','ownerId','createdBy'][Math.floor(info.run/10)%3]:null;
        const features={groupApi:true,groups:{directAdd:c.directAdd,maxMembers:c.maximum,maxPendingInvitationsPerGroup:1000,maxPendingInvitationsPerInvitee:1000}};
        const svc=createGroupService({db:f.db,auth:f.application.auth,limiter:openLimiter(),now:f.clock.now,features});
        const who=actorContext(f,c.actor),body={};
        if(c.spoof)body[c.spoof]=pool[0].id;
        const rev=c.stale?c.revision+1:c.revision;
        const beforeRows=rows(id),before=snapshot(f.db),at=f.clock.iso();
        const expectedRows=beforeRows.map(row=>({...row}));
        const answer=expected(c);
        let status,code=null;
        try {
            const args=[who.context,who.proof,id];
            switch(c.operation) {
            case 'remove':svc.removeMember(...args,c.target.id);break;
            case 'leave':svc.leaveGroup(...args);break;
            case 'role':svc.changeMemberRole(...args,c.target.id,{role:c.newRole,membershipRevision:rev,...body});break;
            case 'transfer':svc.transferOwnership(...args,{userId:c.target.id,membershipRevision:rev,...body});break;
            case 'archive':svc.archiveGroup(...args);break;
            case 'update':svc.updateGroup(...args,{name:`model-${info.run}`,membershipRevision:rev,...body});break;
            case 'invite':svc.createInvitation(...args,{userId:c.target.id,...body},'127.0.0.1');break;
            case 'cancel':svc.cancelInvitation(...args,invitation);break;
            case 'add':svc.addMember(...args,{userId:c.target.id,...body});break;
            case 'former':svc.listMembers(who.context,id,{former:'true'});break;
            }
            status={remove:204,leave:204,invite:201,cancel:204,add:201}[c.operation]||200;
        } catch(error) { if(!(error instanceof AuthError))throw error;status=error.status;code=error.code; }
        assert.deepEqual([status,code],answer,describe(c));
        if(status>=400) {
            assert.equal(snapshot(f.db).total,before.total,'refused operation changes no row');coverage.refused.add(c.operation);
        } else {
            const find=user=>expectedRows.find(row=>row.user_id===user.id);
            if(c.operation==='remove')find(c.target).left_at=at;
            if(c.operation==='leave')find(c.actor).left_at=at;
            if(c.operation==='role')find(c.target).role=c.newRole;
            if(c.operation==='transfer'){find(c.actor).role='admin';find(c.target).role='owner';}
            if(c.operation==='add') {
                const old=find(c.target);
                if(old){old.role='member';old.left_at=null;}
                else expectedRows.push({conversation_id:id,user_id:c.target.id,role:'member',joined_at:at,left_at:null});
            }
            assert.deepEqual(rows(id),expectedRows.sort((a,b)=>a.user_id<b.user_id?-1:a.user_id>b.user_id?1:0),'exact membership transition');
            const audits=f.db.prepare("SELECT actor_user_id FROM AuditLogs WHERE subject_id=? AND source='groups'").all(id);
            assert.ok(audits.every(row=>row.actor_user_id===c.actor.id),'audit actor is always the session user');
            coverage.success.add(c.operation);
        }
        const report=repository.invariantReport(id);
        assert.equal(report.activeOwners,1);assert.equal(report.mismatches,0);assert.equal(report.activeMembers,report.openIntervals);
        assert.deepEqual(f.db.pragma('foreign_key_check'),[]);
        for(const[key,value]of Object.entries({operations:c.operation,actors:c.actorClass,targets:c.targetClass,sizes:c.size,blocks:c.blockCount,maxima:c.maximum,archive:c.archived}))coverage[key].add(value);
        if(c.spoof)coverage.spoofs.add(c.spoof);
    });
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(coverage).map(([key,value])=>[key,[...value]]))));
    if(process.env.PROPERTY_RUN===undefined) {
        assert.equal(coverage.operations.size,10);assert.equal(coverage.actors.size,6);assert.equal(coverage.targets.size,6);
        assert.equal(coverage.sizes.size,7);assert.equal(coverage.blocks.size,4);assert.equal(coverage.maxima.size,9);
        assert.equal(coverage.archive.size,2);assert.equal(coverage.spoofs.size,3);
        assert.equal(coverage.success.size,10,'every generated operation has successful transition evidence');
        assert.equal(coverage.refused.size,10,'every generated operation has refusal evidence');
    }
});

// P-20 request-chain oracle: literal order from design Request-level failures
// and DB5-R12. This intentionally imports no router/validator decision logic.
const P20_REQUEST_ORDER = Object.freeze([
    ['origin',403,'FORBIDDEN'],['session',401,'UNAUTHENTICATED'],['csrf',403,'CSRF_INVALID'],
    ['gate',503,'FEATURE_UNAVAILABLE'],['rate',429,'RATE_LIMITED'],
    ['oversized',413,'PAYLOAD_TOO_LARGE'],['nonJson',400,'VALIDATION_ERROR'],
    ['charset',415,'UNSUPPORTED_MEDIA_TYPE'],['malformed',400,'VALIDATION_ERROR'],
    ['empty',400,'VALIDATION_ERROR'],['unknownField',400,'VALIDATION_ERROR']
]);
test('P-20: generated overlapping request-chain refusals follow the canonical ordered oracle', {timeout:120000}, async t => {
    let limited=false;
    const limiter={consume:()=>({allowed:!limited,retryAfter:1})};
    // AF-12: the standalone module hook is configured but must not bypass the
    // real Origin, session, or CSRF chain on the canonical application.
    const env={AUTH_MIDDLEWARE_MODULE:'./synthetic-untrusted-auth-hook.cjs'};
    const on=await httpGroupFixture(t,{env,limiter,features:{groupApi:true,groups:{directAdd:true,maxMembers:10,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    const off=await httpGroupFixture(t,{env,limiter,features:{groupApi:false}});
    const operations=['create','patch','add','role','transfer'];
    const requestCoverage={sizes:new Set(),operations:new Set(),first:new Set()};
    await forAll('P-20-request',{runs:200,seed:0x5c202023,onRun:line=>t.diagnostic(line)},(r,info)=>{
        // One body representation is drawn, with independent header/identity
        // faults. This avoids contradictory inputs such as both absent and huge.
        const bodyFault=r.pick(['oversized','nonJson','malformed','empty','unknownField']);
        const faults=r.shuffle(['origin','session','csrf','gate','rate','charset',bodyFault]).slice(0,r.int(1,5));
        // Exercise adjacent parser checks without an earlier fault masking them.
        // Remaining runs retain the full generated 1..5-condition distribution.
        if(info.run===0)return {operation:r.pick(operations),faults:r.shuffle(['malformed','charset'])};
        if(info.run<=P20_REQUEST_ORDER.length)return {operation:r.pick(operations),faults:[P20_REQUEST_ORDER[info.run-1][0]]};
        return {operation:r.pick(operations),faults};
    },async c=>{
        const has=name=>c.faults.includes(name),f=has('gate')?off:on;
        const actor=has('session')?f.actors.unauthenticated:f.actors.owner;
        const paths={create:'/api/groups',patch:`/api/groups/${f.groupId}`,add:`/api/groups/${f.groupId}/members`,
            role:`/api/groups/${f.groupId}/members/${f.actors.member.id}`,transfer:`/api/groups/${f.groupId}/transfer`};
        const bodies={create:{name:'P20 synthetic'},patch:{name:'P20 changed'},add:{userId:f.actors.nonMember.id},
            role:{role:'admin'},transfer:{userId:f.actors.member.id}};
        let body=JSON.stringify({...bodies[c.operation],...(has('unknownField')?{spoofedActor:'untrusted'}:{})});
        if(has('empty'))body='';
        if(has('malformed'))body='{';
        if(has('oversized'))body='{'+ ' '.repeat(9000);
        const headers={'Content-Type':`${has('nonJson')?'text/plain':'application/json'}${has('charset')?'; charset=utf-7':''}`};
        if(has('origin'))headers.Origin='https://untrusted.example';
        const before=snapshot(f.db);
        limited=has('rate');
        let response;
        try { response=await actorRequest(actor,['patch','role'].includes(c.operation)?'PATCH':'POST',paths[c.operation],
            {rawBody:body,headers,csrf:!has('csrf')}); }
        finally { limited=false; }
        // The canonical table explicitly limits charset checks to a present body.
        const expected=P20_REQUEST_ORDER.find(([name])=>has(name)&&!(name==='charset'&&has('empty')));
        assert.equal(snapshot(f.db).total,before.total,'request refusal changes no group, membership or audit row');
        assert.deepEqual([response.status,response.body.code],expected.slice(1),JSON.stringify(c));
        requestCoverage.sizes.add(c.faults.length);requestCoverage.operations.add(c.operation);requestCoverage.first.add(expected[0]);
    });
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(requestCoverage).map(([key,value])=>[key,[...value]]))));
    if(process.env.PROPERTY_RUN===undefined){assert.equal(requestCoverage.sizes.size,5);assert.equal(requestCoverage.operations.size,5);assert.equal(requestCoverage.first.size,P20_REQUEST_ORDER.length);}
});

// T-5C-23: literal operation-level refusal lists transcribed from DB5-R02.15,
// R03.17 and R06.17 (archive guards from R07). No production decision helper.
const P20_OPERATION_ORDER = Object.freeze({
    patch:[['invisible',404,'NOT_FOUND'],['role',403,'FORBIDDEN'],['archived',409,'CONFLICT'],
        ['body',400,'VALIDATION_ERROR'],['historyPolicy',400,'VALIDATION_ERROR'],['stale',409,'STALE_STATE']],
    add:[['disabled',503,'FEATURE_UNAVAILABLE'],['invisible',404,'NOT_FOUND'],['role',403,'FORBIDDEN'],
        ['archived',409,'CONFLICT'],['body',400,'VALIDATION_ERROR'],['target',404,'NOT_FOUND'],
        ['blocked',404,'NOT_FOUND'],['active',409,'CONFLICT'],['capacity',409,'CONFLICT']],
    role:[['invisible',404,'NOT_FOUND'],['role',403,'FORBIDDEN'],['archived',409,'CONFLICT'],
        ['body',400,'VALIDATION_ERROR'],['target',404,'NOT_FOUND'],['stale',409,'STALE_STATE'],['ownerTarget',409,'CONFLICT'],['sameRole',409,'CONFLICT']],
    transfer:[['invisible',404,'NOT_FOUND'],['role',403,'FORBIDDEN'],['archived',409,'CONFLICT'],
        ['body',400,'VALIDATION_ERROR'],['target',400,'VALIDATION_ERROR'],['self',400,'VALIDATION_ERROR'],['stale',409,'STALE_STATE']]
});
test('P-20: generated operation refusals preserve visibility, role, archive, body and revision precedence', {timeout:120000},async t=>{
    const make=directAdd=>httpGroupFixture(t,{features:{groupApi:true,groups:{directAdd,maxMembers:4,
        maxPendingInvitationsPerGroup:1000,maxPendingInvitationsPerInvitee:1000}}});
    const enabled=await make(true),disabled=await make(false);
    const coverage={operations:new Set(),sizes:new Set(),first:new Set(),actors:new Set(),targets:new Set()};
    const singletons=Object.entries(P20_OPERATION_ORDER).flatMap(([operation,rows])=>rows.map(([fault])=>({operation,fault})));
    await forAll('P-20-operations',{runs:400,seed:0x5c202024,onRun:line=>t.diagnostic(line)},(r,info)=>{
        const pinned=singletons[info.run];
        const operation=pinned?pinned.operation:r.pick(Object.keys(P20_OPERATION_ORDER));
        const names=P20_OPERATION_ORDER[operation].map(([name])=>name);
        // A target cannot simultaneously be missing, blocked, and already active
        // in one fixture. Draw one target condition; other checks remain combinable.
        const targetFaults=['target','blocked','active','sameRole','ownerTarget','self'];
        const target=r.pick(names.filter(name=>targetFaults.includes(name)).concat(['none']));
        const candidates=names.filter(name=>!targetFaults.includes(name));
        if(target!=='none')candidates.push(target);
        return {operation,faults:pinned?[pinned.fault]:r.shuffle(candidates).slice(0,r.int(1,Math.min(5,candidates.length))),
            actorClass:r.pick(['admin','member']),hiddenClass:r.pick(['nonMember','pendingInvitee','removedMember']),targetClass:operation==='add'?'unknown':r.pick(['unknown','former']),policy:r.pick(['all','from_joined'])};
    },async(c,info)=>{
        const has=name=>c.faults.includes(name),f=has('disabled')?disabled:enabled;
        f.db.prepare('DELETE FROM Blocks').run(); // synthetic fixture only
        const id=f.builder.createGroup({ownerId:f.actors.owner.id,idempotencyKey:`p20-${info.run}`});
        f.builder.addMember(id,f.actors.admin.id,{role:'admin'});f.builder.addMember(id,f.actors.member.id);
        f.builder.addMember(id,f.actors.removedMember.id);f.builder.removeMember(id,f.actors.removedMember.id);
        f.clock.advance(2000);
        if(has('capacity')) {
            const filler=f.repositories.users.create({user_id:`p20-capacity-${info.run}`,username:`p20-capacity-${info.run}`,display_name:'P20 synthetic capacity'});
            f.builder.addMember(id,filler.user_id);
        }
        if(has('archived'))f.repositories.conversations.archive(id,f.clock.iso());
        // For add, both manager roles are allowed; a member is the refusing role.
        const actor=has('invisible')?f.actors[c.hiddenClass]:has('role')?f.actors[c.operation==='add'?'member':c.actorClass]:f.actors.owner;
        const target=has('self')?actor.id:has('ownerTarget')?f.actors.owner.id:has('blocked')?(actor.id===f.actors.removedMember.id?f.actors.nonMember.id:f.actors.removedMember.id):has('target')?(c.targetClass==='former'?f.actors.removedMember.id:'unknown-target'):
            has('active')||has('sameRole')||['role','transfer'].includes(c.operation)?f.actors.member.id:f.actors.nonMember.id;
        if(has('blocked'))f.db.prepare("INSERT INTO Blocks(blocker_id,blocked_id,origin,created_at) VALUES(?,?,'authenticated',?)").run(actor.id,target,f.clock.iso());
        const revision=f.db.prepare('SELECT membership_revision AS n FROM GroupExtensions WHERE conversation_id=?').get(id).n;
        const body=c.operation==='patch'?{name:'P20 update',...(has('historyPolicy')?{historyPolicy:c.policy}:{})}:
            c.operation==='role'?{role:has('sameRole')?'member':'admin'}:{userId:target};
        if(has('stale'))body.membershipRevision=revision+1;
        if(c.operation==='add')delete body.membershipRevision;
        if(has('body')) {
            if(c.operation==='patch')body.name=42;
            else if(c.operation==='role')body.role='owner';
            else body.userId=42;
        }
        const path=`/api/groups/${id}`+({patch:'',add:'/members',role:`/members/${target}`,transfer:'/transfer'})[c.operation];
        const before=snapshot(f.db);
        const response=await actorRequest(actor,['patch','role'].includes(c.operation)?'PATCH':'POST',path,{body});
        const expected=P20_OPERATION_ORDER[c.operation].find(([name])=>has(name));
        assert.equal(snapshot(f.db).total,before.total,'refusal changes no database or audit row');
        assert.deepEqual([response.status,response.body.code],expected.slice(1),JSON.stringify(c));
        if(c.operation==='patch'&&expected[0]==='historyPolicy')assert.deepEqual(response.body.fields,['historyPolicy']);
        coverage.operations.add(c.operation);coverage.sizes.add(c.faults.length);coverage.first.add(`${c.operation}:${expected[0]}`);
        coverage.actors.add(has('invisible')?c.hiddenClass:has('role')?(c.operation==='add'?'member':c.actorClass):'owner');
        if(has('target'))coverage.targets.add(c.targetClass);
    });
    t.diagnostic(JSON.stringify(Object.fromEntries(Object.entries(coverage).map(([key,value])=>[key,[...value]]))));
    if(process.env.PROPERTY_RUN===undefined){assert.equal(coverage.operations.size,4);assert.equal(coverage.sizes.size,5);assert.equal(coverage.targets.size,2);assert.equal(coverage.actors.size,6);assert.equal(coverage.first.size,singletons.length);}
});

test('P-20: supported and unsupported charset with valid and malformed JSON',async t=>{
    const f=await httpGroupFixture(t,{features:{groupApi:true,groups:{maxMembers:10,
        maxPendingInvitationsPerGroup:50,maxPendingInvitationsPerInvitee:50}}});
    for(const charset of ['utf-8','utf-7'])for(const malformed of [false,true]) {
        const before=snapshot(f.db);
        // Invalid policy supplies a safe terminal 400 even when JSON syntax is valid.
        const response=await actorRequest(f.actors.owner,'PATCH',`/api/groups/${f.groupId}`,{
            rawBody:malformed?'{':JSON.stringify({historyPolicy:'all'}),headers:{'Content-Type':`application/json; charset=${charset}`}});
        assert.deepEqual([response.status,response.body.code],charset==='utf-7'?[415,'UNSUPPORTED_MEDIA_TYPE']:[400,'VALIDATION_ERROR']);
        assert.equal(snapshot(f.db).total,before.total);
    }
});

test('Group_Service infrastructure (T-5C-03)', async t => {
    const f = await httpGroupFixture(t);
    const auth = f.application.auth;
    const GROUP = f.groupId;
    const svc = createGroupService({ db: f.db, auth, limiter: f.limiter, now: f.clock.now });
    const groups = createGroupRepository(f.db);
    const base = createRepositories(f.db);
    const who = {};
    for (const name of ['owner', 'admin', 'member', 'nonMember', 'pendingInvitee', 'removedMember']) {
        who[name] = Object.freeze({ ...actorContext(f, f.actors[name]), id: f.actors[name].id });
    }
    const total = () => snapshot(f.db).total;
    const revisionOf = id => f.db.prepare('SELECT membership_revision AS n FROM GroupExtensions WHERE conversation_id = ?').get(id).n;
    const auditRows = id => f.db.prepare("SELECT * FROM AuditLogs WHERE source = 'groups' AND subject_id = ? ORDER BY rowid").all(id);

    await t.test('construction fails closed on a missing or malformed dependency', () => {
        const ok = { db: f.db, auth, limiter: f.limiter, now: f.clock.now };
        const bad = [undefined, null, {}, { ...ok, db: null }, { ...ok, db: {} }, { ...ok, auth: null },
            { ...ok, auth: { checkSession: auth.checkSession, now: auth.now } },
            { ...ok, auth: { repository: auth.repository, now: auth.now } },
            { ...ok, limiter: null }, { ...ok, limiter: {} }, { ...ok, now: 'now' }, { ...ok, now: null },
            { ...ok, rates: null }, { ...ok, rates: [] }, { ...ok, rates: 'fast' }, { ...ok, features: 'on' }, { ...ok, features: [] },
            { ...ok, features: { groups: 5 } }, { ...ok, features: { attachments: [] } }];
        for (const options of bad) assert.throws(() => createGroupService(options), TypeError);
        assert.ok(createGroupService({ db: f.db, auth, now: f.clock.now }), 'the limiter defaults to the SQLite limiter');
    });

    await t.test('the service offers the Task 2.3 infrastructure and exactly the operations implemented so far', () => {
        assert.deepEqual(Object.keys(svc).sort(),
            ['acceptInvitation', 'addMember', 'archiveGroup', 'assertGroupInvariants', 'audit', 'cancelInvitation', 'changeMemberRole', 'createGroup', 'createInvitation', 'declineInvitation',
                'features', 'getGroup', 'groupRead', 'groupWrite', 'leaveGroup', 'listGroups', 'listInvitations', 'listMembers', 'listOwnInvitations', 'rate', 'rates', 'removeMember',
                'requireRole', 'transferOwnership', 'updateGroup', 'visibleGroup']);
        assert.ok(Object.isFrozen(svc));
        assert.deepEqual(Object.keys(service).sort(), ['AUDIT_EVENTS', 'DEFAULT_RATE_LIMITS', 'createGroupService', 'notFound', 'toAuthError']);
        assert.deepEqual(svc.features, DISABLED_FEATURES);
        assert.equal(svc.rates, DEFAULT_RATE_LIMITS);
    });

    await t.test('features are a frozen copy: a later change to the source object reaches no service', () => {
        const source = { groupApi: true, groupMessaging: 'true', attachmentApi: false, groups: { maxMembers: 5, directAdd: false }, attachments: {} };
        const copy = createGroupService({ db: f.db, auth, limiter: f.limiter, now: f.clock.now, features: source });
        source.groups.maxMembers = 999;
        source.groups.directAdd = true;
        source.groupApi = false;
        assert.deepEqual(copy.features, { groupApi: true, groupMessaging: false, attachmentApi: false, groups: { maxMembers: 5, directAdd: false }, attachments: {} });
        assert.ok(Object.isFrozen(copy.features) && Object.isFrozen(copy.features.groups));
        assert.equal(Reflect.set(copy.features.groups, 'directAdd', true), false);
        assert.equal(copy.features.groups.directAdd, false);
        assert.deepEqual(createGroupService({ db: f.db, auth, limiter: f.limiter, now: f.clock.now }).features, DISABLED_FEATURES);
    });
    await t.test('groupRead runs the work for the verified actor in a deferred, read-only transaction', () => {
        const other = new Database(f.filename);
        other.pragma('busy_timeout = 0');
        try {
            const seen = svc.groupRead(who.member.context, (actor, stamp) => {
                other.exec('BEGIN IMMEDIATE');
                other.exec('ROLLBACK');
                return { actor, stamp, inTransaction: f.db.inTransaction, queryOnly: f.db.pragma('query_only', { simple: true }) };
            });
            assert.equal(seen.actor, who.member.id);
            assert.equal(seen.stamp, f.clock.iso());
            assert.equal(seen.inTransaction, true);
            assert.equal(seen.queryOnly, 1);
        } finally { other.close(); }
        assert.equal(f.db.inTransaction, false);
        assert.equal(f.db.pragma('query_only', { simple: true }), 0, 'query_only is restored');
        assert.equal(svc.groupRead(who.member.context, () => 'result'), 'result');
    });

    await t.test('groupRead refuses a missing, forged or foreign session before the work runs', () => {
        const wrong = [undefined, null, 'session', 7, [], {}, { userId: who.member.id }, { sessionId: who.member.context.sessionId },
            { sessionId: who.member.context.sessionId, userId: who.owner.id },
            { sessionId: who.owner.context.sessionId, userId: who.member.id },
            { sessionId: 'no-such-session', userId: who.member.id },
            { sessionId: who.member.context.sessionId, userId: 5 }, { sessionId: 5, userId: who.member.id },
            { sessionId: who.member.context.sessionId, userId: null }];
        let calls = 0;
        const before = total();
        for (const context of wrong) {
            assertAuth(thrown(() => svc.groupRead(context, () => { calls++; })), 'UNAUTHENTICATED', 401);
        }
        assert.equal(calls, 0);
        assert.equal(total(), before);
        assert.equal(f.db.inTransaction, false);
    });

    await t.test('the actor is the session user: extra claims in the context change nothing', () => {
        const claims = { ...who.member.context, role: 'owner', isOwner: true, groupId: GROUP, membership: { role: 'owner' }, actor: who.owner.id };
        assert.equal(svc.groupRead(claims, actor => actor), who.member.id);
        const error = thrown(() => svc.groupRead(claims, actor => {
            const { member } = svc.visibleGroup(actor, GROUP);
            svc.requireRole(member, ['owner']);
        }));
        assertAuth(error, 'FORBIDDEN', 403);
    });

    await t.test('session values are read once, so a context that changes between reads cannot act as another user', () => {
        let reads = 0;
        const shifting = { sessionId: who.member.context.sessionId };
        Object.defineProperty(shifting, 'userId', { enumerable: true, get() { reads++; return reads === 1 ? who.member.id : who.owner.id; } });
        const actor = svc.groupRead(shifting, id => id);
        assert.equal(actor, who.member.id);
        assert.equal(reads, 1);
    });

    await t.test('work must be synchronous, and a refusal opens no transaction', () => {
        let calls = 0;
        for (const work of [undefined, null, 'work', {}, async () => { calls++; }]) {
            assert.ok(thrown(() => svc.groupRead(who.member.context, work)) instanceof TypeError);
            assert.equal(f.db.inTransaction, false);
        }
        assert.equal(calls, 0);
        const promised = thrown(() => svc.groupRead(who.member.context, () => Promise.resolve(1)));
        assertAuth(promised, 'INTERNAL_ERROR', 500);
        assert.equal(f.db.inTransaction, false);
    });

    await t.test('a write attempted inside groupRead cannot commit, even when the caller catches the error', () => {
        const before = revisionOf(GROUP);
        const error = thrown(() => svc.groupRead(who.owner.context, () => groups.bumpRevision(GROUP)));
        assertAuth(error, 'SERVICE_UNAVAILABLE', 503);
        svc.groupRead(who.owner.context, () => {
            try { groups.bumpRevision(GROUP); } catch { /* swallowed */ }
            try { f.db.prepare('UPDATE GroupExtensions SET membership_revision = membership_revision + 1').run(); } catch { /* swallowed */ }
        });
        assert.equal(revisionOf(GROUP), before);
        assert.equal(f.db.pragma('query_only', { simple: true }), 0);
        assert.equal(groups.bumpRevision.kind, 'write');
    });

    await t.test('service transactions cannot be nested, and a refused nesting leaves the service usable', () => {
        const inner = [];
        const outcome = svc.groupRead(who.member.context, () => {
            for (const attempt of [() => svc.groupRead(who.member.context, () => 1),
                () => svc.groupWrite(who.member.context, who.member.proof, () => 1)]) {
                try { attempt(); } catch (error) { inner.push(error); }
            }
            return 'outer finished';
        });
        assert.equal(outcome, 'outer finished');
        assert.equal(inner.length, 2);
        for (const error of inner) assert.ok(error instanceof TypeError);
        assert.equal(svc.groupRead(who.member.context, actor => actor), who.member.id);
    });
    await t.test('groupWrite runs the work in an immediate transaction for the verified actor and commits it with its audit row', () => {
        const other = new Database(f.filename);
        other.pragma('busy_timeout = 0');
        const before = { revision: revisionOf(GROUP), audits: auditRows(GROUP).length };
        let lock;
        let result;
        try {
            result = svc.groupWrite(who.owner.context, who.owner.proof, (actor, stamp) => {
                lock = thrown(() => other.exec('BEGIN IMMEDIATE'));
                const { group, member } = svc.visibleGroup(actor, GROUP);
                svc.requireRole(member, ['owner']);
                const next = groups.bumpRevision(GROUP);
                svc.audit(actor, 'group.updated', GROUP);
                return { actor, stamp, next, title: group.title, inTransaction: f.db.inTransaction };
            });
        } finally { other.close(); }
        assert.match(String(lock.code), /SQLITE_BUSY/, 'the write lock is held for the whole work');
        assert.deepEqual(result, { actor: who.owner.id, stamp: f.clock.iso(), next: before.revision + 1, title: 'Fixture group', inTransaction: true });
        assert.equal(f.db.inTransaction, false);
        assert.equal(revisionOf(GROUP), before.revision + 1);
        const rows = auditRows(GROUP);
        assert.equal(rows.length, before.audits + 1);
        const row = rows.at(-1);
        assert.equal(row.event_type, 'group.updated');
        assert.equal(row.actor_user_id, who.owner.id);
        assert.equal(row.source, 'groups');
        assert.equal(row.subject_id, GROUP);
        assert.equal(row.metadata_json, '{"operation":"updated","outcome":"confirmed"}');
    });

    await t.test('groupWrite refuses a missing, foreign or stale CSRF proof with 403 before the work runs', () => {
        const mine = who.member.proof;
        const proofs = [undefined, null, 'proof', 7, [], {}, { type: 'preauth', hash: 'h', csrfHash: mine.csrfHash },
            { ...mine, type: 'preauth' }, { ...mine, type: undefined }, { ...mine, sessionId: who.owner.context.sessionId },
            { ...mine, sessionId: 'other' }, { ...mine, userId: who.owner.id }, { ...mine, userId: undefined },
            { ...mine, csrfHash: 'f'.repeat(64) }, { ...mine, csrfHash: undefined }, { ...mine, csrfHash: who.owner.proof.csrfHash },
            who.owner.proof, who.admin.proof];
        let calls = 0;
        const before = total();
        for (const proof of proofs) {
            assertAuth(thrown(() => svc.groupWrite(who.member.context, proof, () => { calls++; })), 'CSRF_INVALID', 403);
        }
        assert.equal(calls, 0);
        assert.equal(total(), before);
        assert.equal(f.db.inTransaction, false);
    });

    await t.test('a proof is read once, so one that changes between reads cannot pass', () => {
        let reads = 0;
        const shifting = { type: 'session', sessionId: who.member.context.sessionId, userId: who.member.id };
        Object.defineProperty(shifting, 'csrfHash', { enumerable: true, get() { reads++; return reads === 1 ? who.member.proof.csrfHash : 'f'.repeat(64); } });
        assert.equal(svc.groupWrite(who.member.context, shifting, actor => actor), who.member.id);
        assert.equal(reads, 1);
    });

    await t.test('groupWrite refuses a forged session before it looks at the proof', () => {
        const before = total();
        for (const context of [undefined, null, {}, { sessionId: who.member.context.sessionId, userId: who.owner.id }, { sessionId: 'nope', userId: who.member.id }]) {
            assertAuth(thrown(() => svc.groupWrite(context, who.member.proof, () => assert.fail('the work must not run'))), 'UNAUTHENTICATED', 401);
            assertAuth(thrown(() => svc.groupWrite(context, undefined, () => assert.fail('the work must not run'))), 'UNAUTHENTICATED', 401);
        }
        assert.equal(total(), before);
    });

    await t.test('a failure inside the work rolls everything back and leaves as an AuthError without database text', () => {
        const run = failure => {
            const before = total();
            const error = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, actor => {
                svc.visibleGroup(actor, GROUP);
                groups.bumpRevision(GROUP);
                svc.audit(actor, 'group.updated', GROUP);
                throw failure;
            }));
            assert.equal(total(), before, 'nothing of the work was committed');
            assert.equal(f.db.inTransaction, false);
            return error;
        };
        const own = new AuthError('CONFLICT', 409, ['name']);
        assert.equal(run(own), own, 'an AuthError passes through unchanged');
        const cases = [
            [new Error(`${SENTINEL} SQLITE_CONSTRAINT uq_invitations_pending GroupExtensions`), 'INTERNAL_ERROR', 500],
            [new TypeError(SENTINEL), 'INTERNAL_ERROR', 500],
            [new RepositoryError('DUPLICATE'), 'CONFLICT', 409], [new RepositoryError('CONFLICT'), 'CONFLICT', 409],
            [new RepositoryError('INVALID'), 'VALIDATION_ERROR', 400], [new RepositoryError('REFERENCE'), 'VALIDATION_ERROR', 400],
            [new RepositoryError('BUSY'), 'SERVICE_UNAVAILABLE', 503], [new RepositoryError('UNAVAILABLE'), 'SERVICE_UNAVAILABLE', 503],
            [new RepositoryError('DATABASE'), 'INTERNAL_ERROR', 500],
            [`thrown text ${SENTINEL}`, 'INTERNAL_ERROR', 500], [null, 'INTERNAL_ERROR', 500], [undefined, 'INTERNAL_ERROR', 500], [42, 'INTERNAL_ERROR', 500]
        ];
        for (const [failure, code, status] of cases) {
            const error = run(failure);
            assertAuth(error, code, status);
            assert.ok(!JSON.stringify(error).includes(SENTINEL) && !String(error.stack).includes(SENTINEL), 'no text of the cause');
        }
    });

    await t.test('a real driver error becomes its mapped class and never carries driver text', () => {
        const insert = (values, sql = 'INSERT INTO ConversationMembers(conversation_id, user_id, role) VALUES(?, ?, ?)') =>
            thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, () => { f.db.prepare(sql).run(...values); }));
        const duplicate = insert([GROUP, who.member.id, 'member']);
        assertAuth(duplicate, 'CONFLICT', 409);
        const missing = insert([GROUP, 'no-such-user', 'member']);
        assert.ok(missing instanceof AuthError && [400, 409].includes(missing.status));
        const bad = insert([GROUP, who.nonMember.id, 'boss']);
        assert.ok(bad instanceof AuthError && [400, 409].includes(bad.status));
        for (const error of [duplicate, missing, bad]) {
            assert.deepEqual(error.fields, []);
            assert.ok(!/sqlite|constraint|unique|ConversationMembers|PRIMARY/i.test(JSON.stringify(error) + error.message));
        }
        assert.equal(f.db.prepare('SELECT count(*) AS n FROM ConversationMembers WHERE conversation_id = ?').get(GROUP).n, 4);
    });

    await t.test('work must be synchronous, and an asynchronous one writes nothing', () => {
        let calls = 0;
        for (const work of [undefined, null, 'work', {}, async () => { calls++; }]) {
            assert.ok(thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, work)) instanceof TypeError);
            assert.equal(f.db.inTransaction, false);
        }
        assert.equal(calls, 0);
        const before = total();
        const promised = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, () => { groups.bumpRevision(GROUP); return Promise.resolve(1); }));
        assertAuth(promised, 'INTERNAL_ERROR', 500);
        assert.equal(total(), before);
    });

    await t.test('a busy database answers 503 and runs no work', () => {
        const holder = new Database(f.filename);
        holder.pragma('busy_timeout = 0');
        const previous = f.db.pragma('busy_timeout', { simple: true });
        let calls = 0;
        let error;
        holder.exec('BEGIN IMMEDIATE');
        f.db.pragma('busy_timeout = 0');
        try { error = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, () => { calls++; })); }
        finally { f.db.pragma(`busy_timeout = ${previous}`); holder.exec('ROLLBACK'); holder.close(); }
        assertAuth(error, 'SERVICE_UNAVAILABLE', 503);
        assert.equal(calls, 0);
        assert.equal(svc.groupWrite(who.owner.context, who.owner.proof, () => 'free again'), 'free again');
    });

    await t.test('a valid membership change commits, with its interval, under the commit-time check', () => {
        const removed = who.removedMember.id;
        const joined = base.members.get(GROUP, removed).joined_at;
        const start = new Date(Date.parse(joined) + 86400000).toISOString();
        const stop = new Date(Date.parse(start) + 3600000).toISOString();
        const open = () => f.db.prepare('SELECT count(*) AS n FROM GroupMembershipIntervals WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL').get(GROUP, removed).n;
        svc.groupWrite(who.owner.context, who.owner.proof, actor => {
            svc.visibleGroup(actor, GROUP);
            groups.reactivateMember(GROUP, removed, start);
            groups.openIntervalAt(GROUP, removed, start);
        });
        assert.equal(base.members.get(GROUP, removed).left_at, null);
        assert.equal(open(), 1);
        assert.deepEqual(groups.invariantReport(GROUP), { activeOwners: 1, activeMembers: 4, openIntervals: 4, mismatches: 0 });
        svc.groupWrite(who.owner.context, who.owner.proof, actor => {
            svc.visibleGroup(actor, GROUP);
            groups.endMembership(GROUP, removed, stop);
            groups.closeInterval(GROUP, removed, stop);
        });
        assert.notEqual(base.members.get(GROUP, removed).left_at, null);
        assert.equal(open(), 0);
        assert.deepEqual(groups.invariantReport(GROUP), { activeOwners: 1, activeMembers: 3, openIntervals: 3, mismatches: 0 });
    });

    await t.test('a change that breaks the owner or interval invariant is rolled back with a 500', () => {
        const at = new Date(Date.parse(base.members.get(GROUP, who.member.id).joined_at) + 86400000).toISOString();
        const attempt = work => {
            const before = total();
            const error = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, work));
            assert.equal(total(), before, 'the broken change was not committed');
            assert.equal(f.db.inTransaction, false);
            return error;
        };
        // The repository boundary alone: membership ended with the interval left open.
        assertAuth(attempt(() => { groups.endMembership(GROUP, who.member.id, at); }), 'INTERNAL_ERROR', 500);
        // The service check alone: direct SQL that the repository boundary never saw, on a group the work looked at.
        assertAuth(attempt(actor => {
            svc.visibleGroup(actor, GROUP);
            f.db.prepare('UPDATE ConversationMembers SET left_at = ? WHERE conversation_id = ? AND user_id = ?').run(at, GROUP, who.member.id);
        }), 'INTERNAL_ERROR', 500);
        // No active owner.
        assertAuth(attempt(actor => {
            svc.visibleGroup(actor, GROUP);
            f.db.prepare("UPDATE ConversationMembers SET role = 'member' WHERE conversation_id = ? AND user_id = ?").run(GROUP, who.owner.id);
        }), 'INTERNAL_ERROR', 500);
        // An active member without an open interval.
        assertAuth(attempt(actor => {
            svc.visibleGroup(actor, GROUP);
            f.db.prepare('UPDATE GroupMembershipIntervals SET last_seq = 0, left_at = ? WHERE conversation_id = ? AND user_id = ? AND left_at IS NULL').run(at, GROUP, who.member.id);
        }), 'INTERNAL_ERROR', 500);
    });

    await t.test('assertGroupInvariants passes a sound group, refuses an unknown one, and needs a transaction', () => {
        assert.ok(thrown(() => svc.assertGroupInvariants(GROUP)) instanceof TypeError);
        assert.equal(svc.groupRead(who.member.context, () => svc.assertGroupInvariants(GROUP)), undefined);
        assertAuth(thrown(() => svc.groupRead(who.member.context, () => svc.assertGroupInvariants('no-such-group'))), 'INTERNAL_ERROR', 500);
    });
    await t.test('visibleGroup returns the actor row of an Active_Member, with the group, for every active role', () => {
        for (const [name, role] of [['owner', 'owner'], ['admin', 'admin'], ['member', 'member']]) {
            const seen = svc.groupRead(who[name].context, actor => svc.visibleGroup(actor, GROUP));
            assert.equal(seen.member.user_id, who[name].id);
            assert.equal(seen.member.role, role);
            assert.equal(seen.member.left_at, null);
            assert.equal(seen.group.conversation_id, GROUP);
            assert.equal(seen.group.kind, 'group');
            assert.equal(seen.group.history_policy, 'from_joined');
            assert.ok(Object.isFrozen(seen) && Object.isFrozen(seen.member) && Object.isFrozen(seen.group));
        }
    });

    await t.test('visibleGroup answers one identical 404 for every case that must not be told apart', () => {
        const owner = who.owner.id;
        const legacy = base.conversations.create({ conversation_id: 'legacy-origin-group', kind: 'group', title: 'Legacy', created_by: owner, origin: 'legacy' });
        const bare = base.conversations.create({ conversation_id: 'group-without-extension', kind: 'group', title: 'Bare', created_by: owner, origin: 'authenticated' });
        const direct = base.conversations.createAuthenticatedDirect(owner, who.nonMember.id);
        for (const id of [legacy.conversation_id, bare.conversation_id]) {
            assert.equal(base.members.get(id, owner).role, 'owner', 'the creator is an active owner of the setup group');
            assert.equal(base.members.get(id, owner).left_at, null);
        }
        assert.equal(base.members.get(direct.conversation_id, owner).left_at, null, 'the owner takes part in the direct conversation');
        assert.equal(groups.getVisibleGroup(legacy.conversation_id), null);
        assert.equal(groups.getVisibleGroup(bare.conversation_id), null);
        const cases = [
            ['unknown id', who.owner, 'no-such-group'], ['direct conversation', who.owner, direct.conversation_id],
            ['legacy-origin group, active owner', who.owner, legacy.conversation_id],
            ['group without extension record, active owner', who.owner, bare.conversation_id],
            ['non-member', who.nonMember, GROUP], ['pending invitee', who.pendingInvitee, GROUP], ['removed member', who.removedMember, GROUP],
            ['not a string', who.owner, 42], ['null', who.owner, null], ['undefined', who.owner, undefined], ['object', who.owner, { id: GROUP }],
            ['empty', who.owner, ''], ['path traversal', who.owner, '../etc/passwd'], ['control characters', who.owner, `${GROUP}\n`],
            ['too long', who.owner, 'a'.repeat(1025)], ['upper-case copy', who.owner, GROUP.toUpperCase()]
        ];
        const seen = new Set();
        for (const [label, actor, id] of cases) {
            const error = thrown(() => svc.groupRead(actor.context, who => svc.visibleGroup(who, id)));
            assertAuth(error, 'NOT_FOUND', 404);
            seen.add(signature(error));
            assert.equal(signature(thrown(() => svc.groupWrite(actor.context, actor.proof, who => svc.visibleGroup(who, id)))), signature(error), `${label} on a write`);
        }
        assert.equal(seen.size, 1, 'one response for all of them');
        assert.equal(signature(thrown(() => notFound())), [...seen][0]);
    });

    await t.test('visibleGroup serves an archived group, and leaves the archived guard to the operation', () => {
        const archived = base.conversations.create({ conversation_id: 'archived-group', kind: 'group', title: 'Archived', created_by: who.owner.id, origin: 'authenticated' });
        f.db.prepare('INSERT INTO GroupExtensions(conversation_id, description, history_policy, membership_revision, created_at) VALUES(?, NULL, ?, 1, ?)')
            .run(archived.conversation_id, 'all', archived.created_at);
        f.db.prepare('INSERT INTO GroupMembershipIntervals(conversation_id, user_id, interval_no, first_seq, last_seq, joined_at, left_at) VALUES(?, ?, 1, 1, NULL, ?, NULL)')
            .run(archived.conversation_id, who.owner.id, archived.created_at);
        assert.equal(base.members.get(archived.conversation_id, who.owner.id).role, 'owner');
        base.conversations.archive(archived.conversation_id, f.clock.iso());
        const seen = svc.groupRead(who.owner.context, actor => svc.visibleGroup(actor, archived.conversation_id));
        assert.notEqual(seen.group.archived_at, null);
        assert.equal(seen.group.history_policy, 'all');
        assert.equal(seen.member.role, 'owner');
    });

    await t.test('visibleGroup accepts only the actor of the running transaction, and only inside one', () => {
        assert.ok(thrown(() => svc.visibleGroup(who.member.id, GROUP)) instanceof TypeError);
        for (const actor of [who.owner.id, 'someone', undefined, null, 7, { id: who.member.id }]) {
            const error = thrown(() => svc.groupRead(who.member.context, () => svc.visibleGroup(actor, GROUP)));
            assertAuth(error, 'INTERNAL_ERROR', 500);
        }
        svc.groupRead(who.member.context, actor => assert.equal(svc.visibleGroup(actor, GROUP).member.user_id, who.member.id));
    });

    await t.test('requireRole refuses a role that is not listed, and accepts the ones that are', () => {
        const check = (name, roles) => svc.groupRead(who[name].context, actor => svc.requireRole(svc.visibleGroup(actor, GROUP).member, roles));
        assert.equal(check('owner', ['owner']), undefined);
        assert.equal(check('owner', ['owner', 'admin']), undefined);
        assert.equal(check('admin', ['owner', 'admin']), undefined);
        assert.equal(check('member', ['owner', 'admin', 'member']), undefined);
        for (const [name, roles] of [['member', ['owner']], ['member', ['owner', 'admin']], ['admin', ['owner']], ['admin', ['member']], ['owner', ['admin']]]) {
            assertAuth(thrown(() => check(name, roles)), 'FORBIDDEN', 403);
        }
    });

    await t.test('requireRole refuses a malformed role list and never reads one as a substring', () => {
        const member = actor => svc.visibleGroup(actor, GROUP).member;
        for (const roles of [undefined, null, 'member', 'owner,admin,member', [], ['boss'], ['owner', 'boss'], [undefined], [['member']], { 0: 'member', length: 1 }, ['MEMBER'], ['mem']]) {
            const error = thrown(() => svc.groupRead(who.member.context, actor => svc.requireRole(member(actor), roles)));
            assertAuth(error, 'INTERNAL_ERROR', 500);
        }
    });

    await t.test('requireRole authorizes only a member row read by visibleGroup in the same transaction', () => {
        const forged = [{ role: 'owner', left_at: null }, { user_id: who.member.id, role: 'owner', left_at: null, conversation_id: GROUP }, null, undefined, 'owner', 7];
        for (const claim of forged) {
            assertAuth(thrown(() => svc.groupRead(who.member.context, () => svc.requireRole(claim, ['owner', 'admin', 'member']))), 'INTERNAL_ERROR', 500);
        }
        // A real row, copied or edited, is not the row visibleGroup returned.
        assertAuth(thrown(() => svc.groupRead(who.member.context, actor => svc.requireRole({ ...svc.visibleGroup(actor, GROUP).member }, ['member']))), 'INTERNAL_ERROR', 500);
        assertAuth(thrown(() => svc.groupRead(who.member.context, actor => {
            const row = svc.visibleGroup(actor, GROUP).member;
            return svc.requireRole(Object.create(row, { role: { value: 'owner' } }), ['owner']);
        })), 'INTERNAL_ERROR', 500);
        // A row kept from an earlier transaction, even a genuine owner row, authorizes nothing later.
        const kept = svc.groupRead(who.owner.context, actor => svc.visibleGroup(actor, GROUP).member);
        assertAuth(thrown(() => svc.groupRead(who.member.context, () => svc.requireRole(kept, ['owner']))), 'INTERNAL_ERROR', 500);
        assertAuth(thrown(() => svc.groupWrite(who.member.context, who.member.proof, () => svc.requireRole(kept, ['owner']))), 'INTERNAL_ERROR', 500);
        assert.ok(thrown(() => svc.requireRole(kept, ['owner'])) instanceof TypeError, 'and outside any transaction');
        // A row from another user's transaction in the same service is also refused.
        const ownerRow = svc.groupRead(who.owner.context, actor => {
            const row = svc.visibleGroup(actor, GROUP).member;
            svc.requireRole(row, ['owner']);
            return row;
        });
        assert.equal(ownerRow.role, 'owner');
    });
    await t.test('one mapping turns a repository class into an AuthError, and anything else into a bare 500', () => {
        const table = [['DUPLICATE', 'CONFLICT', 409], ['CONFLICT', 'CONFLICT', 409], ['INVALID', 'VALIDATION_ERROR', 400],
            ['REFERENCE', 'VALIDATION_ERROR', 400], ['BUSY', 'SERVICE_UNAVAILABLE', 503], ['UNAVAILABLE', 'SERVICE_UNAVAILABLE', 503],
            ['DATABASE', 'INTERNAL_ERROR', 500], ['CSRF', 'INTERNAL_ERROR', 500], ['CREDENTIALS', 'INTERNAL_ERROR', 500],
            ['CAPACITY', 'INTERNAL_ERROR', 500], ['SOMETHING_NEW', 'INTERNAL_ERROR', 500], ['constructor', 'INTERNAL_ERROR', 500],
            ['__proto__', 'INTERNAL_ERROR', 500], ['toString', 'INTERNAL_ERROR', 500], [undefined, 'INTERNAL_ERROR', 500]];
        for (const [name, code, status] of table) {
            const failure = new RepositoryError('DATABASE');
            failure.code = name;
            failure.message = `${SENTINEL} ${name}`;
            const mapped = toAuthError(failure);
            assertAuth(mapped, code, status);
            assert.ok(!JSON.stringify(mapped).includes(SENTINEL) && !String(mapped.stack).includes(SENTINEL));
        }
        const own = new AuthError('NOT_FOUND', 404, ['x']);
        assert.equal(toAuthError(own), own);
        for (const other of [new Error(SENTINEL), new TypeError(SENTINEL), null, undefined, 'text', 12, {}, { code: 'DUPLICATE' }, Object.create(null)]) {
            assertAuth(toAuthError(other), 'INTERNAL_ERROR', 500);
        }
        const driver = thrown(() => f.db.prepare('INSERT INTO GroupExtensions(conversation_id, history_policy) VALUES(?, ?)').run('x', 'none'));
        assert.ok(String(driver.code).startsWith('SQLITE_'), 'a raw driver error');
        const fromDriver = toAuthError(driver);
        assert.ok(fromDriver instanceof AuthError && [400, 409].includes(fromDriver.status));
        assert.ok(!/sqlite|constraint|GroupExtensions|history_policy|CHECK/i.test(JSON.stringify(fromDriver) + fromDriver.message));
    });

    await t.test('audit writes one row of allowed keys only, in the caller transaction', () => {
        const run = (event, details) => svc.groupWrite(who.owner.context, who.owner.proof, actor => { svc.audit(actor, event, GROUP, details); });
        const before = auditRows(GROUP).length;
        run('group.member.added', { targetId: who.member.id, role: 'member' });
        run('group.archived');
        run('group.owner.transferred', { targetId: who.admin.id });
        const rows = auditRows(GROUP).slice(before);
        assert.equal(rows.length, 3);
        assert.equal(rows[0].event_type, 'group.member.added');
        assert.deepEqual(JSON.parse(rows[0].metadata_json), { operation: 'member.added', outcome: 'confirmed', target_id: who.member.id, role: 'member' });
        assert.deepEqual(JSON.parse(rows[1].metadata_json), { operation: 'archived', outcome: 'confirmed' });
        assert.deepEqual(JSON.parse(rows[2].metadata_json), { operation: 'owner.transferred', outcome: 'confirmed', target_id: who.admin.id });
        for (const row of rows) {
            assert.equal(row.source, 'groups');
            assert.equal(row.subject_id, GROUP);
            assert.equal(row.actor_user_id, who.owner.id);
            assert.equal(row.severity, 'info');
            assert.deepEqual(Object.keys(JSON.parse(row.metadata_json)).filter(key => !['operation', 'outcome', 'target_id', 'role'].includes(key)), []);
        }
        assert.ok(!rows.map(row => row.metadata_json).join('').includes('Fixture group'), 'no group name in an audit row');
    });

    await t.test('the audit events are exactly the closed list of the design, and an unknown one is refused', () => {
        assert.deepEqual([...AUDIT_EVENTS], ['group.created', 'group.updated', 'group.archived', 'group.member.added', 'group.member.removed',
            'group.member.left', 'group.role.changed', 'group.owner.transferred', 'group.invitation.created', 'group.invitation.accepted',
            'group.invitation.declined', 'group.invitation.cancelled', 'group.invitation.expired']);
        assert.ok(Object.isFrozen(AUDIT_EVENTS));
        const before = { rows: auditRows(GROUP).length, state: total() };
        const rejected = [['group.deleted', {}], ['', {}], [undefined, {}], ['GROUP.CREATED', {}], ['group.created ', {}], ['conversation.direct.ready', {}],
            ['group.updated', { name: 'Secret name' }], ['group.updated', { description: 'text' }], ['group.updated', { message: 'hello' }],
            ['group.updated', { targetId: 'bad id with spaces' }], ['group.updated', { targetId: 'a'.repeat(65) }], ['group.updated', { targetId: 7 }],
            ['group.updated', { targetId: '' }], ['group.updated', { role: 'boss' }], ['group.updated', { role: 'Owner' }], ['group.updated', null], ['group.updated', []]];
        for (const [event, details] of rejected) {
            assertAuth(thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, actor => {
                groups.bumpRevision(GROUP);
                svc.audit(actor, event, GROUP, details);
            })), 'INTERNAL_ERROR', 500);
        }
        for (const [actor, group] of [[undefined, GROUP], ['', GROUP], [who.owner.id, '../x'], [who.owner.id, undefined], [who.owner.id, '']]) {
            assertAuth(thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, () => { svc.audit(actor, 'group.updated', group); })), 'INTERNAL_ERROR', 500);
        }
        assert.deepEqual({ rows: auditRows(GROUP).length, state: total() }, before, 'nothing of the refused writes was committed');
        assert.ok(thrown(() => svc.audit(who.owner.id, 'group.updated', GROUP)) instanceof TypeError, 'and it needs a transaction');
    });

    await t.test('a failed audit insert rolls the whole transaction back as a 500, even when the caller catches it', () => {
        const before = { revision: revisionOf(GROUP), state: total() };
        f.db.exec("CREATE TEMP TRIGGER fail_group_audit BEFORE INSERT ON AuditLogs WHEN NEW.source = 'groups' BEGIN SELECT RAISE(ABORT, 'audit sink down'); END");
        try {
            const thrownError = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, actor => {
                groups.bumpRevision(GROUP);
                svc.audit(actor, 'group.updated', GROUP);
            }));
            assertAuth(thrownError, 'INTERNAL_ERROR', 500);
            assert.ok(!/audit sink|ABORT|trigger|AuditLogs/i.test(JSON.stringify(thrownError) + thrownError.message));
            let swallowed;
            const returned = thrown(() => svc.groupWrite(who.owner.context, who.owner.proof, actor => {
                groups.bumpRevision(GROUP);
                try { svc.audit(actor, 'group.updated', GROUP); } catch (error) { swallowed = error; }
                return 'carried on';
            }));
            assertAuth(swallowed, 'INTERNAL_ERROR', 500);
            assertAuth(returned, 'INTERNAL_ERROR', 500);
        } finally { f.db.exec('DROP TRIGGER fail_group_audit'); }
        assert.equal(revisionOf(GROUP), before.revision);
        assert.equal(total(), before.state);
        assert.equal(svc.groupWrite(who.owner.context, who.owner.proof, () => 'recovered'), 'recovered');
    });

    await t.test('the ASM-03 numbers are named constants in one frozen table', () => {
        assert.deepEqual(DEFAULT_RATE_LIMITS, {
            readUser: { limit: 120, windowMs: 60000 }, readSource: { limit: 240, windowMs: 60000 },
            writeUser: { limit: 60, windowMs: 60000 }, writeSource: { limit: 120, windowMs: 60000 },
            inviteUser: { limit: 20, windowMs: 3600000 }, inviteTarget: { limit: 5, windowMs: 3600000 }, inviteSource: { limit: 60, windowMs: 3600000 },
            createUser: { limit: 20, windowMs: 3600000 }, createSource: { limit: 60, windowMs: 3600000 }
        });
        assert.ok(Object.isFrozen(DEFAULT_RATE_LIMITS));
        for (const value of Object.values(DEFAULT_RATE_LIMITS)) assert.ok(Object.isFrozen(value));
    });

    await t.test('an options argument overrides single numbers, and a bad override stops the construction', () => {
        const make = rates => createGroupService({ db: f.db, auth, limiter: f.limiter, now: f.clock.now, rates });
        const tuned = make({ readUser: { limit: 3 }, writeSource: { limit: 9, windowMs: 1000 } });
        assert.deepEqual(tuned.rates.readUser, { limit: 3, windowMs: 60000 });
        assert.deepEqual(tuned.rates.writeSource, { limit: 9, windowMs: 1000 });
        assert.deepEqual(tuned.rates.readSource, DEFAULT_RATE_LIMITS.readSource);
        assert.ok(Object.isFrozen(tuned.rates) && Object.isFrozen(tuned.rates.readUser));
        assert.equal(DEFAULT_RATE_LIMITS.readUser.limit, 120, 'the defaults are untouched');
        assert.deepEqual(make({}).rates, DEFAULT_RATE_LIMITS);
        for (const rates of [{ unknown: { limit: 1 } }, { readUser: null }, { readUser: 5 }, { readUser: {} }, { readUser: { limit: 0 } }, { readUser: { limit: -1 } },
            { readUser: { limit: 1.5 } }, { readUser: { limit: Infinity } }, { readUser: { limit: NaN } }, { readUser: { limit: '5' } },
            { readUser: { windowMs: 0 } }, { readUser: { windowMs: -5 } }, { readUser: { windowMs: Number.MAX_SAFE_INTEGER + 2 } },
            { readUser: { limit: 1, extra: 1 } }, { readUser: { limit: undefined } }, { readUser: [1] }, JSON.parse('{"__proto__": {"limit": 1}}'),
            { constructor: { limit: 1 } }]) {
            assert.throws(() => make(rates), TypeError, JSON.stringify(rates));
        }
    });

    await t.test('rate consumes the read and write bucket pairs of DB5-R12.4 with the configured numbers and the given source', () => {
        const calls = [];
        const recording = { consume(buckets, at) { calls.push({ buckets, at }); return { allowed: true }; } };
        const tuned = createGroupService({ db: f.db, auth, limiter: recording, now: f.clock.now, rates: { readSource: { limit: 7 } } });
        const context = { ...who.member.context, forwardedFor: '6.6.6.6', headers: { 'x-forwarded-for': '6.6.6.6' } };
        tuned.rate('read', context, '10.0.0.1');
        tuned.rate('write', context, '10.0.0.1');
        assert.deepEqual(calls[0], { at: f.clock.now(), buckets: [
            { key: `groups:read:${who.member.id}`, limit: 120, windowMs: 60000 }, { key: 'groups:read-source:10.0.0.1', limit: 7, windowMs: 60000 }] });
        assert.deepEqual(calls[1].buckets, [
            { key: `groups:write:${who.member.id}`, limit: 60, windowMs: 60000 }, { key: 'groups:write-source:10.0.0.1', limit: 120, windowMs: 60000 }]);
        assert.ok(!JSON.stringify(calls).includes('6.6.6.6'), 'a forwarded header is never read');
    });

    await t.test('rate answers 429 with a retry delay, separates users, and shares the source bucket', () => {
        const limited = createGroupService({ db: f.db, auth, limiter: createSqliteRateLimiter(f.db), now: f.clock.now,
            rates: { readUser: { limit: 2, windowMs: 60000 }, readSource: { limit: 3, windowMs: 60000 } } });
        limited.rate('read', who.member.context, '203.0.113.7');
        limited.rate('read', who.member.context, '203.0.113.7');
        const user = thrown(() => limited.rate('read', who.member.context, '203.0.113.7'));
        assertAuth(user, 'RATE_LIMITED', 429);
        assert.ok(Number.isInteger(user.retryAfterSeconds) && user.retryAfterSeconds >= 1);
        limited.rate('read', who.admin.context, '203.0.113.7');
        assertAuth(thrown(() => limited.rate('read', who.owner.context, '203.0.113.7')), 'RATE_LIMITED', 429);
        limited.rate('read', who.owner.context, '203.0.113.8');
        assert.equal(limited.rate('write', who.member.context, '203.0.113.7'), undefined, 'reads and mutations use separate buckets');
    });

    await t.test('rate refuses an unknown operation, a missing user or source, and a malformed limiter answer', () => {
        for (const operation of [undefined, 'create', 'invite', 'READ', 'delete', '', 7]) {
            assert.ok(thrown(() => svc.rate(operation, who.member.context, '10.0.0.1')) instanceof TypeError);
        }
        for (const source of [undefined, null, '', 7, {}, 'a'.repeat(257)]) {
            assert.ok(thrown(() => svc.rate('read', who.member.context, source)) instanceof TypeError);
        }
        for (const context of [undefined, null, {}, { userId: '' }, { userId: 7 }, 'user']) {
            assert.ok(thrown(() => svc.rate('read', context, '10.0.0.1')) instanceof TypeError);
        }
        const answering = answer => createGroupService({ db: f.db, auth, limiter: { consume: () => answer }, now: f.clock.now });
        for (const answer of [undefined, null, 'allowed', 1]) assertAuth(thrown(() => answering(answer).rate('read', who.member.context, 'a')), 'INTERNAL_ERROR', 500);
        for (const answer of [{}, { allowed: 'yes' }, { allowed: 1 }, { allowed: false }, { allowed: false, retryAfterSeconds: 'soon' }]) {
            const error = thrown(() => answering(answer).rate('read', who.member.context, 'a'));
            assertAuth(error, 'RATE_LIMITED', 429);
            assert.equal(error.retryAfterSeconds, 1);
        }
        const broken = createGroupService({ db: f.db, auth, limiter: { consume() { throw new Error(SENTINEL); } }, now: f.clock.now });
        const error = thrown(() => broken.rate('read', who.member.context, 'a'));
        assertAuth(error, 'INTERNAL_ERROR', 500);
        assert.ok(!JSON.stringify(error).includes(SENTINEL));
        assert.equal(answering({ allowed: true }).rate('read', who.member.context, 'a'), undefined);
    });

    await t.test('service.js holds no SQL, no environment access, no forwarded header and no logging', () => {
        const source = fs.readFileSync(require.resolve('../server/groups/service'), 'utf8');
        assert.ok(/^[\x00-\x7F]*$/.test(source), 'ASCII only');
        assert.ok(!/process\.env|console\.|x-forwarded|forwarded-for|req\.ip|Math\.random|Date\.now|new Date\(\)/i.test(source));
        assert.ok(!/\bprepare\(|\.exec\(|\.pragma\(['"`][^'"`]*(?:write|insert)/i.test(source.replace(/db\.pragma\('query_only[^)]*\)/g, '')));
        for (const table of ['GroupExtensions', 'GroupMembershipIntervals', 'ConversationInvitations', 'GroupReadPositions', 'GroupCreationKeys']) {
            assert.ok(!source.includes(table), `${table} is named only by the repository`);
        }
        const requires = (source.match(/require\(\s*['"][^'"]+['"]\s*\)/g) || []).map(text => text.replace(/\s/g, ''));
        assert.deepEqual(requires, ["require('node:crypto')", "require('../database/socialRepository')", "require('../database/groupRepository')", "require('../auth/rateLimiter')",
            "require('../auth/errors')", "require('../features/config')", "require('./policy')", "require('./validation')", "require('./cursor')"]);
    });
});
