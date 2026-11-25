'use strict';

// T-5C-41 / P-31 (DB5-R01.2, R05.14, R07.1, R11.5, R12.9, R13.5, R13.12, NFR-01).
// Every operation runs against a disposable authenticated fixture. A test-only database proxy counts prepared write
// statements and injects repository error classes before the selected statement; the transaction and production service
// remain the real implementations. A closed fixture database is copied back from a synthetic baseline before each case.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { httpGroupFixture, snapshot, changedTables, createClock, openLimiter, guardPath } = require('./support/groups');
const { createGroupService } = require('../server/groups/service');
const { createGroupMessageService } = require('../server/messaging/group');
const { RepositoryError } = require('../server/database/groupRepository');
const { AuthError } = require('../server/auth/errors');

const FEATURES = Object.freeze({ groupApi:true, groups:Object.freeze({ maxMembers:10, directAdd:true,
    maxPendingInvitationsPerGroup:20, maxPendingInvitationsPerInvitee:20 }) });
const DATABASE_TEXT = 'SENTINEL-SQLITE-TEXT-P31';
const ERROR_CASES = Object.freeze([
    ['DUPLICATE',409,'CONFLICT'],['CONFLICT',409,'CONFLICT'],['INVALID',400,'VALIDATION_ERROR'],
    ['BUSY',503,'SERVICE_UNAVAILABLE'],['UNAVAILABLE',503,'SERVICE_UNAVAILABLE'],['DATABASE',500,'INTERNAL_ERROR'],
]);
const OPERATION_NAMES = Object.freeze(['create','update','archive','add','invite','accept','decline','cancel','remove','leave','role','transfer']);
const MESSAGE_FEATURES=Object.freeze({groupApi:true,groupMessaging:true,groups:Object.freeze({maxMembers:10,directAdd:true,
    maxPendingInvitationsPerGroup:20,maxPendingInvitationsPerInvitee:20})});
const MESSAGE_VERIFIER=Object.freeze({async verifyEnvelope(){return {verified:true};}});
const encryptedEnvelope=(actor,groupId,id)=>({id,conversationId:groupId,senderId:actor.id,
    senderName:actor.actorClass==='owner'?'Group Owner':'Group Member',timestamp:'2030-01-01T00:00:00.000Z',type:'text',
    encryption:{version:1,algorithm:'AES-256-GCM',encoding:'base64',iv:Buffer.alloc(12,1).toString('base64'),
        ciphertext:Buffer.alloc(32,2).toString('base64')}});
const actorProof = (f, actor) => {
    const sessionToken = actor.browser.cookies.get(f.config.sessionCookie);
    const row = f.application.auth.resolveToken(sessionToken).row;
    return { context:{ userId:row.user_id, sessionId:row.session_id }, proof:f.application.auth.csrfProof(sessionToken,null,actor.token) };
};
const revision = (db, id) => db.prepare('SELECT membership_revision AS value FROM GroupExtensions WHERE conversation_id=?').get(id).value;

function instrumentDatabase(db, { failAt = Infinity, failCode = null } = {}) {
    const state = { writes:[], step:0 };
    const wrapped = new Proxy(db, { get(target, key) {
        if (key === 'prepare') return sql => {
            const statement = target.prepare(sql);
            return new Proxy(statement, { get(inner, property) {
                if (['run','all','get'].includes(property)) return (...args) => {
                    if (/^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql)) {
                        state.step += 1;
                        state.writes.push(sql);
                        if (state.step === failAt) {
                            const injected = new RepositoryError(failCode);
                            injected.message = `${DATABASE_TEXT}: synthetic table/index/SQL detail`;
                            throw injected;
                        }
                    }
                    return inner[property](...args);
                };
                const value = Reflect.get(inner,property,inner);
                return typeof value === 'function' ? value.bind(inner) : value;
            }});
        };
        const value = Reflect.get(target,key,target);
        return typeof value === 'function' ? value.bind(target) : value;
    }});
    return { db:wrapped, state };
}

