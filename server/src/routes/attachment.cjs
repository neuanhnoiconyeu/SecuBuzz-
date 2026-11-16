const express = require('express');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db5db6/db.cjs');
const { requireAuth } = require('../middleware/requireAuth.cjs');
const { storeRequestStream, resolveStoragePath, removeStoredFile } = require('../storage/attachmentStorage.cjs');
const router=express.Router();
router.use(requireAuth);
const now="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const ALLOWED_MIME=new Set(['application/pdf','image/jpeg','image/png','image/gif','text/plain','application/zip','application/octet-stream']);
function fail(res,status,error){return res.status(status).json({error});}
function activeGroupMember(groupId,userId){return db.prepare("SELECT * FROM GroupMembers WHERE group_id=? AND user_id=? AND status='active'").get(groupId,userId);}
function canRead(a,userId){
  if(a.deleted_at || (a.expires_at && Date.parse(a.expires_at)<=Date.now())) return false;
  if(a.uploader_user_id===userId || a.recipient_user_id===userId) return true;
  if(a.group_id){
    const m=activeGroupMember(a.group_id,userId); if(!m) return false;
    const g=db.prepare('SELECT history_visibility FROM Groups WHERE group_id=?').get(a.group_id);
    return !!g && (g.history_visibility==='all' || a.created_at>=m.joined_at);
  }
  return false;
}
function publicMetadata(a){
  const {storage_key,...safe}=a; return safe;
}

