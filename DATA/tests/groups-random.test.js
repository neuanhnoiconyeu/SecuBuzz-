'use strict';

// Feature: db5-db6-canonical-integration, Property P-01: One active owner after every operation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AuthError}=require('../server/auth/errors');
const {createGroupService}=require('../server/groups/service');
const {createGroupRepository}=require('../server/database/groupRepository');
const {httpGroupFixture,openLimiter,snapshot,changedTables,createClock,INVITATION_EXPIRY_MS}=require('./support/groups');
const {createRandom,forAll}=require('./support/random');

const P01_SEQUENCES=100;
const P01_OPERATIONS=50;
const P01_SEED=0x5c010024;
const SOURCE='127.0.0.1';
const USER_CLASSES=['owner','admin','member','pendingInvitee','removedMember','nonMember'];
const OP_WEIGHTS=[['create',6],['invite',12],['accept',10],['decline',7],['cancel',7],['advance',5],
    ['remove',12],['leave',10],['role',10],['transfer',8],['archive',5],['add',8]];
const MUTATIONS=new Set(['create','invite','accept','decline','cancel','remove','leave','role','transfer','archive','add']);
const INVITATION_STATES=new Set(['pending','accepted','declined','cancelled','expired']);
const TERMINAL_INVITATION_STATES=new Set(['accepted','declined','cancelled','expired']);
const INVITATION_IMMUTABLE_FIELDS=['invitation_id','conversation_id','invitee_id','inviter_id','created_at','expires_at'];
const invitationQueriesByDatabase=new WeakMap();
const describeSequence=sequence=>sequence.map((op,index)=>`${index}:${op.op}(a=${op.actorClass},t=${op.targetClass},g=${op.groupSlot},stale=${op.revisionMode||'no'},replay=${op.replay})`);
const stateQueriesByDatabase=new WeakMap();

function makeActorContext(f,actor) {
    const token=actor.browser.cookies.get(f.config.sessionCookie);
    const session=f.application.auth.resolveToken(token).row;
    return Object.freeze({context:Object.freeze({userId:session.user_id,sessionId:session.session_id}),
        expiresAt:session.expires_at_ms,proof:f.application.auth.csrfProof(token,null,actor.token)});
}
function expectedStatus(op) {
    return ({create:201,invite:201,accept:200,decline:204,cancel:204,remove:204,leave:204,
        role:200,transfer:200,archive:200,add:201})[op];
}
function stateRows(db,id) {
    let queries=stateQueriesByDatabase.get(db);
    if(!queries) {
        queries={
            conversation:db.prepare('SELECT conversation_id,created_by,created_at,updated_at,archived_at FROM Conversations WHERE conversation_id=?'),
            extension:db.prepare('SELECT conversation_id,history_policy,membership_revision,created_at FROM GroupExtensions WHERE conversation_id=?'),
            members:db.prepare('SELECT conversation_id,user_id,role,joined_at,left_at FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id'),
            intervals:db.prepare('SELECT conversation_id,user_id,interval_no,first_seq,last_seq,joined_at,left_at FROM GroupMembershipIntervals WHERE conversation_id=? ORDER BY user_id,interval_no'),
            invitations:db.prepare('SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE conversation_id=? ORDER BY invitation_id'),
            creationKeys:db.prepare('SELECT user_id,idempotency_key,conversation_id,created_at FROM GroupCreationKeys WHERE conversation_id=? ORDER BY user_id,idempotency_key'),
            audits:db.prepare('SELECT event_type,actor_user_id,subject_id,metadata_json,created_at FROM AuditLogs WHERE subject_id=? ORDER BY rowid')
        };
        stateQueriesByDatabase.set(db,queries);
    }
    return {
        conversation:queries.conversation.get(id),
        extension:queries.extension.get(id),
        members:queries.members.all(id),
        intervals:queries.intervals.all(id),
        invitations:queries.invitations.all(id),
        creationKeys:queries.creationKeys.all(id),
        audits:queries.audits.all(id)
    };
}
const roleOf=(group,userId)=>group.members.get(userId)?.active?group.members.get(userId).role:null;
const nowMs=group=>Date.parse(group.clock.iso());
const expired=(invitation,now)=>now>=Date.parse(invitation.expiresAt);
function activeCount(group) { return [...group.members.values()].filter(member=>member.active).length; }
function addAudit(group,event,actor,at) { group.audits.push({event,actor,at}); }
function cancelInvitationsFor(group,userId,at) {
    for(const invitation of group.invitations.values())if(invitation.state==='pending'&&
        (invitation.inviteeId===userId||invitation.inviterId===userId)) {
        invitation.state='cancelled';invitation.resolvedAt=at;
    }
}
function groupSnapshot(f,group) { return stateRows(f.db,group.id); }

