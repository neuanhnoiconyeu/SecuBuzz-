'use strict';

// DB-6B T-6B-23..27. All SQLite access goes through the existing repositories.
// A file is written only after a durable reservation; no transaction crosses storage I/O.
const { randomUUID, createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { createSocialRepository } = require('../database/socialRepository');
const { createGroupRepository } = require('../database/groupRepository');
const { createAttachmentRepository } = require('../database/attachmentRepository');
const { createRepositories, RepositoryError, translate } = require('../database/repositories');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const { AuthError } = require('../auth/errors');
const { createFeatureGate } = require('../features/gate');
const { DISABLED_FEATURES } = require('../features/config');
const { validateHeader, validateAssociationBody, validateSearchQuery, sizeDecision, LIMITS, MESSAGE_LIMITS } = require('./validation');
const { assertStorageProvider, generateStorageKey, StorageError } = require('./storage/provider');
const cursors = require('../groups/cursor');

// Operational read/write values follow DB5-R12/ASM-03. Upload admission is the
// owner-approved configured value (OD-15), never an unreviewed code default.
const ATTACHMENT_RATE_LIMITS = Object.freeze({
    readUser:Object.freeze({limit:120,windowMs:60000}), readSource:Object.freeze({limit:240,windowMs:60000}),
    writeUser:Object.freeze({limit:60,windowMs:60000}), writeSource:Object.freeze({limit:120,windowMs:60000}),
    uploadWindowMs:3600000
});
const AUDIT_SOURCE='attachments';
const AUDIT_UPLOAD='attachment.uploaded';
const MAX_ENCRYPTED_METADATA_BYTES=16384;
const MAX_FILE_BYTES=LIMITS.video*1048576;
const MAX_MESSAGE_ATTACHMENTS=MESSAGE_LIMITS.maxCount;
const MAX_MESSAGE_ATTACHMENT_BYTES=MESSAGE_LIMITS.maxTotalBytes;
const SEARCH_SCAN_SIZE=100;
const notFound=()=>{throw new AuthError('NOT_FOUND',404,[]);};
const conflict=()=>{throw new AuthError('CONFLICT',409,[]);};
const invalid=fields=>{throw new AuthError('VALIDATION_ERROR',400,fields);};
const tooLarge=()=>{throw new AuthError('PAYLOAD_TOO_LARGE',413,[]);};
const serviceUnavailable=()=>{throw new AuthError('SERVICE_UNAVAILABLE',503,[]);};
const internal=()=>{throw new AuthError('INTERNAL_ERROR',500,[]);};

function mapError(error) {
    if (error instanceof AuthError) return error;
    let translated;
    if (error instanceof RepositoryError) translated=error; else translated=translate(error);
    const code=error instanceof StorageError ? error.code : translated.code;
    if (code==='DUPLICATE'||code==='CONFLICT') return new AuthError('CONFLICT',409,[]);
    if (code==='INVALID'||code==='REFERENCE') return new AuthError('VALIDATION_ERROR',400,[]);
    if (['BUSY','UNAVAILABLE','STORAGE_IO','STORAGE_MISSING'].includes(code)) return new AuthError('SERVICE_UNAVAILABLE',503,[]);
    return new AuthError('INTERNAL_ERROR',500,[]);
}
function synchronous(work,args) {
    if (typeof work!=='function'||work.constructor?.name==='AsyncFunction') throw new TypeError('Attachment service work must be synchronous.');
    const result=work(...args);
    if (result&&typeof result.then==='function') throw new TypeError('Attachment service work must be synchronous.');
    return result;
}
function isObject(value) { return value!==null&&typeof value==='object'&&!Array.isArray(value); }
function positive(value) { return Number.isSafeInteger(value)&&value>0; }
function snapshotSettings(settings,features) {
    const source=settings===undefined ? features?.attachments : settings;
    if (!isObject(source)) return Object.freeze({});
    return Object.freeze({...source});
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function createAttachmentService({db,auth,features=DISABLED_FEATURES,storage,limiter,now,settings,logger=console.error}={}) {
    if (!db||typeof db.transaction!=='function'||typeof db.inTransaction!=='boolean') throw new TypeError('createAttachmentService needs an open database connection.');
    if (!auth||typeof auth.checkSession!=='function'||!auth.repository||typeof auth.repository.verifyProof!=='function'||typeof auth.now!=='function') throw new TypeError('createAttachmentService needs the authentication service.');
    assertStorageProvider(storage);
    if (typeof logger!=='function') throw new TypeError('logger must be a function.');
    const gate=createFeatureGate(features);
    const social=createSocialRepository(db);
    const groups=createGroupRepository(db);
    const attachments=createAttachmentRepository(db);
    const repositories=createRepositories(db);
    const bucketLimiter=limiter===undefined?createSqliteRateLimiter(db):limiter;
    if (!bucketLimiter||typeof bucketLimiter.consume!=='function') throw new TypeError('createAttachmentService needs a rate limiter.');
    const clock=now===undefined?auth.now:now;
    if (typeof clock!=='function') throw new TypeError('createAttachmentService needs a clock.');
    const configured=snapshotSettings(settings,features);

    function requireEnabled() { gate.assertEnabled('attachments'); }
    function iso() { return new Date(clock()).toISOString(); }
    function settingsForUse() {
        const required=['pendingTtlSeconds','quotaUserBytes','quotaConversationBytes','maxPendingPerUser','uploadsPerHour',
            'maxConcurrentUploadsPerUser','maxConcurrentUploadsPerSource'];
        if (required.some(key=>!positive(configured[key]))) serviceUnavailable();
        return configured;
    }
    function activeSession(context) {
        if (!context||typeof context!=='object') throw new AuthError('UNAUTHENTICATED',401,[]);
        const sessionId=context.sessionId,userId=context.userId;
        const result=auth.checkSession({sessionId,userId});
        if (!result||result.status!=='active') throw new AuthError(result?.status==='expired'?'SESSION_EXPIRED':'UNAUTHENTICATED',401,[]);
        return Object.freeze({sessionId,userId});
    }
    function verifyProof(proof,session) {
        if (!proof||typeof proof!=='object'||proof.type!=='session'||proof.sessionId!==session.sessionId||proof.userId!==session.userId) throw new AuthError('CSRF_INVALID',403,[]);
        const safe=Object.freeze({type:proof.type,sessionId:proof.sessionId,userId:proof.userId,csrfHash:proof.csrfHash});
        try { auth.repository.verifyProof(safe,auth.now()); }
        catch(error) { if (error instanceof RepositoryError&&error.code==='CSRF') throw new AuthError('CSRF_INVALID',403,[]); throw error; }
    }
    function readOnly(work) {
        const before=db.pragma('query_only',{simple:true});
        db.pragma('query_only = ON');
        try { return work(); }
        finally { db.pragma(before?'query_only = ON':'query_only = OFF'); }
    }
    function attachmentRead(context,work) {
        requireEnabled();
        if (db.inTransaction) throw new TypeError('Attachment service transactions cannot be nested.');
        try {
            return social.read(()=>{
                const session=activeSession(context);
                return readOnly(()=>synchronous(work,[session.userId,iso()]));
            });
        } catch(error) { throw mapError(error); }
    }
    function attachmentWrite(context,proof,work) {
        requireEnabled();
        if (db.inTransaction) throw new TypeError('Attachment service transactions cannot be nested.');
        try {
            return social.write(()=>{
                const session=activeSession(context);
                verifyProof(proof,session);
                return synchronous(work,[session.userId,iso()]);
            });
        } catch(error) { throw mapError(error); }
    }
    function consume(buckets) {
        let result;
        try { result=bucketLimiter.consume(buckets,clock()); }
        catch(error) { throw mapError(error); }
        if (!result||result.allowed!==true) {
            const error=new AuthError('RATE_LIMITED',429,[]);
            error.retryAfterSeconds=positive(result?.retryAfterSeconds)?result.retryAfterSeconds:1;
            throw error;
        }
    }
    function rate(operation,context,sourceAddress) {
        if (!context||typeof context.userId!=='string') throw new AuthError('UNAUTHENTICATED',401,[]);
        if (typeof sourceAddress!=='string'||sourceAddress.length===0) throw new TypeError('A trusted request source is required.');
        const digest=sha256(sourceAddress);
        const values=operation==='read'?
            [{key:`attachments:read:${context.userId}`,...ATTACHMENT_RATE_LIMITS.readUser},{key:`attachments:read-source:${digest}`,...ATTACHMENT_RATE_LIMITS.readSource}]:
            [{key:`attachments:write:${context.userId}`,...ATTACHMENT_RATE_LIMITS.writeUser},{key:`attachments:write-source:${digest}`,...ATTACHMENT_RATE_LIMITS.writeSource}];
        consume(values);
    }
    function resolveAccess(actor,conversationId) {
        if (typeof conversationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(conversationId)) notFound();
        const candidate=repositories.conversations.get(conversationId);
        if (candidate&&candidate.kind==='direct'&&candidate.origin==='authenticated'&&
            (candidate.dm_user_low===actor||candidate.dm_user_high===actor)) {
            const recipient=candidate.dm_user_low===actor?candidate.dm_user_high:candidate.dm_user_low;
            if (social.isBlocked(actor,recipient)) notFound();
            const direct=repositories.conversations.getDirectForUser(actor,conversationId);
            if (!direct) notFound();
            if (!social.friendship(actor,recipient)) throw new AuthError('FORBIDDEN',403,[]);
            return {conversation:direct,kind:'direct',member:null};
        }
        const group=groups.getVisibleGroup(conversationId);
        if (!group) notFound();
        const member=groups.getMember(conversationId,actor);
        if (!member||member.left_at!==null||member.user_id!==actor) notFound();
        return {conversation:group,kind:'group',member};
    }
    function assertWritable(access) { if (access.kind==='group'&&access.conversation.archived_at!==null) conflict(); }
    function audit(actor,eventType,attachmentId,metadata,at) {
        if (!db.inTransaction) throw new TypeError('Attachment audit requires the owning transaction.');
        try { repositories.audit.insert({actor_user_id:actor??null,event_type:eventType,source:AUDIT_SOURCE,subject_id:attachmentId,metadata,created_at:at}); }
        catch { internal(); }
    }
    function countedLog(message) { try { logger(message); } catch {} }
    function auditUnavailable(actor,id,reason,at) {
        try { db.transaction(()=>audit(actor,'attachment.download.unavailable',id,{reason_code:reason,target_id:id},at)).immediate(); }
        catch { countedLog('attachment audit failed count=1'); }
    }
    function auditAfterDownload(actor,row) {
        try { db.transaction(()=>audit(actor,'attachment.downloaded',row.attachment_id,
            {operation:'download',outcome:'sent',target_id:row.conversation_id},iso())).immediate(); }
        catch { countedLog('attachment audit failed count=1'); }
    }
    function requireReadyVisibility(row,actor,access) {
        if (typeof row.message_id!=='string') notFound();
        const message=repositories.messages.getAuthenticated(row.message_id);
        if (!message||message.conversation_id!==row.conversation_id) notFound();
        if (access.kind==='group'&&!groups.getPermittedMessage(row.conversation_id,actor,
            access.conversation.history_policy,row.message_id)) notFound();
    }
    function validateUploadHeader(header) {
        const checked=validateHeader(header);
        if (!checked.ok) invalid(checked.fields);
        if (Buffer.byteLength(header.encryptedMetadata,'utf8')>MAX_ENCRYPTED_METADATA_BYTES) invalid(['encryptedMetadata']);
        const decision=sizeDecision(header.byteSize,null);
        if (decision.status===413) tooLarge();
        if (decision.status!==200) invalid(['byteSize']);
        return checked.value;
    }
    function reserve(contextOrActor,proofOrHeader,headerOrSource,maybeSource) {
        let context,proof,header,sourceAddress;
        if(arguments.length===2) {
            const actor=contextOrActor;
            context=actor&&actor.context?actor.context:actor;
            proof=actor&&(actor.csrfProof||actor.proof);
            header=proofOrHeader;
            sourceAddress=actor&&actor.sourceAddress;
        } else { context=contextOrActor;proof=proofOrHeader;header=headerOrSource;sourceAddress=maybeSource; }
        return attachmentWrite(context,proof,(actor,at)=>{
            const access=resolveAccess(actor,header&&header.conversationId);
            assertWritable(access);
            const value=validateUploadHeader(header);
            const options=settingsForUse();
            if (typeof sourceAddress!=='string'||sourceAddress.length===0) throw new TypeError('A trusted request source is required.');
            const sourceDigest=sha256(sourceAddress);
            const reservations=attachments.reservationUsage(at);
            const userReserved=reservations.byUser.find(row=>row.user_id===actor);
            const conversationReserved=reservations.byConversation.find(row=>row.conversation_id===value.conversationId);
            if (attachments.usageForUser(actor)+(userReserved?.bytes||0)+value.byteSize>options.quotaUserBytes||
                attachments.usageForConversation(value.conversationId)+(conversationReserved?.bytes||0)+value.byteSize>options.quotaConversationBytes) {
                throw new AuthError('QUOTA_EXCEEDED',409,[]);
            }
            if (attachments.pendingCountForUser(actor)+(userReserved?.count||0)>=options.maxPendingPerUser) throw new AuthError('QUOTA_EXCEEDED',409,[]);
            const sourceReserved=reservations.bySourceDigest.find(row=>row.source_digest===sourceDigest);
            if ((userReserved?.count||0)>=options.maxConcurrentUploadsPerUser||
                (sourceReserved?.count||0)>=options.maxConcurrentUploadsPerSource) {
                const error=new AuthError('RATE_LIMITED',429,[]);error.retryAfterSeconds=1;throw error;
            }
            consume([
                {key:`attachments:write:${actor}`,...ATTACHMENT_RATE_LIMITS.writeUser},
                {key:`attachments:write-source:${sourceDigest}`,...ATTACHMENT_RATE_LIMITS.writeSource},
                {key:`attachments:upload:${actor}`,limit:options.uploadsPerHour,windowMs:ATTACHMENT_RATE_LIMITS.uploadWindowMs}
            ]);
            const reservationId=randomUUID();
            const expiry=new Date(clock()+options.pendingTtlSeconds*1000).toISOString();
            attachments.insertReservation({reservation_id:reservationId,user_id:actor,conversation_id:value.conversationId,
                declared_bytes:value.byteSize,source_digest:sourceDigest,created_at:at,expires_at:expiry});
            return Object.freeze({reservationId,conversationId:value.conversationId,uploaderId:actor,header:Object.freeze({...value})});
        });
    }
    function project(row) {
        return Object.freeze({id:row.attachment_id,conversationId:row.conversation_id,messageId:row.message_id,
            uploadedBy:row.uploaded_by,byteSize:row.byte_size,status:row.status,createdAt:row.created_at,expiresAt:row.expires_at,
            integrityDigest:row.integrity_digest,algorithm:row.declared_algorithm,formatVersion:row.declared_format_version,
            encryptedMetadata:row.encrypted_metadata});
    }
    function finalize(context,proof,reservation,key,stored) {
        return attachmentWrite(context,proof,(actor,at)=>{
            const access=resolveAccess(actor,reservation.conversationId);
            assertWritable(access);
            if (actor!==reservation.uploaderId||stored.byteCount!==reservation.header.byteSize||
                !Number.isSafeInteger(stored.byteCount)||typeof stored.sha256!=='string') invalid([]);
            const options=settingsForUse();
            const row=attachments.insertPending({attachment_id:randomUUID(),conversation_id:reservation.conversationId,
                uploaded_by:actor,storage_key:key,encrypted_metadata:reservation.header.encryptedMetadata,
                byte_size:stored.byteCount,expires_at:new Date(clock()+options.pendingTtlSeconds*1000).toISOString(),
                integrity_digest:stored.sha256,declared_algorithm:reservation.header.algorithm,
                declared_format_version:reservation.header.formatVersion});
            attachments.deleteReservation(reservation.reservationId);
            audit(actor,AUDIT_UPLOAD,row.attachment_id,{operation:'upload',outcome:'created',target_id:reservation.conversationId},at);
            return project(row);
        });
    }
    async function upload(context,proof,header,stream,sourceAddress) {
        let reservation=null,key=null,committed=false;
        let cleanupFailures=0;
        const cleanupLog=()=>{try{logger('attachment cleanup failed count=1');}catch{}};
        try {
            reservation=reserve(context,proof,header,sourceAddress);
            key=generateStorageKey();
            let byteCount=0,overDeclared=false;
            const declaredBytes=reservation.header.byteSize;
            async function* boundedPayload() {
                for await (const item of stream) {
                    const chunk=Buffer.isBuffer(item)?item:Buffer.from(item);
                    const remaining=declaredBytes+1-byteCount;
                    const take=Math.max(0,Math.min(chunk.length,remaining));
                    if (take>0) { byteCount+=take; yield chunk.subarray(0,take); }
                    if (take<chunk.length||byteCount>declaredBytes) { overDeclared=true; return; }
                }
            }
            let stored;
            try { stored=await storage.write(key,Readable.from(boundedPayload()),{maxBytes:declaredBytes}); }
            catch(error) {
                if (overDeclared||error instanceof StorageError&&error.code==='STORAGE_SIZE') {
                    if (declaredBytes>=MAX_FILE_BYTES) tooLarge();
                    invalid([]);
                }
                throw error;
            }
            if (byteCount!==declaredBytes||stored.byteCount!==declaredBytes) {
                if (byteCount>declaredBytes||stored.byteCount>declaredBytes) {
                    if (declaredBytes>=MAX_FILE_BYTES) tooLarge();
                }
                invalid([]);
            }
            const result=finalize(context,proof,reservation,key,stored);
            committed=true;
            return result;
        } catch(error) {
            throw mapError(error);
        } finally {
            if (!committed) {
                if (key!==null) {
                    try { await storage.delete(key); } catch { cleanupFailures++; cleanupLog(); }
                }
                if (reservation!==null) {
                    try { db.transaction(()=>attachments.deleteReservation(reservation.reservationId)).immediate(); }
                    catch { cleanupFailures++; cleanupLog(); }
                }
            }
            void cleanupFailures;
        }
    }
    function metadata(context,id) {
        return attachmentRead(context,(actor,at)=>{
            if (typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(id)) notFound();
            const row=attachments.getById(id);
            if (!row||!['pending','ready'].includes(row.status)) notFound();
            const access=resolveAccess(actor,row.conversation_id);
            if (row.status==='pending'&&(row.uploaded_by!==actor||row.expires_at<=at)) notFound();
            if (row.status==='ready') requireReadyVisibility(row,actor,access);
            return project(row);
        });
    }

    function writeArguments(contextOrActor,proofOrValue,maybeValue) {
        if (maybeValue!==undefined) return {context:contextOrActor,proof:proofOrValue,value:maybeValue};
        const actor=contextOrActor;
        return {context:actor&&actor.context?actor.context:actor,proof:actor&&(actor.csrfProof||actor.proof),value:proofOrValue};
    }
    async function remove(contextOrActor,proofOrId,maybeId) {
        const args=writeArguments(contextOrActor,proofOrId,maybeId),id=args.value;
        const row=attachmentWrite(args.context,args.proof,(actor,at)=>{
            if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(id))notFound();
            const current=attachments.getById(id);
            if(!current||!['pending','ready'].includes(current.status))notFound();
            resolveAccess(actor,current.conversation_id);
            if(current.uploaded_by!==actor)notFound();
            const deleted=attachments.markDeleted(id,at);
            audit(actor,'attachment.deleted',id,{operation:'delete',outcome:'deleted',target_id:current.conversation_id},at);
            return deleted;
        });
        try {
            // A missing file is already physically removed. A provider error leaves the
            // retained row not_purged for the Retention_Job to retry.
            await storage.delete(row.storage_key);
            try { db.transaction(()=>attachments.markPurged(id)).immediate(); }
            catch { countedLog('attachment purge update failed count=1'); }
        } catch { countedLog('attachment deletion failed count=1'); }
        return undefined;
    }
    function associate(contextOrActor,proofOrInput,maybeInput) {
        const args=writeArguments(contextOrActor,proofOrInput,maybeInput),input=args.value;
        return attachmentWrite(args.context,args.proof,(actor,at)=>{
            if(!isObject(input))invalid(['body']);
            const conversation=input.conversationId;
            const access=resolveAccess(actor,conversation);
            assertWritable(access);
            const checked=validateAssociationBody(input);
            if(!checked.ok)invalid(checked.fields);
            const {messageId,attachmentIds:ids}=checked.value;
            const message=repositories.messages.getAuthenticated(messageId);
            if(!message||message.conversation_id!==conversation||message.sender_id!==actor)conflict();
            const rows=[];
            for(const id of ids){
                const row=attachments.getById(id);
                if(!row)notFound();
                if(row.conversation_id!==conversation||row.uploaded_by!==actor)notFound();
                if(row.status!=='pending'||row.message_id!==null||row.expires_at<=at)conflict();
                rows.push(row);
            }
            const existing=attachments.messageUsage(message.message_id);
            const totalCount=existing.count+rows.length;
            const totalBytes=existing.bytes+rows.reduce((sum,row)=>sum+row.byte_size,0);
            if(totalCount>MAX_MESSAGE_ATTACHMENTS||totalBytes>MAX_MESSAGE_ATTACHMENT_BYTES)invalid(['attachmentIds']);
            const changed=attachments.associate(ids,message.message_id,at);
            audit(actor,'attachment.associated',changed[0].attachment_id,
                {operation:'associate',outcome:'ready',count:changed.length,target_id:conversation},at);
            return changed.map(project);
        });
    }
    async function download(context,id) {
        const selected=attachmentRead(context,(actor,at)=>{
            if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(id))notFound();
            const row=attachments.getById(id);
            if(!row||row.status!=='ready')notFound();
            const access=resolveAccess(actor,row.conversation_id);
            requireReadyVisibility(row,actor,access);
            return {actor,row,at};
        });
        let size;
        try { size=await storage.stat(selected.row.storage_key); }
        catch(error) { throw mapError(error); }
        if(size===null){auditUnavailable(selected.actor,id,'missing',selected.at);serviceUnavailable();}
        if(size!==selected.row.byte_size){auditUnavailable(selected.actor,id,'length_mismatch',selected.at);serviceUnavailable();}
        let stored;
        try { stored=await storage.read(selected.row.storage_key); }
        catch(error) {
            if(error instanceof StorageError&&error.code==='STORAGE_MISSING'){
                auditUnavailable(selected.actor,id,'missing',selected.at);serviceUnavailable();
            }
            throw mapError(error);
        }
        if(!stored||!stored.stream||typeof stored.stream.on!=='function')serviceUnavailable();
        if(stored.byteCount!==selected.row.byte_size){
            stored.stream.destroy?.();auditUnavailable(selected.actor,id,'length_mismatch',selected.at);serviceUnavailable();
        }
        let byteCount=0;
        const output=new Transform({
            transform(chunk,encoding,callback){
                const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
                byteCount+=bytes.length;
                if(byteCount>selected.row.byte_size)callback(new StorageError('STORAGE_IO'));
                else callback(null,bytes);
            },
            flush(callback){if(byteCount!==selected.row.byte_size)callback(new StorageError('STORAGE_IO'));else callback();}
        });
        stored.stream.once('error',()=>output.destroy(new StorageError('STORAGE_IO')));
        output.once('close',()=>{if(!stored.stream.destroyed)stored.stream.destroy();});
        stored.stream.pipe(output);
        let audited=false;
        const onSent=()=>{
            if(audited||!output.readableEnded)return;
            audited=true;
            auditAfterDownload(selected.actor,selected.row);
        };
        return Object.freeze({stream:output,headers:Object.freeze({
            'Content-Type':'application/octet-stream','Content-Disposition':'attachment',
            'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Length':String(selected.row.byte_size)
        }),onSent});
    }
    function search(context,query) {
        return attachmentRead(context,actor=>{
            const checked=validateSearchQuery(query);
            if(!checked.ok)invalid(checked.fields);
            const q=checked.value;
            const filterSet=Object.freeze({conversationId:q.conversationId??null,uploadedBy:q.uploadedBy??null,
                minBytes:q.minBytes??null,maxBytes:q.maxBytes??null,createdAfter:q.createdAfter??null,
                createdBefore:q.createdBefore??null});
            const cursorContext={route:'file-search',userId:actor,filters:filterSet};
            let after=null,highWater;
            if(q.cursor!==undefined){
                const decoded=cursors.decode(q.cursor,cursorContext);
                if(decoded.last.length!==2||decoded.highWater===undefined)invalid(['cursor']);
                after=decoded.last;highWater=decoded.highWater;
            } else highWater=attachments.searchHighWater();
            const filters={conversationId:q.conversationId,uploadedBy:q.uploadedBy,minBytes:q.minBytes,maxBytes:q.maxBytes,
                createdAfter:q.createdAfter,createdBefore:q.createdBefore};
            const items=[];
            let scanAfter=after===null?null:[...after];
            let exhausted=false;
            while(items.length<=q.limit&&!exhausted){
                const rows=attachments.searchPage(filters,{after:scanAfter,highWater,limit:SEARCH_SCAN_SIZE});
                if(rows.length===0){exhausted=true;break;}
                for(const row of rows){
                    scanAfter=[row.created_at,row.attachment_id];
                    let access;
                    try { access=resolveAccess(actor,row.conversation_id); }
                    catch(error){if(error instanceof AuthError&&(error.status===403||error.status===404))continue;throw error;}
                    try { requireReadyVisibility(row,actor,access); }
                    catch(error){if(error instanceof AuthError&&error.status===404)continue;throw error;}
                    items.push(project(row));
                    if(items.length>q.limit)break;
                }
                if(rows.length<SEARCH_SCAN_SIZE)exhausted=true;
            }
            const hasMore=items.length>q.limit;
            const page=items.slice(0,q.limit);
            const nextCursor=hasMore?cursors.encode({last:[page.at(-1).createdAt,page.at(-1).id],highWater},cursorContext):null;
            return Object.freeze({items:Object.freeze(page),nextCursor});
        });
    }

    return Object.freeze({features:gate.status(),rates:ATTACHMENT_RATE_LIMITS,attachmentRead,attachmentWrite,rate,reserve,upload,
        metadata,remove,associate,download,search});
}

module.exports={createAttachmentService,ATTACHMENT_RATE_LIMITS,AUDIT_SOURCE,AUDIT_UPLOAD};












