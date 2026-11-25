const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');

function createAttachmentStorage({directory=process.env.ATTACHMENT_STORAGE_DIR || path.join(process.cwd(),'private-attachments'),maxBytes=Number.parseInt(process.env.MAX_ATTACHMENT_BYTES || String(25*1024*1024),10)}={}) {
const storageRoot = path.resolve(directory);
fs.mkdirSync(storageRoot,{recursive:true,mode:0o700});
const MAX_BYTES = maxBytes;
if(!Number.isSafeInteger(MAX_BYTES)||MAX_BYTES<1)throw new TypeError('Invalid attachment storage limit');

async function storeRequestStream(request) {
  const storageKey=randomUUID();
  const tempPath=path.join(storageRoot,`${storageKey}.part`);
  const finalPath=path.join(storageRoot,storageKey);
  let size=0;
  const hash=createHash('sha256');
  const meter=new Transform({transform(chunk,enc,cb){
    size+=chunk.length;
    if(size>MAX_BYTES) return cb(Object.assign(new Error('Attachment exceeds size limit'),{status:413}));
    hash.update(chunk); cb(null,chunk);
  }});
  try {
    await pipeline(request,meter,fs.createWriteStream(tempPath,{flags:'wx',mode:0o600}));
    if(size===0) throw Object.assign(new Error('Empty attachment'),{status:400});
    fs.renameSync(tempPath,finalPath);
    return {storageKey,sizeBytes:size,sha256:hash.digest('hex'),path:finalPath};
  } catch(error) {
    try { fs.unlinkSync(tempPath); } catch {}
    try { fs.unlinkSync(finalPath); } catch {}
    throw error;
  }
}
function resolveStoragePath(storageKey) {
  if(typeof storageKey!=='string' || !/^[0-9a-f-]{36}$/i.test(storageKey)) throw new Error('Invalid storage key');
  return path.join(storageRoot,storageKey);
}
function removeStoredFile(storageKey) {
  try { fs.unlinkSync(resolveStoragePath(storageKey)); return true; }
  catch(error) { if(error.code==='ENOENT') return false; throw error; }
}
return {storeRequestStream,resolveStoragePath,removeStoredFile,MAX_BYTES,storageRoot};
}
module.exports={...createAttachmentStorage(),createAttachmentStorage};