// Oracle is a separate literal state machine based on the canonical requirement order.
// It deliberately does not call groups/policy.js or service validators.
function decide(f,groups,request) {
    const {op,actorId,targetId,group}=request;
    const actorRole=group?roleOf(group,actorId):null;
    const targetRole=group&&targetId?roleOf(group,targetId):null;
    const at=group?.clock.iso();
    const revision=group?.revision;
    const invitation=request.invitationId&&group?.invitations.get(request.invitationId);
    const deny=(status,code,committed=false)=>({status,code,committed});
    // Session authentication precedes all group business checks, including idempotency replay.
    if(op!=='advance'&&request.sessionExpiresAt!==undefined&&request.clock.now()>=request.sessionExpiresAt)
        return deny(401,'SESSION_EXPIRED');
    if(op==='create') {
        if(request.idempotencyKey) {
            const prior=request.createdGroup;
            if(prior)return roleOf(prior,actorId)
                ?{status:200,code:null,effect:'create-replay',group:prior}
                :deny(409,'IDEMPOTENCY_CONFLICT');
        }
        return {status:201,code:null,effect:'create'};
    }
    if(!group)return deny(404,'NOT_FOUND');
    if(op==='advance')return {status:200,code:null,effect:'advance'};
    if(op==='invite') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(!['owner','admin'].includes(actorRole))return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        const prior=[...group.invitations.values()].find(row=>row.inviteeId===targetId&&row.state==='pending');
        if(targetRole)return deny(409,'CONFLICT');
        if(prior&&!expired(prior,nowMs(group)))return deny(409,'CONFLICT');
        return {status:201,code:null,effect:'invite',expiredPrior:prior||null};
    }
    if(op==='accept') {
        if(!invitation||invitation.inviteeId!==actorId)return deny(404,'NOT_FOUND');
        if(invitation.state!=='pending')return deny(409,'CONFLICT');
        if(expired(invitation,nowMs(group)))return {status:409,code:'CONFLICT',committed:true,effect:'resolve-accept',
            state:'expired',invitation,at,actorId};
        const inviterRole=roleOf(group,invitation.inviterId);
        const invitee=group.members.get(actorId);
        const removedSinceInvite=invitee&&!invitee.active&&Date.parse(invitee.leftAt)>=Date.parse(invitation.createdAt);
        let refusal=null;
        if(invitee?.active||group.archived||!['owner','admin'].includes(inviterRole)||
            activeCount(group)>=group.maximum||removedSinceInvite)refusal='cancelled';
        if(refusal)return {status:409,code:'CONFLICT',committed:true,effect:'resolve-accept',state:refusal,
            invitation,at,actorId};
        return {status:200,code:null,effect:'accept',invitation,at,actorId};
    }
    if(op==='decline') {
        if(!invitation||invitation.inviteeId!==actorId)return deny(404,'NOT_FOUND');
        if(invitation.state!=='pending'||expired(invitation,nowMs(group)))return deny(409,'CONFLICT');
        return {status:204,code:null,effect:'decline',invitation,at,actorId};
    }
    if(op==='cancel') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(!invitation)return ['owner','admin'].includes(actorRole)?deny(404,'NOT_FOUND'):deny(403,'FORBIDDEN');
        if(!['owner','admin'].includes(actorRole)&&invitation.inviterId!==actorId)return deny(403,'FORBIDDEN');
        if(invitation.state!=='pending'||expired(invitation,nowMs(group)))return deny(409,'CONFLICT');
        return {status:204,code:null,effect:'cancel',invitation,at,actorId};
    }
    if(op==='remove') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole==='member')return deny(403,'FORBIDDEN');
        if(!targetRole)return deny(404,'NOT_FOUND');
        if(targetRole==='owner')return actorRole==='owner'?deny(409,'CONFLICT'):deny(403,'FORBIDDEN');
        if(actorRole==='admin'&&targetRole==='admin')return deny(403,'FORBIDDEN');
        return {status:204,code:null,effect:'remove',at,actorId,targetId};
    }
    if(op==='leave') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole==='owner')return deny(409,'CONFLICT');
        return {status:204,code:null,effect:'leave',at,actorId};
    }
    if(op==='role') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole!=='owner')return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        if(!targetRole)return deny(404,'NOT_FOUND');
        if(request.membershipRevision!==null&&request.membershipRevision!==undefined&&request.membershipRevision!==revision)
            return deny(409,'STALE_STATE');
        if(targetRole==='owner'||targetRole===request.newRole)return deny(409,'CONFLICT');
        return {status:200,code:null,effect:'role',at,actorId,targetId,role:request.newRole};
    }
    if(op==='transfer') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole!=='owner')return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        if(!targetRole||targetId===actorId||targetRole==='owner')return deny(400,'VALIDATION_ERROR');
        if(request.membershipRevision!==null&&request.membershipRevision!==undefined&&request.membershipRevision!==revision)
            return deny(409,'STALE_STATE');
        return {status:200,code:null,effect:'transfer',at,actorId,targetId};
    }
    if(op==='archive') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole!=='owner')return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        return {status:200,code:null,effect:'archive',at,actorId};
    }
    if(op==='add') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(!['owner','admin'].includes(actorRole))return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        if(targetRole)return deny(409,'CONFLICT');
        if(activeCount(group)>=group.maximum)return deny(409,'CONFLICT');
        return {status:201,code:null,effect:'add',at,actorId,targetId};
    }
    throw new Error(`unknown P-01 operation ${op}`);
}

