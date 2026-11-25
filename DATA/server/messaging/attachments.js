const {AuthError}=require('../auth/errors');
const {createSqliteRateLimiter}=require('../auth/rateLimiter');
const {join,dirname,resolve}=require('node:path');
const fs=require('node:fs');
const v=require('./validation');
const fail=(code,status)=>{throw new AuthError(code,status);};
const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(x);
const TTL=7*86400000,MAX_COUNT=5,MAX_TOTAL=100*1024*1024+5*16;

/** DATA owns identity and the metadata ledger; DB6 remains the only binary storage implementation. */
function createEncryptedAttachmentService({db,auth,conversations,options={},limiter=createSqliteRateLimiter(db)}){
    let storage=options.storage,lastCleanup=0;
    const maxBytes=Math.min(Number.parseInt(process.env.MAX_ATTACHMENT_BYTES||String(25*1024*1024),10),50*1024*1024+16);
    function disk(){
        if(!storage){
            if(!options.directory&&!process.env.E2EE_ATTACHMENT_STORAGE_DIR&&(!db.name||db.name===':memory:'))fail('FEATURE_UNAVAILABLE',503);
            storage=require('../../../server/src/storage/attachmentStorage.cjs').createAttachmentStorage({
                directory:options.directory||process.env.E2EE_ATTACHMENT_STORAGE_DIR||join(dirname(resolve(db.name)),'encrypted-attachments'),maxBytes});
        }
        return storage;
    }
    const get=id=>db.prepare('SELECT * FROM Attachments WHERE attachment_id=? AND e2ee_version=1').get(id);
    const files=(cid,mid,actor)=>db.prepare("SELECT * FROM Attachments WHERE e2ee_version=1 AND conversation_id=? AND client_message_id=? AND uploaded_by=? AND status<>'deleted' ORDER BY attachment_id").all(cid,mid,actor);
    const batch=(cid,mid)=>db.prepare('SELECT * FROM EncryptedAttachmentBatches WHERE conversation_id=? AND client_message_id=?').get(cid,mid);
    const message=(cid,mid)=>db.prepare("SELECT * FROM Messages WHERE origin='authenticated' AND conversation_id=? AND client_id=?").get(cid,mid);
    const project=r=>({v:1,id:r.attachment_id,conversationId:r.conversation_id,messageId:r.client_message_id,senderId:r.uploaded_by,ciphertextSize:r.byte_size,sha256:r.ciphertext_sha256});
    function scope(cid,mid,id){v.conversationId(cid);if(!uuid(mid)||(id!==undefined&&!uuid(id)))v.invalid();}
    function checkMessage(cid,mid,actor,version){
        const b=batch(cid,mid),rows=files(cid,mid,actor);
        if(!b&&!rows.length)return;
        if(version!==2||!b||b.uploaded_by!==actor||b.status!=='sealed'||Date.parse(b.expires_at)<=auth.now()||
            JSON.stringify(rows.map(r=>r.attachment_id))!==b.attachment_ids||rows.some(r=>r.status!=='pending'||Date.parse(r.expires_at)<=auth.now()))fail('CONFLICT',409);
    }
    return {
        rate(context,source,write){
            const result=limiter.consume([{key:`attachments:${write?'write':'read'}:${context.userId}`,limit:write?60:240,windowMs:60000},
                ...(write?[{key:`attachments:source:${source}`,limit:240,windowMs:60000}]:[])],auth.now());
            if(!result.allowed){const e=new AuthError('RATE_LIMITED',429);e.retryAfterSeconds=result.retryAfterSeconds;throw e;}
        },
        limits(){return {v:1,maxCiphertextBytes:disk().MAX_BYTES,maxCount:MAX_COUNT};},
        async upload(context,proof,query,request){
            v.query(query,['conversation_id','message_id','id']);const {conversation_id:cid,message_id:mid,id}=query;scope(cid,mid,id);
            const authorize=()=>conversations.withInteraction(context,proof,cid,()=>{
                const old=get(id);if(old&&(old.uploaded_by!==context.userId||old.conversation_id!==cid||old.client_message_id!==mid))fail('NOT_FOUND',404);
                if(old?.status==='deleted')fail('NOT_FOUND',404);
                if(!old&&(batch(cid,mid)||message(cid,mid)))fail('CONFLICT',409);
                const rows=files(cid,mid,context.userId);
                if(!old&&rows.length>=MAX_COUNT)fail('PAYLOAD_TOO_LARGE',413);
                const total=db.prepare("SELECT coalesce(sum(byte_size),0) n FROM Attachments WHERE e2ee_version=1 AND uploaded_by=? AND status='pending'").get(context.userId).n;
                if(!old&&total>=2*MAX_TOTAL)fail('PAYLOAD_TOO_LARGE',413);
                return old;
            });
            authorize();this.cleanup();
            if(Number(request.headers['content-length'])>disk().MAX_BYTES)fail('PAYLOAD_TOO_LARGE',413);
            let saved;
            try{
                saved=await disk().storeRequestStream(request);
                if(saved.sizeBytes<17)fail('VALIDATION_ERROR',400);
                const result=conversations.withInteraction(context,proof,cid,()=>{
                    // The session, CSRF proof, membership and block policy are checked again after streaming.
                    const old=authorize();
                    if(old){if(old.byte_size!==saved.sizeBytes||old.ciphertext_sha256!==saved.sha256)fail('IDEMPOTENCY_CONFLICT',409);return project(old);}
                    const rows=files(cid,mid,context.userId);
                    if(rows.reduce((n,r)=>n+r.byte_size,0)+saved.sizeBytes>MAX_TOTAL)fail('PAYLOAD_TOO_LARGE',413);
                    const staged=db.prepare("SELECT coalesce(sum(byte_size),0) n FROM Attachments WHERE e2ee_version=1 AND uploaded_by=? AND status='pending'").get(context.userId).n;
                    if(staged+saved.sizeBytes>2*MAX_TOTAL)fail('PAYLOAD_TOO_LARGE',413);
                    db.prepare(`INSERT INTO Attachments(attachment_id,conversation_id,uploaded_by,storage_key,byte_size,e2ee_version,client_message_id,ciphertext_sha256,expires_at)
                        VALUES(?,?,?,?,?,1,?,?,?)`).run(id,cid,context.userId,saved.storageKey,saved.sizeBytes,mid,saved.sha256,new Date(auth.now()+TTL).toISOString());
                    return project(get(id));
                });
                if(get(id)?.storage_key===saved.storageKey)saved=null;
                return result;
            }catch(e){if(e.status===413)fail('PAYLOAD_TOO_LARGE',413);throw e;}
            finally{if(saved)disk().removeStoredFile(saved.storageKey);}
        },
        seal(context,proof,cid,mid,body,query){
            scope(cid,mid);v.query(query,[]);
            if(!body||Object.keys(body).join(',')!=='ids'||!Array.isArray(body.ids)||body.ids.length<1||body.ids.length>MAX_COUNT||body.ids.some(id=>!uuid(id))||new Set(body.ids).size!==body.ids.length)v.invalid();
            const ids=[...body.ids].sort();
            return conversations.withInteraction(context,proof,cid,()=>{
                const old=batch(cid,mid);
                if(old){if(old.uploaded_by!==context.userId||old.attachment_ids!==JSON.stringify(ids)||old.status==='revoked'||Date.parse(old.expires_at)<=auth.now())fail('CONFLICT',409);return {sealed:true};}
                if(message(cid,mid))fail('CONFLICT',409);
                const rows=files(cid,mid,context.userId);
                if(JSON.stringify(rows.map(r=>r.attachment_id))!==JSON.stringify(ids)||rows.some(r=>r.status!=='pending'||Date.parse(r.expires_at)<=auth.now()))fail('CONFLICT',409);
                db.prepare("INSERT INTO EncryptedAttachmentBatches VALUES(?,?,?,?,'sealed',?)").run(cid,mid,context.userId,JSON.stringify(ids),new Date(auth.now()+TTL).toISOString());
                return {sealed:true};
            });
        },
        checkMessage,
        attachMessage(cid,mid,actor,storageId){
            if(!batch(cid,mid))return;
            db.prepare("UPDATE Attachments SET message_id=?,status='ready',updated_at=? WHERE e2ee_version=1 AND conversation_id=? AND client_message_id=? AND uploaded_by=? AND status='pending'").run(storageId,new Date(auth.now()).toISOString(),cid,mid,actor);
            db.prepare("UPDATE EncryptedAttachmentBatches SET status='committed' WHERE conversation_id=? AND client_message_id=?").run(cid,mid);
        },
        download(context,id,query){
            if(!uuid(id))v.invalid();v.query(query,[]);
            return db.transaction(()=>{
                const row=get(id);if(!row||row.status!=='ready'||!row.message_id)fail('NOT_FOUND',404);
                conversations.authorizeInTransaction(context,row.conversation_id);
                const m=message(row.conversation_id,row.client_message_id);
                if(!m||m.deleted_at!==null||m.sender_id!==row.uploaded_by||m.message_id!==row.message_id)fail('NOT_FOUND',404);
                const path=disk().resolveStoragePath(row.storage_key);if(!fs.existsSync(path))fail('NOT_FOUND',404);
                return {path,size:row.byte_size};
            }).deferred();
        },
        discard(context,proof,id,query){
            if(!uuid(id))v.invalid();v.query(query,[]);const row=get(id);if(!row)fail('NOT_FOUND',404);
            return conversations.withInteraction(context,proof,row.conversation_id,()=>{
                if(row.uploaded_by!==context.userId)fail('NOT_FOUND',404);
                // A navigation/unmount cleanup cannot race a sealed or possibly committed send.
                if(row.status==='pending'&&!batch(row.conversation_id,row.client_message_id)&&!message(row.conversation_id,row.client_message_id)){
                    db.prepare("UPDATE Attachments SET status='deleted' WHERE attachment_id=?").run(id);
                }
                return {discarded:true};
            });
        },
        cleanup(){
            if(auth.now()-lastCleanup<60000)return;lastCleanup=auth.now();
            const now=new Date(auth.now()).toISOString();
            db.transaction(()=>{
                db.prepare("UPDATE EncryptedAttachmentBatches SET status='revoked' WHERE status='sealed' AND expires_at<=?").run(now);
                db.prepare("UPDATE Attachments SET status='deleted' WHERE e2ee_version=1 AND status='pending' AND expires_at<=?").run(now);
            }).immediate();
            if(!storage&&!db.prepare('SELECT 1 FROM Attachments WHERE e2ee_version=1 LIMIT 1').get())return;
            const store=disk();
            for(const r of db.prepare("SELECT attachment_id,storage_key FROM Attachments WHERE e2ee_version=1 AND status='deleted' AND purged_at IS NULL LIMIT 1000").all()){
                store.removeStoredFile(r.storage_key);db.prepare('UPDATE Attachments SET purged_at=? WHERE attachment_id=?').run(now,r.attachment_id);
            }
            // The DATA namespace is separate from the legacy DB6 ledger. Only old unreferenced UUID files are removed.
            for(const name of fs.readdirSync(store.storageRoot)){
                if(!/^[0-9a-f-]{36}(\.part)?$/.test(name))continue;
                const path=join(store.storageRoot,name);
                try{
                    const stat=fs.lstatSync(path);
                    if(stat.isFile()&&stat.mtimeMs<auth.now()-TTL&&!db.prepare('SELECT 1 FROM Attachments WHERE storage_key=?').get(name))fs.unlinkSync(path);
                }catch(error){if(error.code!=='ENOENT')throw error;}
            }
        },
    };
}
module.exports={createEncryptedAttachmentService};