function operation(f, svc, kind) {
    const owner = actorProof(f,f.actors.owner);
    const member = actorProof(f,f.actors.member);
    const invitee = actorProof(f,f.actors.pendingInvitee);
    const target = f.actors.nonMember.id;
    const group = f.groupId;
    const atRevision = revision(f.db,group);
    const requests = {
        create:() => svc.createGroup(owner.context,owner.proof,{ name:'Atomicity-created', idempotencyKey:'p31-create-key' },'127.0.0.1'),
        update:() => svc.updateGroup(owner.context,owner.proof,group,{ name:'Atomicity-updated', membershipRevision:atRevision }),
        archive:() => svc.archiveGroup(owner.context,owner.proof,group),
        add:() => svc.addMember(owner.context,owner.proof,group,{ userId:target }),
        invite:() => svc.createInvitation(owner.context,owner.proof,group,{ userId:target },'127.0.0.1'),
        accept:() => svc.acceptInvitation(invitee.context,invitee.proof,f.invitationId),
        decline:() => svc.declineInvitation(invitee.context,invitee.proof,f.invitationId),
        cancel:() => svc.cancelInvitation(owner.context,owner.proof,group,f.invitationId),
        remove:() => svc.removeMember(owner.context,owner.proof,group,f.actors.member.id),
        leave:() => svc.leaveGroup(member.context,member.proof,group),
        role:() => svc.changeMemberRole(owner.context,owner.proof,group,f.actors.admin.id,{ role:'member', membershipRevision:atRevision }),
        transfer:() => svc.transferOwnership(owner.context,owner.proof,group,{ userId:f.actors.admin.id, membershipRevision:atRevision }),
    };
    return requests[kind]();
}

async function restoreFixture(f, baseline) {
    await f.application.close();
    if (f.db.open) f.db.close();
    fs.copyFileSync(baseline,f.filename);
    const browser = await f.anotherServer();
    f.db = f.connections.at(-1);
    f.application = f.applications.at(-1);
    for (const actor of Object.values(f.actors)) actor.browser.origin = browser.origin;
}

test('P-31: every prepared write step of every group mutation rolls back for every repository error class',
    { timeout:300000 }, async t => {
        const f = await httpGroupFixture(t,{ features:FEATURES, clock:createClock('2030-01-01T00:00:00.000Z') });
        const baseline = guardPath(path.join(f.directory,'p31-baseline.sqlite'));
        const outcomes = [];
        // Close before copying so the WAL/checkpoint state is fully represented in the baseline file.
        await f.application.close();
        f.db.close();
        fs.copyFileSync(f.filename,baseline);
        const firstBrowser = await f.anotherServer();
        f.db=f.connections.at(-1);f.application=f.applications.at(-1);
        for (const actor of Object.values(f.actors)) actor.browser.origin=firstBrowser.origin;

        for (const kind of OPERATION_NAMES) {
            const beforeMeasurement=snapshot(f.db);
            const measured = instrumentDatabase(f.db);
            const measurementService = createGroupService({ db:measured.db, auth:f.application.auth, limiter:openLimiter(),
                now:f.clock.now, features:FEATURES });
            operation(f,measurementService,kind);
            const measuredChanges=changedTables(beforeMeasurement,snapshot(f.db));
            assert.ok(measuredChanges.some(table=>table!=='AuditLogs'),`${kind} dry run changed domain state as well as audit`);
            const steps = measured.state.writes.slice();
            assert.ok(steps.length > 0, `${kind} has measurable prepared write steps`);
            assert.ok(steps.some(sql=>/\bAuditLogs\b/i.test(sql)),`${kind} measures its transactional audit insert`);
            outcomes.push({ kind, steps:steps.map(sql=>sql.trim().replace(/\s+/g,' ').slice(0,96)) });

            // The measurement is the only successful mutation in this operation. Restore once before fault injection;
            // every injected failure is then independently checked against that baseline and must roll back to it.
            await restoreFixture(f,baseline);
            for (let step = 1; step <= steps.length; step += 1) {
                const isAuditStep = /\bAuditLogs\b/i.test(steps[step - 1]);
                for (const [errorClass,mappedStatus,mappedCode] of ERROR_CASES) {
                    const before=snapshot(f.db);
                    const fault=instrumentDatabase(f.db,{ failAt:step, failCode:errorClass });
                    const svc=createGroupService({ db:fault.db, auth:f.application.auth, limiter:openLimiter(), now:f.clock.now, features:FEATURES });
                    let caught;
                    try { operation(f,svc,kind); } catch (error) { caught=error; }
                    assert.ok(caught instanceof AuthError, `${kind} step ${step} ${errorClass} is mapped without forwarding the driver error`);
                    assert.equal(caught.status,isAuditStep?500:mappedStatus,`${kind} step ${step} ${errorClass} status`);
                    assert.equal(caught.code,isAuditStep?'INTERNAL_ERROR':mappedCode,`${kind} step ${step} ${errorClass} code`);
                    assert.equal(caught.message,caught.code,`${kind} step ${step} ${errorClass} exposes only the mapped code`);
                    assert.ok(!JSON.stringify(caught).includes(DATABASE_TEXT));
                    assert.deepEqual(caught.fields,[]);
                    assert.equal(caught.cause,undefined);
                    assert.deepEqual(snapshot(f.db),before,`${kind} step ${step} ${errorClass} changed a table`);
                    assert.equal(f.db.inTransaction,false,`${kind} step ${step} ${errorClass} left a transaction open`);
                }
            }
        }
        assert.deepEqual(outcomes.map(result=>result.kind),OPERATION_NAMES);
        t.diagnostic(`P-31 write-step coverage ${JSON.stringify(outcomes)}; error classes=${ERROR_CASES.map(row=>row[0]).join(',')}`);
    });