function applyModel(group,request,decision,result) {
    const {op,actorId,targetId}=request;
    const at=decision.at||request.clock.iso();
    switch(decision.effect) {
    case 'create': {
        const id=result.group.id;
        const joinedAt=request.clock.iso();
        const created={label:request.label,id,ownerId:actorId,maximum:request.groupMaximum,clock:request.clock,
            createdAt:joinedAt,updatedAt:joinedAt,creationKey:{userId:actorId,key:request.idempotencyKey,createdAt:joinedAt},
            archived:false,archivedAt:null,revision:1,version:0,members:new Map([[actorId,{role:'owner',active:true,joinedAt,leftAt:null,
                intervals:[{intervalNo:1,firstSeq:1,lastSeq:null,joinedAt,leftAt:null}]}]]),
            invitations:new Map(),audits:[]};
        addAudit(created,'group.created',actorId,at);
        return created;
    }
    case 'create-replay': return group;
    case 'advance': request.clock.advance(request.advanceMs);return group;
    case 'invite': {
        if(decision.expiredPrior) {
            decision.expiredPrior.state='expired';decision.expiredPrior.resolvedAt=at;
            addAudit(group,'group.invitation.expired',actorId,at);
        }
        const id=result.invitation.id;
        group.invitations.set(id,{id,inviteeId:targetId,inviterId:actorId,state:'pending',createdAt:at,
            expiresAt:new Date(Date.parse(at)+INVITATION_EXPIRY_MS).toISOString(),resolvedAt:null});
        addAudit(group,'group.invitation.created',actorId,at);return group;
    }
    case 'resolve-accept': {
        decision.invitation.state=decision.state;decision.invitation.resolvedAt=at;
        addAudit(group,decision.state==='expired'?'group.invitation.expired':'group.invitation.cancelled',actorId,at);return group;
    }
    case 'accept':
    case 'decline':
    case 'cancel': {
        const state=decision.effect==='accept'?'accepted':decision.effect==='decline'?'declined':'cancelled';
        decision.invitation.state=state;decision.invitation.resolvedAt=at;
        if(state==='accepted') {
            let member=group.members.get(actorId);
            if(!member) {member={role:'member',active:true,joinedAt:at,leftAt:null,intervals:[]};group.members.set(actorId,member);}
            else {member.role='member';member.active=true;member.leftAt=null;}
            member.intervals.push({intervalNo:member.intervals.length+1,firstSeq:1,lastSeq:null,joinedAt:at,leftAt:null});
            group.revision++;addAudit(group,'group.invitation.accepted',actorId,at);
        } else addAudit(group,`group.invitation.${state}`,actorId,at);
        return group;
    }
    case 'remove':
    case 'leave': {
        const id=decision.effect==='remove'?targetId:actorId;
        const member=group.members.get(id);member.active=false;member.leftAt=at;
        const interval=member.intervals.at(-1);interval.lastSeq=0;interval.leftAt=at;
        cancelInvitationsFor(group,id,at);group.revision++;
        addAudit(group,decision.effect==='remove'?'group.member.removed':'group.member.left',actorId,at);return group;
    }
    case 'role': {
        group.members.get(targetId).role=request.newRole;group.revision++;
        addAudit(group,'group.role.changed',actorId,at);return group;
    }
    case 'transfer':
        group.members.get(actorId).role='admin';group.members.get(targetId).role='owner';group.ownerId=targetId;group.revision++;
        addAudit(group,'group.owner.transferred',actorId,at);return group;
    case 'archive': group.archived=true;group.archivedAt=at;group.updatedAt=at;addAudit(group,'group.archived',actorId,at);return group;
    case 'add': {
        let member=group.members.get(targetId);
        if(!member) {member={role:'member',active:true,joinedAt:at,leftAt:null,intervals:[]};group.members.set(targetId,member);}
        else {member.role='member';member.active=true;member.leftAt=null;}
        member.intervals.push({intervalNo:member.intervals.length+1,firstSeq:1,lastSeq:null,joinedAt:at,leftAt:null});
        group.revision++;addAudit(group,'group.member.added',actorId,at);return group;
    }
    default: return group;
    }
}

function assertGroupState(f,repository,group) {
    const actual=groupSnapshot(f,group);
    assert.equal(actual.conversation.created_at,group.createdAt,`${group.label}: created timestamp`);
    assert.equal(actual.conversation.updated_at,group.updatedAt,`${group.label}: updated timestamp`);
    assert.equal(actual.extension.membership_revision,group.revision,`${group.label}: revision`);
    assert.equal(actual.extension.created_at,group.createdAt,`${group.label}: extension timestamp`);
    assert.equal(Boolean(actual.conversation.archived_at),group.archived,`${group.label}: archived`);
    assert.equal(actual.conversation.archived_at??null,group.archivedAt??null,`${group.label}: archived timestamp`);
    const members=[...group.members.entries()].map(([userId,m])=>({conversation_id:group.id,user_id:userId,role:m.role,
        joined_at:m.joinedAt,left_at:m.active?null:m.leftAt})).sort((a,b)=>a.user_id.localeCompare(b.user_id));
    assert.deepEqual(actual.members,members,`${group.label}: membership model`);
    const intervals=[];
    for(const[userId,m]of group.members)for(const row of m.intervals)intervals.push({conversation_id:group.id,user_id:userId,
        interval_no:row.intervalNo,first_seq:row.firstSeq,last_seq:row.lastSeq,joined_at:row.joinedAt,left_at:row.leftAt});
    intervals.sort((a,b)=>a.user_id.localeCompare(b.user_id)||a.interval_no-b.interval_no);
    assert.deepEqual(actual.intervals,intervals,`${group.label}: interval model`);
    const invitations=[...group.invitations.values()].map(inv=>({invitation_id:inv.id,conversation_id:group.id,invitee_id:inv.inviteeId,
        inviter_id:inv.inviterId,state:inv.state,created_at:inv.createdAt,expires_at:inv.expiresAt,resolved_at:inv.resolvedAt}))
        .sort((a,b)=>a.invitation_id.localeCompare(b.invitation_id));
    assert.deepEqual(actual.invitations,invitations,`${group.label}: invitation model`);
    assert.deepEqual(actual.creationKeys,[{user_id:group.creationKey.userId,idempotency_key:group.creationKey.key,
        conversation_id:group.id,created_at:group.creationKey.createdAt}],`${group.label}: creation-key timestamp`);
    assert.deepEqual(actual.audits.map(row=>({event:row.event_type,actor:row.actor_user_id,subject:row.subject_id,at:row.created_at})),
        group.audits.map(row=>({event:row.event,actor:row.actor,subject:group.id,at:row.at})),`${group.label}: audit sequence`);
    const report=repository.invariantReport(group.id);
    assert.deepEqual(report,{activeOwners:1,activeMembers:activeCount(group),openIntervals:activeCount(group),mismatches:0},
        `${group.label}: exactly one active owner and consistent intervals`);
}

