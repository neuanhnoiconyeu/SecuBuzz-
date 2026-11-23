'use strict';

// Feature: db5-db6-canonical-integration, Property P-01: One active owner after every operation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {AuthError}=require('../server/auth/errors');
const {createGroupService}=require('../server/groups/service');
const {createGroupRepository}=require('../server/database/groupRepository');
const {httpGroupFixture,groupFixture,openLimiter,snapshot,changedTables,createClock,INVITATION_EXPIRY_MS}=require('./support/groups');
const {withMembershipTransaction}=require('../server/database/groupRepository');
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
        role:200,transfer:200,archive:200,add:201,update:200})[op];
}
function stateRows(db,id) {
    let queries=stateQueriesByDatabase.get(db);
    if(!queries) {
        queries={
            conversation:db.prepare('SELECT conversation_id,created_by,title,created_at,updated_at,archived_at FROM Conversations WHERE conversation_id=?'),
            extension:db.prepare('SELECT conversation_id,description,history_policy,membership_revision,created_at FROM GroupExtensions WHERE conversation_id=?'),
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
function retainedGroupCounts(db,id) {
    return Object.fromEntries(['Conversations','ConversationMembers','GroupMembershipIntervals','ConversationInvitations','Messages','MessageReceipts','Attachments']
        .map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id=?`).get(id).n]));
}

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
    if(op==='update') {
        if(!actorRole)return deny(404,'NOT_FOUND');
        if(actorRole!=='owner')return deny(403,'FORBIDDEN');
        if(group.archived)return deny(409,'CONFLICT');
        if(request.membershipRevision!==null&&request.membershipRevision!==undefined&&request.membershipRevision!==revision)
            return deny(409,'STALE_STATE');
        return {status:200,code:null,effect:'update',at,actorId,name:request.name,description:request.description};
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
            name:request.body.name,description:request.body.description,
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
    case 'update':
        if(group.name!==request.name||group.description!==request.description) {
            group.name=request.name;group.description=request.description;group.updatedAt=at;
            addAudit(group,'group.updated',actorId,at);
        }
        return group;
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
    assert.equal(actual.conversation.title,group.name,`${group.label}: name`);
    assert.equal(actual.extension.description,group.description,`${group.label}: description`);
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
        const retainedBefore=group?retainedGroupCounts(f.db,group.id):null;
        const revisionBefore=group?f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(group.id).membership_revision:null;
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
            case 'update': value=service.updateGroup(...args,group.id,request.body??{name:request.name,description:request.description,
                ...(request.membershipRevision===null?{}:{membershipRevision:request.membershipRevision})});break;
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
        if(group) {
            const qualifies=expected.status<400&&['accept','add','remove','leave','role','transfer'].includes(expected.effect);
            const revisionAfter=f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(group.id).membership_revision;
            assert.equal(revisionAfter,revisionBefore+(qualifies?1:0),`${JSON.stringify(failureContext)} P-09 exact revision delta`);
        }
        if(expected.effect==='create') {
            group=applyModel(null,request,expected,value);
            group.clock=f.clock;
            assert.equal(f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(group.id).membership_revision,1,
                `${JSON.stringify(failureContext)} P-09 creation starts at revision 1`);
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
        if(group&&retainedBefore) {
            const retainedAfter=retainedGroupCounts(f.db,group.id);
            for(const [table,count] of Object.entries(retainedBefore))assert.ok(retainedAfter[table]>=count,
                `${JSON.stringify(failureContext)} P-24 ${table} row count decreased`);
        }
        if(expected.status<400||expected.committed) {
            if(group&&expected.effect!=='advance'&&expected.effect!=='create-replay')group.version++;
        }
        if(request.replay)coverage.replays++;
        request.stateVersionAfter=group?.version??0;
        if(request.op!=='update')coverage.operations.add(request.op);if(request.actorClass)coverage.actors.add(request.actorClass);
        if(request.targetClass)coverage.targets.add(request.targetClass);
        if(request.newRole)coverage.roles.add(request.newRole);if(group)coverage.archived.add(group.archived);
        if(request.revisionMode)coverage.stale.add(request.revisionMode);
        if(request.wrongActor)coverage.wrongActor++;
        return {group,expected,value};
    }
    async function runP09Checks(group,operationIndex) {
        const owner=actors[group.ownerId];
        const targetId=USER_CLASSES.map(name=>f.actors[name].id).find(id=>id!==group.ownerId&&!group.members.get(id)?.active);
        assert.ok(owner,`P-09 fixture lacks owner session for ${group.label}`);
        assert.ok(targetId,`P-09 fixture lacks an eligible non-member for ${group.label}`);
        const targetClass=USER_CLASSES.find(name=>f.actors[name].id===targetId);
        // Establish both a committed removal and rejoin so each qualifying transition is checked from a real prior revision.
        for(const [op,index] of [['add',0],['remove',1],['add',2]]) {
            const request={op,group,clock:f.clock,actorId:owner.id,actorClass:'owner',sessionExpiresAt:owner.expiresAt,
                targetId,targetClass,index:operationIndex+index};
            if(op==='add')coverage.p09.operations.add(group.members.has(targetId)&&!group.members.get(targetId).active?'rejoin':'direct-add');
            const before=group.revision;
            const outcome=await runRequest(request,info.random,sequence,operationIndex+index);
            assert.equal(outcome.expected.effect,op,`P-09 setup ${op} must commit`);
            assert.equal(group.revision,before+1,`P-09 setup ${op} must increment revision exactly once`);
        }
        // Across each 15-request block exactly one request carries a current, stale, or future precondition.
        const modes=['none','none','none','none','current','none','none','none','none','stale','none','none','none','none','future'];
        for(let index=0;index<modes.length;index++) {
            const mode=modes[index];
            const revision=mode==='current'?group.revision:mode==='stale'?(group.revision>1?group.revision-1:group.revision+2):mode==='future'?group.revision+1:null;
            const request={op:'update',group,clock:f.clock,actorId:owner.id,actorClass:'owner',sessionExpiresAt:owner.expiresAt,
                name:group.name,description:`P09 ${info.run} update ${index}`,membershipRevision:revision,revisionMode:mode,index:operationIndex+3+index};
            coverage.p09.requests++;
            if(mode!=='none')coverage.p09.preconditions.add(mode);
            await runRequest(request,info.random,sequence,operationIndex+3+index);
            assertGroupState(f,repository,group);
        }
        const directRevision=group.revision;
        const revisionStatement=f.db.prepare('UPDATE GroupExtensions SET membership_revision=? WHERE conversation_id=?');
        const beforeNoOp=snapshot(f.db);
        assert.equal(revisionStatement.run(directRevision,group.id).changes,1,'P-09 same-value assignment is a permitted no-op');
        assert.deepEqual(snapshot(f.db),beforeNoOp,'P-09 same-value assignment leaves revision state unchanged');
        coverage.p09.noopAssignments++;
        for(const attempted of [directRevision+2,directRevision-1,directRevision+0.5]) {
            assert.throws(()=>revisionStatement.run(attempted,group.id),/group_extension_immutable|constraint/i,
                `P-09 trigger must reject direct revision ${attempted}`);
            assert.equal(f.db.prepare('SELECT membership_revision FROM GroupExtensions WHERE conversation_id=?').get(group.id).membership_revision,
                directRevision,'P-09 rejected direct revision update leaves the database value unchanged');
            coverage.p09.directSqlAttempts++;
        }
    }
    async function runP24Checks(group,operationIndex) {
        const owner=actors[group.ownerId];assert.ok(owner,'P-24 fixture owner session');
        const tableNames=['Conversations','ConversationMembers','GroupMembershipIntervals','ConversationInvitations','Messages','MessageReceipts','Attachments'];
        const counts=()=>Object.fromEntries(tableNames.map(table=>[table,f.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE conversation_id=?`).get(group.id).n]));
        const runArchived=(op,extra={})=>runRequest({op,group,clock:f.clock,actorId:owner.id,actorClass:'owner',sessionExpiresAt:owner.expiresAt,
            targetId:extra.targetId,targetClass:extra.targetClass||'nonMember',newRole:extra.newRole||'member',membershipRevision:null,revisionMode:'none',
            body:extra.body,index:operationIndex++,...extra},info.random,sequence,operationIndex);
        const assertNondecreasing=before=>{const after=counts();for(const name of tableNames)assert.ok(after[name]>=before[name],
            `P-24 ${name} rows decreased in archived sequence ${info.run}`);return after;};
        let prior=counts();
        const active=[...group.members.entries()].filter(([id,row])=>id!==group.ownerId&&row.active);
        assert.ok(active.length,'P-24 requires another active member');
        const target=active[0][0];
        let outsider=USER_CLASSES.map(name=>f.actors[name].id).find(id=>!roleOf(group,id));
        assert.ok(outsider,'P-24 requires a non-member target');
        for(const [op,extra] of [['add',{targetId:outsider}],['invite',{targetId:outsider}],['role',{targetId:target,newRole:'member'}],
            ['transfer',{targetId:target}],['update',{body:{name:'archived update'}}],['update',{body:{description:'archived description'}}],
            ['update',{body:{historyPolicy:'all'}}],['archive',{}]]) {
            const result=await runArchived(op,extra);assert.equal(result.expected.status,409,`P-24 archived ${op} is a conflict`);
            prior=assertNondecreasing(prior);
        }
        const beforeRead=groupSnapshot(f,group),readCounts=counts();
        assert.equal(service.getGroup(owner.context,group.id).archived,true,'P-24 metadata remains readable and archived');
        assert.ok(service.listMembers(owner.context,group.id,{}).items.length>0,'P-24 member list remains readable');
        assert.deepEqual(groupSnapshot(f,group),beforeRead,'P-24 allowed reads are read-only');assert.deepEqual(counts(),readCounts);
        const beforeLeave=counts(),leaver=active.find(([id])=>id!==target)?.[0]||target,actor=actors[leaver];
        assert.ok(actor&&group.members.get(leaver).active&&group.members.get(leaver).role!=='owner');
        const left=await runRequest({op:'leave',group,clock:f.clock,actorId:leaver,actorClass:actor.actorClass,sessionExpiresAt:actor.expiresAt,
            index:operationIndex++},info.random,sequence,operationIndex);
        assert.equal(left.expected.status,204,'P-24 leave remains allowed');assertNondecreasing(beforeLeave);
        const routeBrowser=f.browser(),routeUser=`p24-route-${info.run}`;
        assert.equal((await routeBrowser.register(routeUser,{displayName:'P-24 route probe'})).status,201);
        assert.equal((await routeBrowser.login(routeUser)).status,200,'P-24 uses an independent authenticated account for absent-route checks');
        for(const [method,path] of [['DELETE',`/api/groups/${group.id}`],['POST',`/api/groups/${group.id}/unarchive`],['POST',`/api/groups/${group.id}/restore`]]) {
            const response=await routeBrowser.request(path,{method,headers:{'X-CSRF-Token':await routeBrowser.csrf()}});
            assert.equal(response.status,404,`P-24 ${method} ${path} stays absent`);assert.equal(response.body.code,'NOT_FOUND');
        }
        coverage.p24.sequences++;coverage.p24.refusedWrites+=8;coverage.p24.absentRoutes+=3;
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
                    if(generated.forceOwner&&group)actor=actors[group.ownerId];
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
                if(sequenceIndex===10&&request.op==='archive') {
                    const archiveGroup=groups[0];
                    if(![...archiveGroup.members.entries()].some(([id,row])=>id!==archiveGroup.ownerId&&row.active)) {
                        const targetId=USER_CLASSES.map(name=>f.actors[name].id).find(id=>id!==archiveGroup.ownerId&&!roleOf(archiveGroup,id));
                        assert.ok(targetId,'P-24 setup can add an active non-owner before archive');
                        const owner=actors[archiveGroup.ownerId];
                        await runRequest({op:'add',group:archiveGroup,clock:f.clock,actorId:owner.id,actorClass:owner.actorClass,
                            sessionExpiresAt:owner.expiresAt,targetId,targetClass:USER_CLASSES.find(name=>f.actors[name].id===targetId),
                            membershipRevision:null,revisionMode:'none',index:P01_OPERATIONS+info.run*20-1},info.random,sequence,P01_OPERATIONS+info.run*20-1);
                    }
                }
                const saved={...request,versionAtRequest:request.group?.version??0};
                const outcome=await runRequest(request,random,sequence,sequenceIndex);
                if(sequenceIndex===0&&outcome.expected.effect==='create')await runP09Checks(outcome.group,P01_OPERATIONS+sequenceIndex*20);
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
                if(sequenceIndex===10) {
                    const archived=groups.find(item=>item.archived);
                    assert.ok(archived?.archived,`P-24 archive commits after step 10 in sequence ${info.run}`);
                    await runP24Checks(archived,P01_OPERATIONS+info.run*20);
                }
            }
    coverage.createdGroups.add(groups.length);
    assert.ok(groups.length>=1&&groups.length<=maxGroups,`sequence ${info.run} used ${groups.length} groups (max ${maxGroups})`);
}

