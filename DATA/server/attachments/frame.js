const FRAME_CONTENT_TYPE='application/vnd.secubuzz.attachment-frame';
const DEFAULT_MAX_HEADER_BYTES=131072;
const FIELDS=new Set(['conversationId','byteSize','encryptedMetadata','algorithm','formatVersion']);
class FrameError extends Error {
    constructor(code,field){super();this.name='FrameError';this.code=code;if(typeof field==='string'&&/^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(field))this.field=field;}
}
function encode(header,bytes=Buffer.alloc(0)){
    const json=Buffer.from(JSON.stringify(header),'utf8');
    if(json.length>DEFAULT_MAX_HEADER_BYTES)throw new FrameError('HEADER_TOO_LARGE');
    const prefix=Buffer.alloc(4);prefix.writeUInt32BE(json.length);
    return Buffer.concat([prefix,json,Buffer.from(bytes)]);
}
async function readExactly(stream,n,code,state){
    const out=Buffer.allocUnsafe(n);let offset=0;
    while(offset<n){
        if(state.remainder.length){const take=Math.min(n-offset,state.remainder.length);state.remainder.copy(out,offset,0,take);state.remainder=state.remainder.subarray(take);offset+=take;continue;}
        const chunk=stream.read();
        if(chunk!==null){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);const take=Math.min(n-offset,bytes.length);bytes.copy(out,offset,0,take);offset+=take;if(take<bytes.length)state.remainder=bytes.subarray(take);continue;}
        if(stream.readableEnded&&!stream.destroyed)throw new FrameError(code);
        await new Promise((resolve,reject)=>{
            let settled=false;
            const clean=()=>{stream.off('readable',onReadable);stream.off('end',onEnd);stream.off('close',onClose);stream.off('error',onError);};
            const finish=(error)=>{if(settled)return;settled=true;clean();error?reject(error):resolve();};
            const onReadable=()=>finish();
            const onEnd=()=>finish(new FrameError(code));
            const onError=error=>finish(error);
            const onClose=()=>setImmediate(()=>{const error=stream.errored;if(error)stream.once('error',()=>{});finish(error||new FrameError(code));});
            stream.once('readable',onReadable);stream.once('end',onEnd);stream.once('close',onClose);stream.once('error',onError);
            if(stream.errored)onError(stream.errored);
            else if(stream.readableEnded&&!stream.destroyed)onEnd();
            else if(stream.closed)onClose();
        });
    }
    return out;
}
async function parseHeader(stream,{maxHeaderBytes=DEFAULT_MAX_HEADER_BYTES,onHeaderLength}={}){
    if(!Number.isSafeInteger(maxHeaderBytes)||maxHeaderBytes<1||maxHeaderBytes>0xffffffff)throw new FrameError('INVALID_LIMIT');
    if(onHeaderLength!==undefined&&typeof onHeaderLength!=='function')throw new FrameError('INVALID_LIMIT');
    const state={remainder:Buffer.alloc(0)};
    const prefix=await readExactly(stream,4,'TRUNCATED_PREFIX',state),n=prefix.readUInt32BE(0);
    if(n<1||n>maxHeaderBytes)throw new FrameError('HEADER_TOO_LARGE');
    const raw=await readExactly(stream,n,'TRUNCATED_HEADER',state);
    if(onHeaderLength)onHeaderLength(4+n);
    if(state.remainder.length)stream.unshift(state.remainder);
    let value;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{throw new FrameError('INVALID_JSON');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw new FrameError('INVALID_OBJECT');
    for(const key of Object.keys(value))if(!FIELDS.has(key))throw new FrameError('UNKNOWN_FIELD',key);
    for(const key of FIELDS){if(!(key in value))throw new FrameError('MISSING_FIELD',key);const v=value[key],ok=key==='byteSize'?Number.isSafeInteger(v)&&v>=0:typeof v==='string';if(!ok)throw new FrameError('INVALID_FIELD',key);}
    return value;
}
module.exports={encode,parseHeader,FrameError,FRAME_CONTENT_TYPE,DEFAULT_MAX_HEADER_BYTES};