function invitationRowsForGroups(db,groups) {
    let query=invitationQueriesByDatabase.get(db);
    if(!query) {
        query=db.prepare(`SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at
            FROM ConversationInvitations ORDER BY invitation_id`);
        invitationQueriesByDatabase.set(db,query);
    }
    const groupIds=new Set(groups.map(group=>group.id));
    return query.all().filter(row=>groupIds.has(row.conversation_id));
}

// P-04's transition oracle is independent of the service and checks every persisted Invitation after each P-01 step.
function assertInvitationStateMachine(f,groups,history,coverage) {
    const actual=invitationRowsForGroups(f.db,groups);
    const expected=groups.flatMap(group=>[...group.invitations.values()].map(invitation=>({
        invitation_id:invitation.id,conversation_id:group.id,invitee_id:invitation.inviteeId,inviter_id:invitation.inviterId,
        state:invitation.state,created_at:invitation.createdAt,expires_at:invitation.expiresAt,resolved_at:invitation.resolvedAt
    }))).sort((a,b)=>a.invitation_id.localeCompare(b.invitation_id));
    assert.deepEqual(actual,expected,'P-04 persisted Invitation rows equal the independent operation model');
    const current=new Map(actual.map(row=>[row.invitation_id,row]));
    for(const row of actual) {
        assert.ok(INVITATION_STATES.has(row.state),`P-04 unknown Invitation state ${row.state}`);
        assert.equal(row.resolved_at===null,row.state==='pending',`P-04 resolved_at consistency for ${row.invitation_id}`);
        const previous=history.get(row.invitation_id);
        if(previous) {
            if(previous.state!=='pending') {
                assert.deepEqual(row,previous,`P-04 terminal Invitation ${row.invitation_id} changed after resolution`);
            } else {
                for(const field of INVITATION_IMMUTABLE_FIELDS)
                    assert.equal(row[field],previous[field],`P-04 pending Invitation ${row.invitation_id} changed ${field}`);
                if(row.state==='pending')assert.deepEqual(row,previous,`P-04 pending Invitation ${row.invitation_id} changed without resolution`);
                else {
                    assert.ok(TERMINAL_INVITATION_STATES.has(row.state),`P-04 invalid transition from pending to ${row.state}`);
                    assert.notEqual(row.resolved_at,null,`P-04 terminal Invitation ${row.invitation_id} lacks resolved_at`);
                    coverage.transitions.add(`pending->${row.state}`);
                }
            }
        }
        history.set(row.invitation_id,{...row});
    }
    for(const [id,previous] of history) {
        assert.ok(current.has(id),`P-04 Invitation ${id} was deleted`);
        if(previous.state!=='pending')assert.deepEqual(current.get(id),previous,`P-04 terminal Invitation ${id} changed or disappeared`);
    }
    coverage.snapshots++;
}

const P04_SQL_MUTATIONS=['pending-id','pending-group','pending-invitee','pending-inviter','pending-created','pending-expires',
    'terminal-update','terminal-delete'];