// POST /api/attachments?group_id=... OR ?recipient_user_id=...
// Raw request body is streamed to private disk storage; no file bytes are stored in SQLite.
router.post('/',async(req,res)=>{
  const groupId=typeof req.query.group_id==='string'?req.query.group_id:null;
  const recipientId=typeof req.query.recipient_user_id==='string'?req.query.recipient_user_id:null;
  if(Boolean(groupId)===Boolean(recipientId)) return fail(res,400,'Supply exactly one of group_id or recipient_user_id');
  if(groupId){ if(!activeGroupMember(groupId,req.authUserId)) return fail(res,403,'Active group membership required'); }
  else if(!db.prepare('SELECT 1 FROM Users WHERE user_id=?').get(recipientId)) return fail(res,404,'Recipient not found');

  const algorithm=String(req.headers['x-encryption-algorithm']||'').trim()||null;
  const isE2EE=!!algorithm;
  const declaredMime=String(req.headers['content-type']||'application/octet-stream').split(';')[0].toLowerCase();
  if(!isE2EE&&!ALLOWED_MIME.has(declaredMime)) return fail(res,415,'Unsupported file type');
  const rawName=String(req.headers['x-file-name']||'attachment').replace(/[\\/\r\n\0]/g,'_').slice(0,180);
  const fileIv=req.headers['x-file-iv']?String(req.headers['x-file-iv']).slice(0,512):null;
  const fileAuthTag=req.headers['x-file-auth-tag']?String(req.headers['x-file-auth-tag']).slice(0,512):null;
  const metadataCiphertext=req.headers['x-metadata-ciphertext']?String(req.headers['x-metadata-ciphertext']).slice(0,10000):null;
  const metadataIv=req.headers['x-metadata-iv']?String(req.headers['x-metadata-iv']).slice(0,512):null;
  const metadataAuthTag=req.headers['x-metadata-auth-tag']?String(req.headers['x-metadata-auth-tag']).slice(0,512):null;
  if(isE2EE && (!fileIv || !fileAuthTag)) return fail(res,400,'E2EE uploads require x-file-iv and x-file-auth-tag');
  const expiresAt=req.headers['x-expires-at']?String(req.headers['x-expires-at']):null;
  if(expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt)<=Date.now())) return fail(res,400,'x-expires-at must be a future ISO date');

  let stored;
  try { stored=await storeRequestStream(req); }
  catch(error){ return fail(res,error.status||400,error.status===413?'Attachment exceeds configured size limit':error.message||'Upload failed'); }
  const id=randomUUID();
  try {
    db.prepare(`INSERT INTO Attachments(attachment_id,uploader_user_id,recipient_user_id,group_id,original_name,mime_type,size_bytes,sha256,storage_key,encryption_algorithm,file_iv,file_auth_tag,metadata_ciphertext,metadata_iv,metadata_auth_tag,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id,req.authUserId,recipientId,groupId,isE2EE?null:rawName,isE2EE?'application/octet-stream':declaredMime,
      stored.sizeBytes,stored.sha256,stored.storageKey,algorithm,fileIv,fileAuthTag,metadataCiphertext,metadataIv,metadataAuthTag,expiresAt
    );
    const row=db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(id);
    return res.status(201).json(publicMetadata(row));
  } catch(error){ removeStoredFile(stored.storageKey); return fail(res,400,'Could not save attachment metadata; verify the recipient or group'); }
});

// GET /api/files/search?q=... — searches permitted plaintext metadata only; never decrypts E2EE data.
router.get('/search',(req,res)=>{
  const q=typeof req.query.q==='string'?req.query.q.trim():'';
  if(q.length<2||q.length>100) return fail(res,400,'q must be 2–100 characters');
  const like=`%${q.replace(/[\\%_]/g,'\\$&')}%`;
  const rows=db.prepare(`SELECT DISTINCT a.* FROM Attachments a
    LEFT JOIN GroupMembers gm ON gm.group_id=a.group_id AND gm.user_id=? AND gm.status='active'
    WHERE a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?)
      AND (a.uploader_user_id=? OR a.recipient_user_id=? OR gm.user_id IS NOT NULL)
      AND a.original_name IS NOT NULL AND a.original_name LIKE ? ESCAPE '\\'
    ORDER BY a.created_at DESC LIMIT 100`).all(req.authUserId,new Date().toISOString(),req.authUserId,req.authUserId,like);
  return res.json(rows.filter(a=>canRead(a,req.authUserId)).map(publicMetadata));
});


// GET /api/attachments/:id — authorized metadata only.
router.get('/:id',(req,res)=>{
  const a=db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(req.params.id);
  if(!a || !canRead(a,req.authUserId)) return fail(res,404,'Attachment not found');
  return res.json(publicMetadata(a));
});

// GET /api/attachments/:id/download — authorization is checked before opening private storage.
router.get('/:id/download',(req,res)=>{
  const a=db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(req.params.id);
  if(!a || !canRead(a,req.authUserId)) return fail(res,404,'Attachment not found');
  let filePath; try{filePath=resolveStoragePath(a.storage_key);}catch{return fail(res,404,'Attachment data not found');}
  if(!fs.existsSync(filePath)) return fail(res,410,'Attachment data has expired or is missing');
  res.setHeader('Content-Type',a.mime_type);
  res.setHeader('Content-Length',String(a.size_bytes));
  res.setHeader('Cache-Control','private, no-store');
  res.setHeader('X-Content-Type-Options','nosniff');
  const safeName=(a.original_name||'encrypted-attachment').replace(/["\r\n]/g,'_');
  res.setHeader('Content-Disposition',`attachment; filename="${safeName}"`);
  const stream=fs.createReadStream(filePath); stream.on('error',()=>{if(!res.headersSent)res.status(500).end();else res.destroy();}); stream.pipe(res);
});

// DELETE /api/attachments/:id — soft delete; physical cleanup is performed by the retention job.
router.delete('/:id',(req,res)=>{
  const a=db.prepare('SELECT * FROM Attachments WHERE attachment_id=?').get(req.params.id);
  if(!a||a.deleted_at) return fail(res,404,'Attachment not found');
  let allowed=a.uploader_user_id===req.authUserId;
  if(a.group_id){const m=activeGroupMember(a.group_id,req.authUserId); allowed=allowed||!!(m&&(m.role==='owner'||m.role==='admin'));}
  if(!allowed) return fail(res,403,'Not authorized to delete this attachment');
  db.prepare(`UPDATE Attachments SET deleted_at=${now} WHERE attachment_id=?`).run(a.attachment_id);
  return res.status(204).end();
});

module.exports=router;