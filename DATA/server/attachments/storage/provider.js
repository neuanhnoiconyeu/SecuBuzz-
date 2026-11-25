const { randomBytes } = require('node:crypto');
const STORAGE_KEY_PATTERN = /^[a-z0-9]{32,128}$/;
const STORAGE_ERROR_CODES = Object.freeze(['STORAGE_KEY','STORAGE_EXISTS','STORAGE_SIZE','STORAGE_MISSING','STORAGE_IO']);
class StorageError extends Error {
  constructor(code) { super(); if (!STORAGE_ERROR_CODES.includes(code)) throw new TypeError('invalid storage error code'); this.name='StorageError'; this.code=code; }
}
/** @typedef {{write:(key:string,readable:import('node:stream').Readable,options:{maxBytes:number})=>Promise<{byteCount:number,sha256:string}>,read:(key:string)=>Promise<{stream:import('node:stream').Readable,byteCount:number}>,stat:(key:string)=>Promise<number|null>,exists:(key:string)=>Promise<boolean>,delete:(key:string)=>Promise<boolean>,usage:()=>Promise<{bytes:number,files:number}>,sweepTemporary:(olderThanMs:number)=>Promise<number>,listKeys:()=>Promise<string[]>}} StorageProvider */
const OPERATIONS=['write','read','stat','exists','delete','usage','sweepTemporary','listKeys'];
function assertStorageProvider(candidate) { if(!candidate || OPERATIONS.some(name=>typeof candidate[name]!=='function')) throw new TypeError('invalid storage provider'); return candidate; }
function generateStorageKey() { return randomBytes(24).toString('hex'); }
module.exports={StorageError,STORAGE_ERROR_CODES,STORAGE_KEY_PATTERN,OPERATIONS,assertStorageProvider,generateStorageKey};
