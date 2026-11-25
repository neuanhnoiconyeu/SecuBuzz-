const {ATTACHMENT_LIMITS}=require('../../../shared/attachmentPolicy.ts');
const {conversationId}=require('../conversations/validation');
const MAX_HEADER_BYTES=16384;
function validateHeader(h){const fields=[];if(!h||typeof h!=='object'||Array.isArray(h))return {ok:false,status:400,fields:['body']};try{conversationId(h.conversationId,'conversationId');}catch{fields.push('conversationId');}if(!Number.isSafeInteger(h.byteSize)||h.byteSize<=0)fields.push('byteSize');if(typeof h.encryptedMetadata!=='string'||h.encryptedMetadata.length<1||h.encryptedMetadata.length>MAX_HEADER_BYTES)fields.push('encryptedMetadata');for(const k of ['algorithm','formatVersion'])if(typeof h[k]!=='string'||h[k].length<1||h[k].length>64)fields.push(k);return fields.length?{ok:false,status:400,fields}:{ok:true,value:h};}
function validateAssociationBody(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return {ok:false,fields:['body']};
    const allowed=['conversationId','messageId','attachmentIds'],fields=[];
    for(const key of Object.keys(input).sort())if(!allowed.includes(key)&&/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key))fields.push(key);
    if(typeof input.conversationId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(input.conversationId))fields.push('conversationId');
    if(typeof input.messageId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.messageId))fields.push('messageId');
    if(!Array.isArray(input.attachmentIds)||input.attachmentIds.length<1||input.attachmentIds.length>5||
        input.attachmentIds.some(id=>typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))||
        new Set(input.attachmentIds).size!==input.attachmentIds.length)fields.push('attachmentIds');
    return fields.length?{ok:false,fields:[...new Set(fields)]}:{ok:true,value:Object.freeze({
        conversationId:input.conversationId,messageId:input.messageId,attachmentIds:Object.freeze([...input.attachmentIds])})};
}
const SEARCH_KEYS=Object.freeze(['conversationId','uploadedBy','minBytes','maxBytes','createdAfter','createdBefore','limit','cursor']);
const SAFE_FIELD=/^[A-Za-z][A-Za-z0-9_]{0,63}$/;
function validateSearchQuery(input){
    if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))return {ok:false,fields:[]};
    const fields=[];let hasUnknown=false;
    for(const key of Object.keys(input).sort())if(!SEARCH_KEYS.includes(key)){hasUnknown=true;if(SAFE_FIELD.test(key))fields.push(key);}
    for(const key of Object.keys(input))if(SEARCH_KEYS.includes(key)&&typeof input[key]!=='string')fields.push(key);
    const value={};
    if(input.conversationId!==undefined){try{conversationId(input.conversationId,'conversationId');value.conversationId=input.conversationId;}catch{fields.push('conversationId');}}
    if(input.uploadedBy!==undefined){if(typeof input.uploadedBy!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.uploadedBy))fields.push('uploadedBy');else value.uploadedBy=input.uploadedBy;}
    for(const key of ['minBytes','maxBytes'])if(input[key]!==undefined){
        if(typeof input[key]!=='string'||! /^(0|[1-9][0-9]*)$/.test(input[key])||!Number.isSafeInteger(Number(input[key])))fields.push(key);
        else value[key]=Number(input[key]);
    }
    for(const key of ['createdAfter','createdBefore'])if(input[key]!==undefined){
        if(typeof input[key]!=='string'||input[key].length>64||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input[key])||!Number.isFinite(Date.parse(input[key])))fields.push(key);
        else value[key]=new Date(input[key]).toISOString();
    }
    if(input.minBytes!==undefined&&input.maxBytes!==undefined&&value.minBytes!==undefined&&value.maxBytes!==undefined&&value.minBytes>value.maxBytes)fields.push('minBytes','maxBytes');
    if(value.createdAfter!==undefined&&value.createdBefore!==undefined&&value.createdAfter>=value.createdBefore)fields.push('createdAfter','createdBefore');
    value.limit=input.limit===undefined?20:(typeof input.limit==='string'&&/^(0|[1-9][0-9]*)$/.test(input.limit)?Number(input.limit):0);
    if(value.limit<1||value.limit>50)fields.push('limit');
    if(input.cursor!==undefined){if(typeof input.cursor!=='string'||input.cursor.length===0)fields.push('cursor');else value.cursor=input.cursor;}
    return fields.length||hasUnknown?{ok:false,fields:[...new Set(fields)]}:{ok:true,value:Object.freeze(value)};
}
const LIMITS=Object.freeze({image:ATTACHMENT_LIMITS.imageSizeMb,document:ATTACHMENT_LIMITS.documentSizeMb,audio:ATTACHMENT_LIMITS.audioSizeMb,archive:ATTACHMENT_LIMITS.archiveSizeMb,video:ATTACHMENT_LIMITS.videoSizeMb});
function sizeDecision(declared,category){if(!Number.isSafeInteger(declared)||declared<=0)return {status:400,code:'VALIDATION_ERROR'};const mb=category?LIMITS[category]:50;if(!mb)return {status:400,code:'VALIDATION_ERROR'};return declared<=mb*1048576?{status:200,code:'ACCEPT'}:{status:413,code:'PAYLOAD_TOO_LARGE'};}
module.exports={validateHeader,validateAssociationBody,validateSearchQuery,sizeDecision,LIMITS,MAX_HEADER_BYTES,MESSAGE_LIMITS:{maxCount:ATTACHMENT_LIMITS.maxCount,maxTotalBytes:ATTACHMENT_LIMITS.maxTotalSizeMb*1048576}};