function attemptInvitationMutation(f,actors,coverage) {
    const rows=f.db.prepare(`SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at
        FROM ConversationInvitations ORDER BY invitation_id`).all();
    const pending=rows.filter(row=>row.state==='pending');
    const terminal=rows.filter(row=>TERMINAL_INVITATION_STATES.has(row.state));
    const requested=P04_SQL_MUTATIONS[coverage.sqlAttemptSlots%P04_SQL_MUTATIONS.length];
    let kind=requested;
    if(kind.startsWith('terminal')&&!terminal.length)kind=P04_SQL_MUTATIONS[coverage.sqlAttemptSlots%6];
    if(kind.startsWith('pending')&&!pending.length)kind=coverage.sqlAttemptSlots%2?'terminal-delete':'terminal-update';
    const row=kind.startsWith('terminal')?terminal[coverage.sqlAttemptSlots%terminal.length]:pending[coverage.sqlAttemptSlots%pending.length];
    if(!row)return false;
    const before={...row};
    let sql,parameters,trigger;
    switch(kind) {
    case 'terminal-update':
        if(!TERMINAL_INVITATION_STATES.has(row.state))break;
        sql="UPDATE ConversationInvitations SET state='declined' WHERE invitation_id=?";parameters=[row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'terminal-delete':
        if(!TERMINAL_INVITATION_STATES.has(row.state))break;
        sql='DELETE FROM ConversationInvitations WHERE invitation_id=?';parameters=[row.invitation_id];trigger='invitation_retained';break;
    case 'pending-id':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET invitation_id=? WHERE invitation_id=?';parameters=[`${row.invitation_id}.mutated`,row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'pending-group':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET conversation_id=? WHERE invitation_id=?';parameters=['p04-mutated-group',row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'pending-invitee':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET invitee_id=? WHERE invitation_id=?';parameters=[actors.find(actor=>actor.id!==row.invitee_id).id,row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'pending-inviter':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET inviter_id=? WHERE invitation_id=?';parameters=[actors.find(actor=>actor.id!==row.inviter_id).id,row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'pending-created':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET created_at=? WHERE invitation_id=?';parameters=[new Date(Date.parse(row.created_at)+1).toISOString(),row.invitation_id];trigger='invalid_invitation_transition';break;
    case 'pending-expires':
        if(row.state!=='pending')break;
        sql='UPDATE ConversationInvitations SET expires_at=? WHERE invitation_id=?';parameters=[new Date(Date.parse(row.expires_at)+1).toISOString(),row.invitation_id];trigger='invalid_invitation_transition';break;
    }
    assert.throws(()=>f.db.prepare(sql).run(...parameters),error=>error.code==='SQLITE_CONSTRAINT_TRIGGER'&&error.message===trigger,
        `P-04 ${kind} must be rejected by its schema trigger`);
    const after=f.db.prepare(`SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at
        FROM ConversationInvitations WHERE invitation_id=?`).get(before.invitation_id);
    assert.deepEqual(after,before,`P-04 rejected ${kind} changed its Invitation row`);
    coverage.sqlAttemptSlots++;
    coverage.sqlMutationKinds.add(kind);
    return true;
}

function chooseActor(random,actors,group,operation,invitation) {
    if(['accept','decline'].includes(operation)&&invitation&&random.bool(0.8))return actors[invitation.inviteeId];
    if(operation==='cancel'&&invitation&&random.bool(0.8)) {
        const managers=[...group.members.keys()].filter(id=>['owner','admin'].includes(roleOf(group,id)));
        return actors[random.pick([...managers,invitation.inviterId])];
    }
    if(['role','transfer','archive'].includes(operation)&&random.bool(0.8))return actors[group.ownerId];
    if(['invite','add'].includes(operation)&&random.bool(0.75)) {
        const managers=[...group.members.keys()].filter(id=>['owner','admin'].includes(roleOf(group,id)));
        if(managers.length)return actors[random.pick(managers)];
    }
    if(operation==='leave'&&random.bool(0.8)) {
        const others=[...group.members.keys()].filter(id=>roleOf(group,id)&&roleOf(group,id)!=='owner');
        if(others.length)return actors[random.pick(others)];
    }
    if(operation==='remove'&&random.bool(0.8)) {
        const managers=[...group.members.keys()].filter(id=>['owner','admin'].includes(roleOf(group,id)));
        if(managers.length)return actors[random.pick(managers)];
    }
    return actors[random.pick(Object.keys(actors))];
}

async function withIsolatedSequenceFixture(work) {
    const cleanups=[];
    const fixtureScope={after(callback){cleanups.push(callback);}};
    try {
        const f=await httpGroupFixture(fixtureScope,{clock:createClock(),features:{groupApi:true,
            groups:{directAdd:true,maxMembers:6,maxPendingInvitationsPerGroup:10000,maxPendingInvitationsPerInvitee:10000}}});
        return await work(f);
    } finally {
        for(const cleanup of cleanups.reverse())await cleanup();
    }
}

async function runSequence(f,plan,info,coverage) {
    const actors=Object.fromEntries(USER_CLASSES.map(name=>[f.actors[name].id,{...f.actors[name],...makeActorContext(f,f.actors[name])}]));
    const service=createGroupService({db:f.db,auth:f.application.auth,limiter:openLimiter(),features:{groupApi:true,
        groups:{directAdd:true,maxMembers:6,maxPendingInvitationsPerGroup:10000,maxPendingInvitationsPerInvitee:10000}},now:f.clock.now});
    const repository=createGroupRepository(f.db);
    const byKey=new Map();
    const history=[];
    const invitationHistory=new Map();
    let groups=[];
    async function runRequest(request,random,sequence,sequenceIndex) {
        let group=request.group;
        const actor=request.op==='advance'?null:actors[request.actorId];
        if(request.op!=='advance'&&!actor)throw new Error(`missing P-01 fixture session for actor ${request.actorId}`);
        const expected=decide(f,groups,request);
        const before=group?groupSnapshot(f,group):null;
        const fullBefore=(expected.status>=400&&!expected.committed||['advance','create-replay'].includes(expected.effect))?snapshot(f.db):null;
        let value;
        try {
            const args=request.op==='advance'?[]:[actor.context,actor.proof];
            switch(request.op) {
            case 'advance': value={status:200,code:null};break;
            case 'create': value=service.createGroup(...args,request.body,SOURCE);break;
            case 'invite': value=service.createInvitation(...args,group.id,{userId:request.targetId},SOURCE);break;
            case 'accept': value=service.acceptInvitation(...args,request.invitationId);break;
            case 'decline': value=service.declineInvitation(...args,request.invitationId);break;
            case 'cancel': value=service.cancelInvitation(...args,group.id,request.invitationId);break;
            case 'remove': value=service.removeMember(...args,group.id,request.targetId);break;
            case 'leave': value=service.leaveGroup(...args,group.id);break;
            case 'role': value=service.changeMemberRole(...args,group.id,request.targetId,{role:request.newRole,
                ...(request.membershipRevision===null?{}:{membershipRevision:request.membershipRevision})});break;
            case 'transfer': value=service.transferOwnership(...args,group.id,{userId:request.targetId,
                ...(request.membershipRevision===null?{}:{membershipRevision:request.membershipRevision})});break;
            case 'archive': value=service.archiveGroup(...args,group.id);break;
            case 'add': value=service.addMember(...args,group.id,{userId:request.targetId});break;
            default: throw new Error(`unsupported operation ${request.op}`);
            }
        } catch(error) {
            if(!(error instanceof AuthError))throw error;
            value={status:error.status,code:error.code};
        }
        let actual;
        if(value&&Number.isInteger(value.status))actual={status:value.status,code:value.code};
        else actual={status:request.op==='create'?(value.created?201:200):expectedStatus(request.op),code:null};
        const failureContext={property:sequence.line,operationIndex:sequenceIndex,generatedIndex:request.index,
            simulatedTime:request.clock?.iso(),operation:request.op,group:request.label??group?.label??null,
            groupVersion:group?.version??0,membershipRevision:group?.revision??null,
            actorClass:request.actorClass,sessionExpiresAt:request.sessionExpiresAt,
            sessionStatus:request.op==='advance'?'not-applicable':request.clock.now()>=request.sessionExpiresAt?'expired':'active',
            targetClass:request.targetClass,expected:{status:expected.status,code:expected.code},actual,
            replay:Boolean(request.replay),replayOfIndex:request.replayOfIndex??null};
        assert.deepEqual(actual,{status:expected.status,code:expected.code},JSON.stringify(failureContext));
        if(expected.effect==='create') {
            group=applyModel(null,request,expected,value);
            group.clock=f.clock;
            groups.push(group);byKey.set(request.idempotencyKey,group);request.createdGroup=group;
            request.group=group;request.label=group.label;request.effectGroup=group;
        } else {
            const affected=applyModel(group,request,expected,value);
            if(affected&&affected!==group)throw new Error('unexpected replacement of P-01 group state');
            if(expected.effect==='create-replay')request.createdGroup=group;
        }
        if(expected.status>=400&&!expected.committed) {
            coverage.ordinaryRefusals++;
            assert.deepEqual(group?groupSnapshot(f,group):null,before,`${JSON.stringify(failureContext)} refusal changed group snapshot`);
            assert.deepEqual(snapshot(f.db),fullBefore,`${JSON.stringify(failureContext)} refusal changed database snapshot`);
        } else if(expected.committed)coverage.committedRefusals++;
        if(['advance','create-replay'].includes(expected.effect))assert.deepEqual(snapshot(f.db),fullBefore,`${expected.effect} changed database snapshot: ${JSON.stringify(failureContext)}`);
        if(expected.effect==='accept')coverage.accepted++;
        if(request.op==='advance'&&group)assert.deepEqual(groupSnapshot(f,group),before,'clock advance wrote database rows');
        if(group)assertGroupState(f,repository,group);
        if(expected.status<400||expected.committed) {
            if(group&&expected.effect!=='advance'&&expected.effect!=='create-replay')group.version++;
        }
        if(request.replay)coverage.replays++;
        request.stateVersionAfter=group?.version??0;
        coverage.operations.add(request.op);if(request.actorClass)coverage.actors.add(request.actorClass);
        if(request.targetClass)coverage.targets.add(request.targetClass);
        if(request.newRole)coverage.roles.add(request.newRole);if(group)coverage.archived.add(group.archived);
        if(request.revisionMode)coverage.stale.add(request.revisionMode);
        if(request.wrongActor)coverage.wrongActor++;
        return {group,expected,value};
    }
    const random=info.random;
    const sequence={line:`property=P-01 seed=${info.seed} run=${info.run} runSeed=${info.runSeed}`};
    const maxGroups=plan[0].maxGroups;
    const verifyP04Step=sequenceIndex=>{
        assertInvitationStateMachine(f,groups,invitationHistory,coverage.p04);
        if((sequenceIndex+1)%10===0) {
            attemptInvitationMutation(f,Object.values(actors),coverage.p04);
            assertInvitationStateMachine(f,groups,invitationHistory,coverage.p04);
        }
    };
    for(let sequenceIndex=0;sequenceIndex<plan.length;sequenceIndex++) {
                const generated=plan[sequenceIndex];
                let request;
                const eligible=history.filter(old=>old.group&&old.group.version>(old.versionAfterRequest??0));
                if(generated.replay&&eligible.length) {
                    request={...random.pick(eligible)};
                    request.replay=true;request.replayOfIndex=request.index;request.index=generated.index;
                } else if(generated.op==='create'&&groups.length<generated.maxGroups) {
                    const actor=actors[f.actors[generated.actorClass].id];
                    const key=`p01-${info.run}-${generated.index}`;
                    request={op:'create',actorId:actor.id,actorClass:generated.actorClass,targetClass:null,label:`s${info.run}-g${groups.length}`,
                        group:null,clock:f.clock,sessionExpiresAt:actor.expiresAt,groupMaximum:6,idempotencyKey:key,
                        body:{name:`P01 sequence ${info.run} group ${groups.length}`,description:null,historyPolicy:'from_joined',idempotencyKey:key},
                        createdGroup:byKey.get(key),versionAtRequest:0,index:generated.index};
                } else if(generated.op==='create') {
                    const earlier=history.filter(item=>item.op==='create'&&item.createdGroup);
                    const prior=random.pick(earlier);
                    request={...prior,replay:true,replayOfIndex:prior.index,index:generated.index};
                } else if(generated.op==='advance') {
                    const group=groups.length?groups[generated.groupSlot%groups.length]:null;
                    request={op:'advance',group,clock:f.clock,advanceMs:generated.advanceMs,actorId:null,actorClass:null,index:generated.index};
                } else {
                    const group=groups.length?groups[generated.groupSlot%groups.length]:null;
                    const inviteRows=group?[...group.invitations.values()]:[];
                    const invitation=inviteRows.length?random.pick(inviteRows):null;
                    const op=['accept','decline','cancel'].includes(generated.op)&&!invitation?'accept':generated.op;
                    let actor=group?chooseActor(random,actors,group,op,invitation):actors[f.actors[generated.actorClass].id];
                    let forcedWrongActor=false;
                    if(generated.wrongActor&&op!=='create') {
                        let forbiddenIds=[];
                        if(['accept','decline'].includes(op))forbiddenIds=USER_CLASSES.map(name=>f.actors[name].id).filter(id=>!invitation||id!==invitation.inviteeId);
                        else if(op==='leave'&&group)forbiddenIds=[group.ownerId];
                        else if(op==='cancel'&&group)forbiddenIds=USER_CLASSES.map(name=>f.actors[name].id).filter(id=>id!==invitation?.inviterId&&
                            !['owner','admin'].includes(roleOf(group,id)));
                        else if(group)forbiddenIds=[...group.members.keys()].filter(id=>roleOf(group,id)==='member');
                        if(forbiddenIds.length) {
                            const wrong=actors[random.pick(forbiddenIds)];
                            if(wrong.id!==actor.id){actor=wrong;forcedWrongActor=true;}
                        }
                    }
                    let targetId=f.actors[generated.targetClass] ? f.actors[generated.targetClass].id : null;
                    if(group&&['role','transfer','remove'].includes(op)&&random.bool(0.7)) {
                        const eligibleTargets=[...group.members.keys()].filter(id=>id!==actor.id);
                        if(eligibleTargets.length)targetId=random.pick(eligibleTargets);
                    } else if(group&&['add','invite'].includes(op)&&random.bool(0.65)) {
                        const eligibleTargets=USER_CLASSES.map(name=>f.actors[name].id).filter(id=>!roleOf(group,id));
                        if(eligibleTargets.length)targetId=random.pick(eligibleTargets);
                    }
                    const mode=['role','transfer'].includes(op)?generated.revisionMode:'none';
                    const revision=group?(mode==='stale'?group.revision+1:mode==='current'?group.revision:null):null;
                    request={op,group,clock:f.clock,actorId:actor.id,actorClass:actor.actorClass,sessionExpiresAt:actor.expiresAt,
                        targetId,targetClass:USER_CLASSES.find(name=>f.actors[name].id===targetId)||'unknown',
                        invitationId:invitation?.id||'unknown-invitation',newRole:generated.newRole,revisionMode:mode,membershipRevision:revision,
                        wrongActor:forcedWrongActor,replay:false,advanceMs:generated.advanceMs,index:generated.index};
                }
                if(request.op==='advance') {
                    request.versionAtRequest=request.group?.version??0;
                    coverage.p04.clockPeriods.add(request.advanceMs/INVITATION_EXPIRY_MS);
                    await runRequest(request,random,sequence,sequenceIndex);
                    verifyP04Step(sequenceIndex);
                    for(const state of groups)assertGroupState(f,repository,state);
                    continue;
                }
                const saved={...request,versionAtRequest:request.group?.version??0};
                const outcome=await runRequest(request,random,sequence,sequenceIndex);
                if(outcome.group) {
                    request.group=outcome.group;
                    saved.group=outcome.group;saved.versionAtRequest=request.versionAtRequest??saved.versionAtRequest;
                    saved.versionAfterRequest=outcome.group.version;
                    if(request.op==='create'&&outcome.group) {
                        saved.createdGroup=outcome.group;
                        request.createdGroup=outcome.group;
                        byKey.set(request.idempotencyKey,outcome.group);
                    }
                    if(MUTATIONS.has(request.op))history.push(saved);
                }
                for(const state of groups)assertGroupState(f,repository,state);
                verifyP04Step(sequenceIndex);
            }
    coverage.createdGroups.add(groups.length);
    assert.ok(groups.length>=1&&groups.length<=maxGroups,`sequence ${info.run} used ${groups.length} groups (max ${maxGroups})`);
}

test('P-01: generated operation sequences preserve the owner and group state model',{timeout:240000},async t=>{
    const coverage={operations:new Set(),actors:new Set(),targets:new Set(),roles:new Set(),archived:new Set(),stale:new Set(),wrongActor:0,replays:0,
        accepted:0,committedRefusals:0,ordinaryRefusals:0,createdGroups:new Set(),p04:{transitions:new Set(),snapshots:0,
            sqlAttemptSlots:0,sqlMutationKinds:new Set(),clockPeriods:new Set()}};
    await forAll('P-01',{runs:P01_SEQUENCES,seed:P01_SEED,onRun:line=>t.diagnostic(line),describe:describeSequence},
        (random,info)=>{const maxGroups=1+random.int(0,2);return Array.from({length:P01_OPERATIONS},(_,index)=>({
            op:index===0?'create':random.weighted(OP_WEIGHTS),
            actorClass:random.pick(USER_CLASSES),targetClass:random.pick(USER_CLASSES),newRole:random.pick(['admin','member']),
            revisionMode:random.weighted([['none',0.55],['current',0.2],['stale',0.25]]),
            maxGroups,groupSlot:random.int(0,2),replay:random.bool(0.2),advanceMs:random.int(0,3)*INVITATION_EXPIRY_MS,
            wrongActor:random.bool(0.2),run:info.run,index
        }));},async(plan,info)=>withIsolatedSequenceFixture(f=>runSequence(f,plan,info,coverage)));
    t.diagnostic(`P-01 coverage ${JSON.stringify(Object.fromEntries(Object.entries(coverage).map(([key,value])=>[key,value instanceof Set?[...value]:value])))}`);
    t.diagnostic(`P-04 coverage ${JSON.stringify({transitions:[...coverage.p04.transitions],snapshots:coverage.p04.snapshots,
        sqlAttemptSlots:coverage.p04.sqlAttemptSlots,sqlMutationKinds:[...coverage.p04.sqlMutationKinds],
        clockPeriods:[...coverage.p04.clockPeriods]})}`);
    if(process.env.PROPERTY_SEED===undefined) {
        assert.equal(coverage.operations.size,12);assert.ok([...coverage.createdGroups].every(n=>n>=1&&n<=3));
        assert.ok(coverage.actors.size>=5);assert.ok(coverage.targets.size>=5);assert.equal(coverage.roles.size,2);
        assert.equal(coverage.archived.size,2);assert.ok(coverage.stale.has('stale'));assert.ok(coverage.stale.has('current'));
        assert.ok(coverage.wrongActor>0);assert.ok(coverage.replays>=100);assert.ok(coverage.accepted>0);
        assert.ok(coverage.committedRefusals>0);assert.ok(coverage.ordinaryRefusals>0);
        assert.equal(coverage.p04.snapshots,P01_SEQUENCES*P01_OPERATIONS+coverage.p04.sqlAttemptSlots);
        assert.equal(coverage.p04.sqlAttemptSlots,P01_SEQUENCES*(P01_OPERATIONS/10));
        assert.deepEqual([...coverage.p04.clockPeriods].sort(),[0,1,2,3]);
        for(const state of ['accepted','declined','cancelled'])assert.ok(coverage.p04.transitions.has(`pending->${state}`),`P-04 missing pending->${state}`);
        assert.ok(coverage.p04.sqlMutationKinds.has('pending-id'));assert.ok(coverage.p04.sqlMutationKinds.has('pending-group'));
        assert.ok(coverage.p04.sqlMutationKinds.has('pending-invitee'));assert.ok(coverage.p04.sqlMutationKinds.has('pending-inviter'));
        assert.ok(coverage.p04.sqlMutationKinds.has('pending-created'));assert.ok(coverage.p04.sqlMutationKinds.has('pending-expires'));
        assert.ok(coverage.p04.sqlMutationKinds.has('terminal-update'));assert.ok(coverage.p04.sqlMutationKinds.has('terminal-delete'));
    }
});

test('P-04: at the exact expiry boundary accept commits expired and decline refuses without changing the row',async t=>{
    const f=await httpGroupFixture(t,{clock:createClock(),features:{groupApi:true,
        groups:{directAdd:true,maxMembers:6,maxPendingInvitationsPerGroup:10000,maxPendingInvitationsPerInvitee:10000}}});
    const service=createGroupService({db:f.db,auth:f.application.auth,limiter:openLimiter(),features:{groupApi:true,
        groups:{directAdd:true,maxMembers:6,maxPendingInvitationsPerGroup:10000,maxPendingInvitationsPerInvitee:10000}},now:f.clock.now});
    const owner=makeActorContext(f,f.actors.owner);
    const declinedTarget=f.actors.nonMember;
    const second=service.createInvitation(owner.context,owner.proof,f.groupId,{userId:declinedTarget.id},SOURCE).invitation;
    const firstBefore=f.db.prepare('SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE invitation_id=?').get(f.invitationId);
    const beforeMembership=f.db.prepare('SELECT user_id,role,joined_at,left_at FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id').all(f.groupId);
    const beforeIntervals=f.db.prepare('SELECT user_id,interval_no,first_seq,last_seq,joined_at,left_at FROM GroupMembershipIntervals WHERE conversation_id=? ORDER BY user_id,interval_no').all(f.groupId);
    const beforeRevision=f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(f.groupId).membership_revision;
    f.clock.advance(INVITATION_EXPIRY_MS);

    const inviteeBrowser=f.actors.pendingInvitee.browser;
    assert.equal((await inviteeBrowser.login(f.actors.pendingInvitee.username)).status,200,'reauthenticate the invitee after the 7-day clock jump');
    const invitee=makeActorContext(f,{browser:inviteeBrowser,token:await inviteeBrowser.csrf()});
    const beforeAccept=snapshot(f.db);
    const auditBefore=f.db.prepare("SELECT event_type,actor_user_id,subject_id,metadata_json,created_at FROM AuditLogs WHERE source='groups' AND subject_id=? ORDER BY rowid").all(f.groupId);
    assert.throws(()=>service.acceptInvitation(invitee.context,invitee.proof,f.invitationId),error=>error instanceof AuthError&&
        error.status===409&&error.code==='CONFLICT','expired acceptance is a committed 409 refusal');
    const expiredRow=f.db.prepare('SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE invitation_id=?').get(f.invitationId);
    assert.deepEqual([expiredRow.state,expiredRow.resolved_at],['expired',f.clock.iso()]);
    assert.deepEqual({...expiredRow,state:'pending',resolved_at:null},firstBefore,'expiry preserves all other Invitation columns');
    assert.deepEqual(changedTables(beforeAccept,snapshot(f.db)).sort(),['AuditLogs','ConversationInvitations']);
    assert.deepEqual(f.db.prepare('SELECT user_id,role,joined_at,left_at FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id').all(f.groupId),beforeMembership);
    assert.deepEqual(f.db.prepare('SELECT user_id,interval_no,first_seq,last_seq,joined_at,left_at FROM GroupMembershipIntervals WHERE conversation_id=? ORDER BY user_id,interval_no').all(f.groupId),beforeIntervals);
    assert.equal(f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(f.groupId).membership_revision,beforeRevision);
    const auditAfter=f.db.prepare("SELECT event_type,actor_user_id,subject_id,metadata_json,created_at FROM AuditLogs WHERE source='groups' AND subject_id=? ORDER BY rowid").all(f.groupId);
    assert.equal(auditAfter.length,auditBefore.length+1);
    assert.deepEqual(auditAfter.at(-1),{event_type:'group.invitation.expired',actor_user_id:f.actors.pendingInvitee.id,
        subject_id:f.groupId,metadata_json:'{"operation":"invitation.expired","outcome":"confirmed"}',created_at:f.clock.iso()});

    const declineBrowser=declinedTarget.browser;
    assert.equal((await declineBrowser.login(declinedTarget.username)).status,200,'reauthenticate the invitee after the 7-day clock jump');
    const decliner=makeActorContext(f,{browser:declineBrowser,token:await declineBrowser.csrf()});
    const pendingBefore=f.db.prepare('SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE invitation_id=?').get(second.id);
    const beforeDecline=snapshot(f.db);
    assert.throws(()=>service.declineInvitation(decliner.context,decliner.proof,second.id),error=>error instanceof AuthError&&
        error.status===409&&error.code==='CONFLICT','expired decline is refused as 409');
    assert.deepEqual(f.db.prepare('SELECT invitation_id,conversation_id,invitee_id,inviter_id,state,created_at,expires_at,resolved_at FROM ConversationInvitations WHERE invitation_id=?').get(second.id),pendingBefore);
    assert.deepEqual(snapshot(f.db),beforeDecline,'expired decline rolls back without invitation or audit changes');
});
