const express = require('express');
const { randomUUID } = require('node:crypto');
const db = require('../db5db6/db.cjs');
const { requireAuth } = require('../middleware/requireAuth.cjs');
const router = express.Router();
router.use(requireAuth);
const now = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function member(groupId, userId) {
  return db.prepare("SELECT * FROM GroupMembers WHERE group_id=? AND user_id=? AND status='active'").get(groupId, userId);
}
function groupExists(id) { return !!db.prepare('SELECT 1 FROM Groups WHERE group_id=?').get(id); }
function canManage(m) { return !!m && (m.role === 'owner' || m.role === 'admin'); }
function fail(res, status, error) { return res.status(status).json({ error }); }
function audit(actor, event, summary) {
  try { db.prepare(`INSERT INTO SecurityLogs(log_id,actor_user_id,event_type,severity,summary,source)
    VALUES(?,?,?,'info',?,'groups-api')`).run(randomUUID(), actor, event, summary); } catch {}
}

// POST /api/groups — create a group; creator becomes owner.
router.post('/', (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  const description = req.body.description == null ? null : String(req.body.description).trim();
  if (!name || name.length > 100 || (description && description.length > 1000)) return fail(res, 400, 'name (1–100 chars) and description (max 1000 chars) are required/invalid');
  const id = randomUUID();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO Groups(group_id,name,description,created_by) VALUES(?,?,?,?)').run(id,name,description,req.authUserId);
    db.prepare("INSERT INTO GroupMembers(group_id,user_id,role,status) VALUES(?,?,'owner','active')").run(id,req.authUserId);
  });
  try { tx(); audit(req.authUserId,'group.created',`Created group ${id}`); return res.status(201).json(db.prepare('SELECT * FROM Groups WHERE group_id=?').get(id)); }
  catch (e) { return fail(res, 400, 'Could not create group; verify the authenticated user exists'); }
});

// GET /api/groups — only groups of which the caller is an active member.
router.get('/', (req,res) => {
  res.json(db.prepare(`SELECT g.*, gm.role, gm.joined_at FROM Groups g
    JOIN GroupMembers gm ON gm.group_id=g.group_id
    WHERE gm.user_id=? AND gm.status='active' ORDER BY g.updated_at DESC`).all(req.authUserId));
});

// GET /api/groups/:id — active members only.
router.get('/:id', (req,res) => {
  if (!member(req.params.id,req.authUserId)) return fail(res,404,'Group not found');
  return res.json(db.prepare('SELECT * FROM Groups WHERE group_id=?').get(req.params.id));
});

// PATCH /api/groups/:id — owner controls group settings/history policy.
router.patch('/:id', (req,res) => {
  const m = member(req.params.id,req.authUserId);
  if (!m || m.role !== 'owner') return fail(res,403,'Only the group owner can update group settings');
  const fields = {};
  if (req.body.name !== undefined) {
    if (typeof req.body.name !== 'string' || !req.body.name.trim() || req.body.name.trim().length>100) return fail(res,400,'Invalid group name');
    fields.name=req.body.name.trim();
  }
  if (req.body.description !== undefined) {
    if (req.body.description !== null && (typeof req.body.description !== 'string' || req.body.description.length>1000)) return fail(res,400,'Invalid description');
    fields.description=req.body.description;
  }
  if (req.body.history_visibility !== undefined) {
    if (!['all','from_joined'].includes(req.body.history_visibility)) return fail(res,400,"history_visibility must be 'all' or 'from_joined'");
    fields.history_visibility=req.body.history_visibility;
  }
  const keys=Object.keys(fields); if (!keys.length) return fail(res,400,'No supported fields supplied');
  const sql=keys.map(k=>`${k}=?`).join(', ');
  db.prepare(`UPDATE Groups SET ${sql}, updated_at=${now} WHERE group_id=?`).run(...keys.map(k=>fields[k]),req.params.id);
  return res.json(db.prepare('SELECT * FROM Groups WHERE group_id=?').get(req.params.id));
});

// GET /api/groups/:id/members — active members; managers can also inspect removed records.
router.get('/:id/members',(req,res)=>{
  const m=member(req.params.id,req.authUserId); if(!m) return fail(res,404,'Group not found');
  const statusClause=canManage(m) ? '' : "AND gm.status='active'";
  return res.json(db.prepare(`SELECT gm.group_id,gm.user_id,gm.role,gm.status,gm.joined_at,gm.removed_at,u.username,u.display_name
    FROM GroupMembers gm JOIN Users u ON u.user_id=gm.user_id WHERE gm.group_id=? ${statusClause} ORDER BY gm.joined_at`).all(req.params.id));
});

