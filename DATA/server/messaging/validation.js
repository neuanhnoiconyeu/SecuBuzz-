const { createHash } = require('node:crypto');
const { AuthError } = require('../auth/errors');
const { query,invalid,identifier,emptyBody } = require('../social/validation');
const { conversationId } = require('../conversations/validation');
const { protocol } = require('../e2ee/protocol');
const MAX_CIPHERTEXT=65536;
const MAX_BODY=131072;
const controls=/[\u0000-\u001f\u007f-\u009f\p{Cs}]/u;
function object(value,keys) {
    if (!value || typeof value!=='object' || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) ||
        Reflect.ownKeys(value).some(key=>typeof key!=='string' || !keys.includes(key)) || Object.keys(value).length!==keys.length) invalid();
}
function wireId(value,field='id') {
    if (typeof value!=='string' || !value.length || value.length>256 || controls.test(value) || /\s/u.test(value)) invalid(field);
    return value;
}
function iso(value) {
    if (typeof value!=='string' || value.length>40) return false;
    const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return false;
    const [year,month,day,hour,minute,second]=match.slice(1,7).map(Number);
    const leap=year%4===0&&(year%100!==0||year%400===0);
    return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<=23&&minute<=59&&second<=59&&Number.isFinite(Date.parse(value));
}
function base64(value,max) {
    if (typeof value!=='string' || !value.length || value.length>max || value.length%4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid('encryption');
    const decoded=Buffer.from(value,'base64');
    if (decoded.toString('base64')!==value) invalid('encryption');
    return decoded.length;
}
function envelope(input,context,id) {
    object(input,['id','conversationId','senderId','senderName','timestamp','type','encryption']);
    if(input.encryption?.version===2){
        if(!protocol)throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);
        const parsed=protocol.parseMessageEnvelopeV2(input);if(!parsed)invalid('encryption');
        if(parsed.conversationId!==id)invalid('conversationId');
        if(parsed.senderId!==context.userId)throw new AuthError('FORBIDDEN',403,['senderId']);
        return parsed;
    }
    wireId(input.id);wireId(input.conversationId,'conversationId');wireId(input.senderId,'senderId');
    if (input.conversationId!==id) invalid('conversationId');
    if (input.senderId!==context.userId) throw new AuthError('FORBIDDEN',403,['senderId']);
    if (typeof input.senderName!=='string'||!input.senderName.trim()||input.senderName.length>160||controls.test(input.senderName)) invalid('senderName');
    if (!iso(input.timestamp)||input.type!=='text') invalid('timestamp');
    const e=input.encryption;object(e,['version','algorithm','encoding','iv','ciphertext']);
    if(e.version!==1||e.algorithm!=='AES-256-GCM'||e.encoding!=='base64'||base64(e.iv,16)!==12||base64(e.ciphertext,MAX_CIPHERTEXT)<=16) invalid('encryption');
    return Object.freeze({id:input.id,conversationId:id,senderId:input.senderId,senderName:input.senderName,timestamp:input.timestamp,type:'text',
        encryption:Object.freeze({version:1,algorithm:e.algorithm,encoding:e.encoding,iv:e.iv,ciphertext:e.ciphertext})});
}
// Byte-for-byte canonicalization from Kiro's envelopeFingerprint. Not an E2EE proof.
function fingerprint(e) {
    if(e.encryption.version===2){if(!protocol)throw new AuthError('RECIPIENT_KEYS_UNAVAILABLE',503);return protocol.envelopeV2Fingerprint(e);}
    return createHash('sha256').update(JSON.stringify([e.id,e.conversationId,e.senderId,e.senderName,e.timestamp,e.type,
        e.encryption.version,e.encryption.algorithm,e.encryption.encoding,e.encryption.iv,e.encryption.ciphertext]),'utf8').digest('hex');
}
function page(input,actor,id) {
    query(input,['limit','cursor']);const limit=input.limit===undefined?20:/^[1-9][0-9]?$/.test(input.limit)?Number(input.limit):0;
    if(limit<1||limit>50)invalid('limit');
    const context=createHash('sha256').update(JSON.stringify({kind:'encrypted-history-v1',actor,id})).digest('hex');
    let highWater=null,before=null;
    if(input.cursor!==undefined){const encoded=input.cursor;
        if(encoded.length>1024||!/^[A-Za-z0-9_-]+$/.test(encoded)||Buffer.from(encoded,'base64url').toString('base64url')!==encoded)invalid('cursor');
        let value;try{value=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8'));}catch{invalid('cursor');}
        if(!value||Object.keys(value).sort().join(',')!=='before,context,highWater,v'||value.v!==1||value.context!==context||
            !Number.isSafeInteger(value.highWater)||value.highWater<1||!Number.isSafeInteger(value.before)||value.before<1||value.before>value.highWater)invalid('cursor');
        ({highWater,before}=value);
    }
    return {limit,context,highWater,before};
}
function groupPage(input,actor,id) {
    if(input&&typeof input==='object'&&!Array.isArray(input))
        for(const key of Object.keys(input))if(!['limit','cursor'].includes(key))invalid(key);
    return page(input,actor,id);
}
module.exports={MAX_BODY,MAX_CIPHERTEXT,envelope,fingerprint,page,groupPage,conversationId,identifier,wireId,query,emptyBody,invalid,iso};