test('P-01: generated operation sequences preserve the owner and group state model',{timeout:240000},async t=>{
    const coverage={operations:new Set(),actors:new Set(),targets:new Set(),roles:new Set(),archived:new Set(),stale:new Set(),wrongActor:0,replays:0,
        accepted:0,committedRefusals:0,ordinaryRefusals:0,createdGroups:new Set(),p24:{sequences:0,refusedWrites:0,absentRoutes:0},p09:{requests:0,directSqlAttempts:0,noopAssignments:0,preconditions:new Set(),operations:new Set()},p04:{transitions:new Set(),snapshots:0,
            sqlAttemptSlots:0,sqlMutationKinds:new Set(),clockPeriods:new Set()}};
    await forAll('P-01',{runs:P01_SEQUENCES,seed:P01_SEED,onRun:line=>t.diagnostic(line),describe:describeSequence},
        (random,info)=>{const maxGroups=1+random.int(0,2);return Array.from({length:P01_OPERATIONS},(_,index)=>({
            op:index===0?'create':index===10?'archive':random.weighted(index<10?OP_WEIGHTS.filter(([op])=>op!=='archive'):OP_WEIGHTS),forceOwner:index===10,
            actorClass:random.pick(USER_CLASSES),targetClass:random.pick(USER_CLASSES),newRole:random.pick(['admin','member']),
            revisionMode:random.weighted([['none',0.55],['current',0.2],['stale',0.25]]),
            maxGroups,groupSlot:index===10?0:random.int(0,2),replay:index===10?false:random.bool(0.2),advanceMs:index<10?0:random.int(0,3)*INVITATION_EXPIRY_MS,
            wrongActor:index===10?false:random.bool(0.2),run:info.run,index
        }));},async(plan,info)=>withIsolatedSequenceFixture(f=>runSequence(f,plan,info,coverage)));
    t.diagnostic(`P-01 coverage ${JSON.stringify(Object.fromEntries(Object.entries(coverage).map(([key,value])=>[key,value instanceof Set?[...value]:value])))}`);
    t.diagnostic(`P-04 coverage ${JSON.stringify({transitions:[...coverage.p04.transitions],snapshots:coverage.p04.snapshots,
        sqlAttemptSlots:coverage.p04.sqlAttemptSlots,sqlMutationKinds:[...coverage.p04.sqlMutationKinds],
        clockPeriods:[...coverage.p04.clockPeriods]})}`);
    t.diagnostic(`P-09 coverage ${JSON.stringify({generatedUpdates:coverage.p09.requests,directSqlAttempts:coverage.p09.directSqlAttempts,
        noopAssignments:coverage.p09.noopAssignments,operations:[...coverage.p09.operations],preconditions:[...coverage.p09.preconditions]})}`);
    t.diagnostic(`P-24 coverage ${JSON.stringify(coverage.p24)}`);
    if(process.env.PROPERTY_SEED===undefined) {
        assert.equal(coverage.operations.size,12);assert.ok([...coverage.createdGroups].every(n=>n>=1&&n<=3));
        assert.ok(coverage.actors.size>=5);assert.ok(coverage.targets.size>=5);assert.equal(coverage.roles.size,2);
        assert.equal(coverage.archived.size,2);assert.ok(coverage.stale.has('stale'));assert.ok(coverage.stale.has('current'));
        assert.ok(coverage.wrongActor>0);assert.ok(coverage.replays>=100);assert.ok(coverage.accepted>0);
        assert.ok(coverage.committedRefusals>0);assert.ok(coverage.ordinaryRefusals>0);
        assert.equal(coverage.p04.snapshots,P01_SEQUENCES*P01_OPERATIONS+coverage.p04.sqlAttemptSlots);
        assert.equal(coverage.p04.sqlAttemptSlots,P01_SEQUENCES*(P01_OPERATIONS/10));
        assert.deepEqual([...coverage.p04.clockPeriods].sort(),[0,1,2,3]);
        assert.equal(coverage.p09.requests,P01_SEQUENCES*15);assert.equal(coverage.p09.directSqlAttempts,P01_SEQUENCES*3);
        assert.equal(coverage.p09.noopAssignments,P01_SEQUENCES);
        assert.deepEqual(coverage.p24,{sequences:P01_SEQUENCES,refusedWrites:P01_SEQUENCES*8,absentRoutes:P01_SEQUENCES*3});
        assert.deepEqual([...coverage.p09.operations].sort(),['direct-add','rejoin']);
        assert.deepEqual([...coverage.p09.preconditions].sort(),['current','future','stale']);
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

// P-10 keeps an independent interval history. Each run has its own migrated disposable database.
const P10_RUNS=100,P10_EVENTS=50,P10_SEED=0x5c100027;
function intervalRows(db,id) {
    return db.prepare('SELECT conversation_id,user_id,interval_no,first_seq,last_seq,joined_at,left_at FROM GroupMembershipIntervals WHERE conversation_id=? ORDER BY user_id,interval_no').all(id);
}
function membershipRows(db,id) {
    return db.prepare('SELECT conversation_id,user_id,role,joined_at,left_at FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id').all(id);
}
function assertP10State(f,repository,model,memberModel,closedSeen,coverage,expectedHighWater) {
    const actual=intervalRows(f.db,f.groupId);
    const expected=[...model.values()].flat().sort((a,b)=>a.user_id.localeCompare(b.user_id)||a.interval_no-b.interval_no);
    assert.deepEqual(actual,expected,'P-10 persisted intervals equal the independent history model');
    const actualMembers=membershipRows(f.db,f.groupId);
    const expectedMembers=[...memberModel.values()].sort((a,b)=>a.user_id.localeCompare(b.user_id));
    assert.deepEqual(actualMembers,expectedMembers,'P-10 persisted membership joined_at/left_at match the independent model');
    for(const [user,intervals] of model) {
        assert.deepEqual(intervals.map(row=>row.interval_no),intervals.map((_,index)=>index+1),`P-10 interval numbering for ${user}`);
        for(let index=1;index<intervals.length;index++)assert.ok(intervals[index].first_seq>intervals[index-1].last_seq,
            `P-10 ordered disjoint intervals for ${user}`);
        const active=memberModel.get(user)?.left_at===null;
        assert.equal(intervals.filter(row=>row.left_at===null&&row.last_seq===null).length,active?1:0,`P-10 open interval count for ${user}`);
    }
    for(const [key,row] of closedSeen)assert.deepEqual(actual.find(item=>`${item.user_id}:${item.interval_no}`===key),row,
        `P-10 closed interval ${key} is immutable`);
    for(const row of actual)if(row.left_at!==null)closedSeen.set(`${row.user_id}:${row.interval_no}`,row);
    const report=repository.invariantReport(f.groupId);
    assert.equal(report.openIntervals,report.activeMembers,'P-10 repository open interval invariant');
    assert.equal(report.mismatches,0,'P-10 repository invariant report');
    assert.equal(repository.repositories.messages.highWater(f.groupId),expectedHighWater,'P-10 persisted message high-water equals the operation model');
    coverage.snapshots++;
}
function attemptP10SqlMutation(f,repository,kind,coverage,expectedHighWater) {
    const before={intervals:intervalRows(f.db,f.groupId),members:membershipRows(f.db,f.groupId)};
    const active=before.members.find(row=>row.left_at===null);
    const former=f.actors.removedMember.id;
    const closed=before.intervals.filter(row=>row.user_id===former&&row.left_at!==null).at(-1);
    assert.ok(active&&closed,`P-10 ${kind} fixture preconditions`);
    if(kind==='second-open')assert.throws(()=>f.db.prepare(`INSERT INTO GroupMembershipIntervals(conversation_id,user_id,interval_no,first_seq,last_seq,joined_at,left_at)
        VALUES(?,?,(SELECT coalesce(max(interval_no),0)+1 FROM GroupMembershipIntervals WHERE conversation_id=?),?,NULL,?,NULL)`)
        .run(f.groupId,active.user_id,f.groupId,expectedHighWater+1,f.clock.iso()),/constraint|group_intervals|invalid_group_interval/i);
    if(kind==='overlap')assert.throws(()=>f.db.prepare(`INSERT INTO GroupMembershipIntervals(conversation_id,user_id,interval_no,first_seq,last_seq,joined_at,left_at)
        VALUES(?,?,(SELECT coalesce(max(interval_no),0)+1 FROM GroupMembershipIntervals WHERE conversation_id=?),?,?,?,?)`)
        .run(f.groupId,former,f.groupId,closed.first_seq,closed.last_seq,f.clock.iso(),f.clock.iso()),/constraint|group_intervals|invalid_group_interval/i);
    if(kind==='closed-edit')assert.throws(()=>f.db.prepare(`UPDATE GroupMembershipIntervals SET first_seq=first_seq+1 WHERE conversation_id=? AND user_id=? AND interval_no=?`)
        .run(f.groupId,former,closed.interval_no),/constraint|group_intervals|invalid_group_interval|group_interval_immutable|group_interval_retained/i);
    if(kind==='closed-delete')assert.throws(()=>f.db.prepare('DELETE FROM GroupMembershipIntervals WHERE conversation_id=? AND user_id=? AND interval_no=?')
        .run(f.groupId,former,closed.interval_no),/constraint|group_intervals|invalid_group_interval|group_interval_immutable|group_interval_retained/i);
    assert.deepEqual({intervals:intervalRows(f.db,f.groupId),members:membershipRows(f.db,f.groupId)},before,`P-10 rejected SQL ${kind} leaves state unchanged`);
    coverage.sqlAttempts++;coverage.mutationKinds.add(kind);
}
test('P-10: generated membership interval histories preserve boundaries, ordering and immutability',{timeout:240000},async t=>{
    const coverage={events:0,snapshots:0,sqlAttempts:0,mutationKinds:new Set(),eventKinds:new Set()};
    const fixed=['message','rejoin','message','remove','join','leave'];
    await forAll('P-10',{runs:P10_RUNS,seed:P10_SEED,onRun:line=>t.diagnostic(line),describe:events=>events.map((event,index)=>`${index}:${event}`)},
        random=>Array.from({length:P10_EVENTS},(_,index)=>fixed[index]||random.weighted([['message',4],['join',2],['rejoin',3],['remove',2],['leave',2]])),
        async(events,info)=>{
            const f=groupFixture(t,{clock:createClock()});
            const id=f.groupId,repository=createGroupRepository(f.db),at=()=>f.clock.iso();
            const model=new Map(),memberModel=new Map(),closedSeen=new Map();let modeledHighWater=0;
            for(const name of ['owner','admin','member']) {
                const user=f.actors[name].id,joined=f.clock.iso();
                memberModel.set(user,{conversation_id:id,user_id:user,role:name==='owner'?'owner':name==='admin'?'admin':'member',joined_at:joined,left_at:null});
                model.set(user,[{conversation_id:id,user_id:user,interval_no:1,first_seq:1,last_seq:null,joined_at:joined,left_at:null}]);
            }
            const former=f.actors.removedMember.id,firstJoined=f.clock.iso(),firstLeft=f.clock.iso();
            memberModel.set(former,{conversation_id:id,user_id:former,role:'member',joined_at:firstJoined,left_at:firstLeft});
            model.set(former,[{conversation_id:id,user_id:former,interval_no:1,first_seq:1,last_seq:0,joined_at:firstJoined,left_at:firstLeft}]);
            const candidates={join:[f.actors.nonMember.id,f.actors.pendingInvitee.id],rejoin:[former],remove:[f.actors.member.id,f.actors.admin.id],leave:[f.actors.member.id,f.actors.admin.id]};
            const runEvent=(kind,user,eventIndex)=>{
                const member=memberModel.get(user),intervals=model.get(user)||[];
                if(kind==='message') {
                    const seq=modeledHighWater+1,stamp=at();
                    f.repositories.messages.insertAuthenticated({message_id:`p10-${info.run}-${seq}`,conversation_id:id,sender_id:f.actors.owner.id,receiver_id:null,
                        ciphertext:'opaque ciphertext',iv:'opaque-iv',envelope_version:1,encoding:'base64',sender_name:'Group Owner',client_timestamp:stamp,
                        message_type:'text',fingerprint:'a'.repeat(64),client_id:`p10-client-${info.run}-${seq}`,message_seq:seq,created_at:stamp});
                    modeledHighWater=seq;
                } else if(kind==='join'||kind==='rejoin') {
                    const stamp=at(),first=modeledHighWater+1;
                    withMembershipTransaction(f.db,()=>{
                        if(kind==='join')repository.addMember(id,user,stamp);else repository.reactivateMember(id,user,stamp);
                        repository.openIntervalAt(id,user,stamp,first);
                    });
                    const row=memberModel.get(user)||{conversation_id:id,user_id:user,role:'member',joined_at:stamp,left_at:null};
                    row.left_at=null;if(kind==='rejoin')row.role='member';memberModel.set(user,row);
                    const rows=intervals.slice();rows.push({conversation_id:id,user_id:user,interval_no:rows.length+1,first_seq:first,last_seq:null,joined_at:stamp,left_at:null});model.set(user,rows);
                } else {
                    const stamp=at(),last=modeledHighWater;
                    try{withMembershipTransaction(f.db,()=>{repository.endMembership(id,user,stamp);repository.closeInterval(id,user,stamp,last);});}
                    catch(error){throw new Error(`P-10 ${kind} at event ${eventIndex} user=${user} modeled=${JSON.stringify(member)} stored=${JSON.stringify(f.repositories.members.get(id,user))}`,{cause:error});}
                    member.left_at=stamp;intervals.at(-1).last_seq=last;intervals.at(-1).left_at=stamp;
                }
            };
            assertP10State(f,repository,model,memberModel,closedSeen,coverage,modeledHighWater);
            for(let index=0;index<events.length;index++) {
                const kind=events[index];let user;
                if(kind==='message')user=f.actors.owner.id;
                else {
                    const forced=index===3?former:(index===4||index===5)?f.actors.nonMember.id:null;
                    const choices=forced?[forced]:(candidates[kind]||[]).filter(candidate=>kind==='join'?!memberModel.has(candidate):kind==='rejoin'?memberModel.has(candidate)&&memberModel.get(candidate).left_at!==null:memberModel.get(candidate)?.left_at===null);
                    const available=choices.length?choices:[];
                    if(!available.length){runEvent('message',f.actors.owner.id,index);coverage.events++;coverage.eventKinds.add('message');}
                    else {user=info.random.pick(available);f.clock.advance(1000);runEvent(kind,user,index);coverage.events++;coverage.eventKinds.add(kind);}
                }
                if(kind==='message'){f.clock.advance(1000);runEvent(kind,user,index);coverage.events++;coverage.eventKinds.add(kind);}
                assertP10State(f,repository,model,memberModel,closedSeen,coverage,modeledHighWater);
                if((index+1)%10===0)attemptP10SqlMutation(f,repository,['second-open','overlap','closed-edit','closed-delete','second-open'][(index+1)/10-1],coverage,modeledHighWater);
            }
        });
    t.diagnostic(`P-10 coverage ${JSON.stringify({events:coverage.events,snapshots:coverage.snapshots,sqlAttempts:coverage.sqlAttempts,mutationKinds:[...coverage.mutationKinds],eventKinds:[...coverage.eventKinds]})}`);
    assert.equal(coverage.events,P10_RUNS*P10_EVENTS);assert.equal(coverage.snapshots,P10_RUNS*(P10_EVENTS+1));
    assert.equal(coverage.sqlAttempts,P10_RUNS*5);assert.deepEqual([...coverage.mutationKinds].sort(),['closed-delete','closed-edit','overlap','second-open']);
    assert.deepEqual([...coverage.eventKinds].sort(),['join','leave','message','rejoin','remove']);
});
