const express = require('express');
const { AuthError } = require('../auth/errors');
const { createSqliteRateLimiter } = require('../auth/rateLimiter');
const invalid = () => { throw new AuthError('VALIDATION_ERROR',400); };
const idPattern = /^(?:lounge|study-room|dev-corner|room-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
// Migration 0014 default rows are trigger-immutable in SQLite; map stable IDs to current display names.
const DEFAULT_ROOM_NAMES = Object.freeze({ lounge: 'Lounge', 'study-room': 'Study Room', 'dev-corner': 'Gaming Room' });
function roomName(body,creating) {
    if (!body || typeof body!=='object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',')!==(creating?'name,requestId':'name')) invalid();
    const name=typeof body.name==='string'?body.name.normalize('NFKC').trim().replace(/\s+/gu,' '):'';
    if (!name || name.length>64 || /[\p{Cc}\p{Cf}]/u.test(body.name)) invalid();
    if (creating && (typeof body.requestId!=='string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(body.requestId))) invalid();
    return name;
}
function createVoiceRooms({db,auth,limiter=createSqliteRateLimiter(db)}) {
    let cleanup=null;
    const one=db.prepare('SELECT r.*,u.display_name AS owner_name FROM VoiceRooms r LEFT JOIN Users u ON u.user_id=r.owner_id WHERE room_id=?');
    const project=r=>({id:r.room_id,name:!r.owner_id&&DEFAULT_ROOM_NAMES[r.room_id]?DEFAULT_ROOM_NAMES[r.room_id]:r.name,description:r.owner_id?'Shared with all signed-in users.':'A shared SecuBuzz voice room.',
        ownerId:r.owner_id,ownerName:r.owner_name??null,createdAt:r.created_at});
    function active(context) {
        if(auth.checkSession(context).status!=='active')throw new AuthError('UNAUTHENTICATED',401);
    }
    function write(context,proof,work) {
        return db.transaction(()=>{
            active(context);
            if(!proof || proof.type!=='session' || proof.userId!==context.userId || proof.sessionId!==context.sessionId)throw new AuthError('CSRF_INVALID',403);
            auth.repository.verifyProof(proof,auth.now());
            return work();
        }).immediate();
    }
    function get(id) { if(!idPattern.test(id))invalid();const row=one.get(id);if(!row)throw new AuthError('NOT_FOUND',404);return row; }
    function owner(context,id) { const row=get(id);if(row.owner_id!==context.userId)throw new AuthError('FORBIDDEN',403);return row; }
    function available(name,id='') {
        const key=name.toLowerCase();
        if(Object.entries(DEFAULT_ROOM_NAMES).some(([defaultId,defaultName])=>defaultId!==id&&defaultName.toLowerCase()===key) ||
            db.prepare('SELECT 1 FROM VoiceRooms WHERE name_key=? AND deleted_at IS NULL AND room_id<>?').get(key,id))throw new AuthError('CONFLICT',409);
    }
    return {
        setCleanup(fn){cleanup=fn;},
        // Catalog rooms are community rooms, not direct-conversation grants.
        authorize(context,id){active(context);const row=get(id);return row.deleted_at?null:{id:row.room_id};},
        deleted(){return db.prepare('SELECT room_id AS id,deleted_at AS deletedAt FROM VoiceRooms WHERE deleted_at IS NOT NULL').all();},
        list(context){active(context);return {items:db.prepare("SELECT r.*,u.display_name AS owner_name FROM VoiceRooms r LEFT JOIN Users u ON u.user_id=r.owner_id WHERE deleted_at IS NULL ORDER BY owner_id IS NOT NULL,CASE room_id WHEN 'lounge' THEN 0 WHEN 'study-room' THEN 1 WHEN 'dev-corner' THEN 2 ELSE 3 END,created_at,room_id").all().map(project)};},
        rate(context,writing){const r=limiter.consume([{key:`voice:${writing?'write':'read'}:${context.userId}`,limit:writing?20:120,windowMs:60000}],auth.now());if(!r.allowed){const e=new AuthError('RATE_LIMITED',429);e.retryAfterSeconds=r.retryAfterSeconds;throw e;}},
        create(context,proof,body){const name=roomName(body,true),id='room-'+body.requestId;return write(context,proof,()=>{
            const previous=one.get(id);
            if(previous){if(previous.owner_id!==context.userId||previous.deleted_at||previous.name!==name)throw new AuthError('CONFLICT',409);return {created:false,room:project(previous)};}
            available(name);
            if(db.prepare('SELECT count(*) AS n FROM VoiceRooms WHERE deleted_at IS NULL').get().n>=200 || db.prepare('SELECT count(*) AS n FROM VoiceRooms WHERE owner_id=? AND deleted_at IS NULL').get(context.userId).n>=10)throw new AuthError('RATE_LIMITED',429);
            const now=new Date(auth.now()).toISOString();
            db.prepare('INSERT INTO VoiceRooms(room_id,owner_id,name,name_key,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(id,context.userId,name,name.toLowerCase(),now,now);
            return {created:true,room:project(one.get(id))};
        });},
        rename(context,proof,id,body){const name=roomName(body,false);return write(context,proof,()=>{const row=owner(context,id);if(row.deleted_at)throw new AuthError('NOT_FOUND',404);available(name,id);db.prepare('UPDATE VoiceRooms SET name=?,name_key=?,updated_at=? WHERE room_id=?').run(name,name.toLowerCase(),new Date(auth.now()).toISOString(),id);return {room:project(one.get(id))};});},
        async remove(context,proof,id){write(context,proof,()=>{const row=owner(context,id);if(!row.deleted_at){const now=new Date(auth.now()).toISOString();db.prepare('UPDATE VoiceRooms SET deleted_at=?,updated_at=? WHERE room_id=?').run(now,now,id);}});try { await cleanup?.(id); } catch { throw new AuthError('SERVICE_UNAVAILABLE',503); }},
    };
}
function createVoiceRoomRouter(service,middleware) {
    const r=express.Router();r.use(middleware.requireAuth);
    r.use((req,res,next)=>{try{service.rate(req.auth,!['GET','HEAD'].includes(req.method));next();}catch(e){next(e);}});
    r.use((req,res,next)=>['GET','HEAD'].includes(req.method)?next():middleware.requireCsrf(req,res,next));
    r.use(express.json({limit:'2kb',strict:true,inflate:false}));
    r.get('/',(req,res)=>res.json(service.list(req.auth)));
    r.post('/',(req,res)=>{const result=service.create(req.auth,req.csrfProof,req.body);res.status(result.created?201:200).json({room:result.room});});
    r.patch('/:id',(req,res)=>res.json(service.rename(req.auth,req.csrfProof,req.params.id,req.body)));
    r.delete('/:id',(req,res,next)=>Promise.resolve(service.remove(req.auth,req.csrfProof,req.params.id)).then(()=>res.status(204).end(),next));
    return r;
}
module.exports={createVoiceRooms,createVoiceRoomRouter};