test('P-31: every group message write step rolls back send, tombstone, read position and receipt',
    {timeout:300000},async t=>{
        const f=await httpGroupFixture(t,{features:MESSAGE_FEATURES,messageOptions:{groupRecipientKeyVerifier:MESSAGE_VERIFIER},
            clock:createClock('2030-01-01T00:00:00.000Z')});
        const baseline=guardPath(path.join(f.directory,'p31-messages-baseline.sqlite'));
        const owner=actorProof(f,f.actors.owner),member=actorProof(f,f.actors.member);
        const seed=await f.application.groupMessages.submit(owner.context,owner.proof,f.groupId,
            encryptedEnvelope(f.actors.owner,f.groupId,'p31-message-seed'));
        const storageId=seed.message.storageId;
        await f.application.close();f.db.close();fs.copyFileSync(f.filename,baseline);
        const firstBrowser=await f.anotherServer();f.db=f.connections.at(-1);f.application=f.applications.at(-1);
        for(const actor of Object.values(f.actors))actor.browser.origin=firstBrowser.origin;
        const createServices=db=>{
            const groups=createGroupService({db,auth:f.application.auth,limiter:openLimiter(),now:f.clock.now,features:MESSAGE_FEATURES});
            const messages=createGroupMessageService({db,auth:f.application.auth,groups,limiter:openLimiter(),groupRecipientKeyVerifier:MESSAGE_VERIFIER});
            return{groups,messages};
        };
        const actions={
            send:(messages)=>messages.submit(owner.context,owner.proof,f.groupId,encryptedEnvelope(f.actors.owner,f.groupId,'p31-message-new')),
            tombstone:(messages)=>messages.remove(owner.context,owner.proof,f.groupId,storageId,{}),
            readPosition:(messages)=>messages.updateReadPosition(owner.context,owner.proof,f.groupId,{position:1}),
            receipt:(messages)=>messages.recordReceipt(member.context,member.proof,f.groupId,storageId,{status:'delivered'})
        };
        const outcomes=[];
        for(const kind of Object.keys(actions)){
            const beforeMeasurement=snapshot(f.db),measured=instrumentDatabase(f.db);
            const service=createServices(measured.db);await actions[kind](service.messages);
            const changes=changedTables(beforeMeasurement,snapshot(f.db));
            assert.ok(changes.length>0,`${kind} successful dry run changes its domain state`);
            const writes=measured.state.writes.slice();assert.ok(writes.length>0,`${kind} has measurable prepared writes`);
            outcomes.push({kind,steps:writes.map(sql=>sql.trim().replace(/\s+/g,' ').slice(0,96))});
            await restoreFixture(f,baseline);
            // Contexts bind stable sessions; each restarted fixture preserves their cloned session rows.
            for(let step=1;step<=writes.length;step++)for(const[errorClass,mappedStatus,mappedCode]of ERROR_CASES){
                const before=snapshot(f.db),fault=instrumentDatabase(f.db,{failAt:step,failCode:errorClass});
                const services=createServices(fault.db);let caught;
                try{await actions[kind](services.messages);}catch(error){caught=error;}
                const isAudit=/\bAuditLogs\b/i.test(writes[step-1]);
                assert.ok(caught instanceof AuthError,`${kind} step ${step} ${errorClass} maps to AuthError`);
                assert.deepEqual([caught.status,caught.code],isAudit?[500,'INTERNAL_ERROR']:[mappedStatus,mappedCode],`${kind} step ${step} ${errorClass}`);
                assert.equal(caught.message,caught.code);assert.equal(caught.cause,undefined);assert.deepEqual(caught.fields,[]);
                assert.ok(!JSON.stringify(caught).includes(DATABASE_TEXT));assert.deepEqual(snapshot(f.db),before,`${kind} failure leaves every table unchanged`);
                assert.equal(f.db.inTransaction,false,`${kind} failure closes its transaction`);
            }
        }
        assert.deepEqual(outcomes.map(row=>row.kind),Object.keys(actions));
        t.diagnostic(`P-31 group-message write-step coverage ${JSON.stringify(outcomes)}; error classes=${ERROR_CASES.map(row=>row[0]).join(',')}`);
    });
