const fs=require('node:fs');
const db=require('./db.cjs');
const {resolveStoragePath}=require('../storage/attachmentStorage.cjs');
const days=process.env.ATTACHMENT_PURGE_AFTER_DAYS===undefined?null:Number.parseInt(process.env.ATTACHMENT_PURGE_AFTER_DAYS,10);
if(days!==null&&(!Number.isInteger(days)||days<0)) throw new Error('ATTACHMENT_PURGE_AFTER_DAYS must be a non-negative integer');
const cutoff=days===null?null:new Date(Date.now()-days*86400000).toISOString();
const rows=db.prepare(`SELECT attachment_id,storage_key FROM Attachments
  WHERE (expires_at IS NOT NULL AND expires_at<=?) ${cutoff?'OR (deleted_at IS NOT NULL AND deleted_at<=?)':''}`)
  .all(...(cutoff?[new Date().toISOString(),cutoff]:[new Date().toISOString()]));
const remove=db.prepare('DELETE FROM Attachments WHERE attachment_id=?');
const tx=db.transaction(items=>{
  for(const item of items){
    try{fs.unlinkSync(resolveStoragePath(item.storage_key));}catch(e){if(e.code!=='ENOENT')throw e;}
    remove.run(item.attachment_id);
  }
});
tx(rows);
process.stdout.write(`Purged ${rows.length} expired/deleted attachment(s).\n`);