// POST /api/groups/:id/members — owner/admin can directly add a user as a member or admin.
router.post('/:id/members',(req,res)=>{
  const actor=member(req.params.id,req.authUserId); if(!actor || !canManage(actor)) return fail(res,403,'Owner/admin permission required');
  const userId=req.body.user_id; const role=req.body.role || 'member';
  if(typeof userId!=='string' || !userId || !['member','admin'].includes(role)) return fail(res,400,'user_id and role member/admin are required');
  if(!db.prepare('SELECT 1 FROM Users WHERE user_id=?').get(userId)) return fail(res,404,'User not found');
  const existing=db.prepare('SELECT * FROM GroupMembers WHERE group_id=? AND user_id=?').get(req.params.id,userId);
  if(existing && existing.status==='active') return fail(res,409,'User is already an active member');
  if(existing) db.prepare(`UPDATE GroupMembers SET role=?,status='active',joined_at=${now},removed_at=NULL WHERE group_id=? AND user_id=?`).run(role,req.params.id,userId);
  else db.prepare("INSERT INTO GroupMembers(group_id,user_id,role,status) VALUES(?,?,?,'active')").run(req.params.id,userId,role);
  audit(req.authUserId,'group.member_added',`Added user ${userId} to group ${req.params.id}`);
  return res.status(201).json(member(req.params.id,userId));
});

// DELETE /api/groups/:id/members/:userId — owner can remove anyone except self; admin can remove members only.
router.delete('/:id/members/:userId',(req,res)=>{
  const actor=member(req.params.id,req.authUserId); if(!actor || !canManage(actor)) return fail(res,403,'Owner/admin permission required');
  const target=member(req.params.id,req.params.userId); if(!target) return fail(res,404,'Active member not found');
  if(target.role==='owner') return fail(res,409,'Transfer ownership before removing the owner');
  if(actor.role==='admin' && target.role!=='member') return fail(res,403,'Admins can remove members only');
  db.prepare(`UPDATE GroupMembers SET status='removed',removed_at=${now} WHERE group_id=? AND user_id=?`).run(req.params.id,req.params.userId);
  audit(req.authUserId,'group.member_removed',`Removed user ${req.params.userId} from group ${req.params.id}`);
  return res.status(204).end();
});

// POST /api/groups/:id/leave — owner must transfer ownership first.
router.post('/:id/leave',(req,res)=>{
  const m=member(req.params.id,req.authUserId); if(!m) return fail(res,404,'Active membership not found');
  if(m.role==='owner') return fail(res,409,'Transfer ownership before leaving the group');
  db.prepare(`UPDATE GroupMembers SET status='removed',removed_at=${now} WHERE group_id=? AND user_id=?`).run(req.params.id,req.authUserId);
  audit(req.authUserId,'group.left',`User left group ${req.params.id}`);
  return res.status(204).end();
});

// POST /api/groups/:id/invitations — creates a pending invitation; recipient must accept.
router.post('/:id/invitations',(req,res)=>{
  const actor=member(req.params.id,req.authUserId); if(!actor || !canManage(actor)) return fail(res,403,'Owner/admin permission required');
  const target=req.body.user_id;
  if(typeof target!=='string' || !db.prepare('SELECT 1 FROM Users WHERE user_id=?').get(target)) return fail(res,404,'Invitee not found');
  if(member(req.params.id,target)) return fail(res,409,'User is already a member');
  const id=randomUUID();
  try {
    db.prepare("INSERT INTO GroupInvitations(invitation_id,group_id,invited_user_id,invited_by_user_id) VALUES(?,?,?,?)").run(id,req.params.id,target,req.authUserId);
    return res.status(201).json(db.prepare('SELECT * FROM GroupInvitations WHERE invitation_id=?').get(id));
  } catch { return fail(res,409,'A pending invitation may already exist'); }
});

router.get('/invitations/me',(req,res)=>res.json(db.prepare("SELECT i.*,g.name AS group_name FROM GroupInvitations i JOIN Groups g ON g.group_id=i.group_id WHERE i.invited_user_id=? AND i.status='pending' ORDER BY i.created_at DESC").all(req.authUserId)));
router.post('/invitations/:invitationId/accept',(req,res)=>{
  const tx=db.transaction(()=>{
    const i=db.prepare("SELECT * FROM GroupInvitations WHERE invitation_id=? AND invited_user_id=? AND status='pending'").get(req.params.invitationId,req.authUserId);
    if(!i) return null;
    const existing=db.prepare('SELECT * FROM GroupMembers WHERE group_id=? AND user_id=?').get(i.group_id,req.authUserId);
    if(existing) db.prepare(`UPDATE GroupMembers SET role='member',status='active',joined_at=${now},removed_at=NULL WHERE group_id=? AND user_id=?`).run(i.group_id,req.authUserId);
    else db.prepare("INSERT INTO GroupMembers(group_id,user_id,role,status) VALUES(?,?,'member','active')").run(i.group_id,req.authUserId);
    db.prepare(`UPDATE GroupInvitations SET status='accepted',responded_at=${now} WHERE invitation_id=?`).run(i.invitation_id);
    return {group_id:i.group_id};
  });
  const result=tx(); return result ? res.json({accepted:true,group_id:result.group_id}) : fail(res,404,'Pending invitation not found');
});
router.post('/invitations/:invitationId/decline',(req,res)=>{
  const changed=db.prepare(`UPDATE GroupInvitations SET status='declined',responded_at=${now} WHERE invitation_id=? AND invited_user_id=? AND status='pending'`).run(req.params.invitationId,req.authUserId).changes;
  return changed ? res.json({declined:true}) : fail(res,404,'Pending invitation not found');
});

// POST /api/groups/:id/transfer — only owner can transfer to an active member.
router.post('/:id/transfer',(req,res)=>{
  const newOwner=req.body.new_owner_user_id;
  const tx=db.transaction(()=>{
    const owner=member(req.params.id,req.authUserId);
    if(!owner || owner.role!=='owner') return {error:'Only the owner can transfer ownership',status:403};
    const target=member(req.params.id,newOwner);
    if(!target) return {error:'New owner must be an active group member',status:400};
    db.prepare("UPDATE GroupMembers SET role='admin' WHERE group_id=? AND user_id=?").run(req.params.id,req.authUserId);
    db.prepare("UPDATE GroupMembers SET role='owner' WHERE group_id=? AND user_id=?").run(req.params.id,newOwner);
    return {ok:true};
  });
  const result=tx(); if(result.error) return fail(res,result.status,result.error);
  audit(req.authUserId,'group.owner_transferred',`Transferred group ${req.params.id} to ${newOwner}`);
  return res.json({transferred:true,new_owner_user_id:newOwner});
});

// Group messages reuse the existing Messages table. Removed members cannot read or send.
router.get('/:id/messages',(req,res)=>{
  const m=member(req.params.id,req.authUserId); if(!m) return fail(res,404,'Group not found');
  const limit=Math.min(Math.max(Number.parseInt(req.query.limit||'100',10)||100,1),500);
  const group=db.prepare('SELECT history_visibility FROM Groups WHERE group_id=?').get(req.params.id);
  const since=group.history_visibility==='from_joined' ? m.joined_at : '0000-01-01T00:00:00Z';
  return res.json(db.prepare('SELECT * FROM Messages WHERE group_id=? AND created_at>=? ORDER BY created_at ASC LIMIT ?').all(req.params.id,since,limit));
});
router.post('/:id/messages',(req,res)=>{
  if(!member(req.params.id,req.authUserId)) return fail(res,403,'Active group membership required');
  const {ciphertext,iv,auth_tag=null,algorithm='AES-256-GCM'}=req.body;
  if(typeof ciphertext!=='string'||!ciphertext||ciphertext.length>2_000_000||typeof iv!=='string'||!iv) return fail(res,400,'Valid ciphertext and iv are required');
  const id=randomUUID();
  db.prepare('INSERT INTO Messages(message_id,sender_id,recipient_id,group_id,ciphertext,iv,auth_tag,algorithm) VALUES(?,?,NULL,?,?,?,?,?)')
    .run(id,req.authUserId,req.params.id,ciphertext,iv,auth_tag,algorithm);
  return res.status(201).json(db.prepare('SELECT * FROM Messages WHERE message_id=?').get(id));
});

module.exports=router;