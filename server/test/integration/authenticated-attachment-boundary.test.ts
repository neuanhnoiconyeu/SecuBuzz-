import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {createServer,type Server} from 'node:http';
import {createRequire} from 'node:module';
import {mkdtemp,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {DataStack} from '../data/support/stack.ts';
import {Browser} from '../e2ee/support/dataApp.ts';
import {createDb6AttachmentTransport} from '../../src/attachments/db6Transport.ts';

const require=createRequire(import.meta.url),serverRoot=fileURLToPath(new URL('../../',import.meta.url));
const variables=['DB_FILE','BASE_SCHEMA_FILE','ATTACHMENT_STORAGE_DIR','MAX_ATTACHMENT_BYTES'];
const previous=Object.fromEntries(variables.map(name=>[name,process.env[name]]));
let directory:string,storage:string,db:any,stack:DataStack,pair:Awaited<ReturnType<DataStack['pair']>>;
const servers:Server[]=[];let disabledUrl:string,probeUrl:string,bindIdentity=false;
const verified=new Set<string>();
async function listen(app:Parameters<typeof createDb6AttachmentTransport>[0]){
  const server=createServer(createDb6AttachmentTransport(app));servers.push(server);
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  return `http://127.0.0.1:${(server.address() as {port:number}).port}`;
}
before(async()=>{
  directory=await mkdtemp(join(tmpdir(),'secubuzz-attachment-boundary-'));storage=join(directory,'private-files');
  process.env.DB_FILE=join(directory,'db6.sqlite');process.env.BASE_SCHEMA_FILE=join(serverRoot,'database','schema.sql');
  process.env.ATTACHMENT_STORAGE_DIR=storage;process.env.MAX_ATTACHMENT_BYTES='1048576';
  db=require('../../src/db5db6/db.cjs');const {createApiApp}=require('../../src/api-app.cjs');
  stack=await DataStack.start();pair=await stack.pair();
  disabledUrl=await listen(createApiApp());
  // TEST-ONLY contract probe, never a production identity/CSRF adapter. Deliberately does not
  // provision DB6 users, bypass its FKs, or claim complete DATA conversation authorization.
  probeUrl=await listen(createApiApp((req:any,res:any,next:(error?:unknown)=>void)=>{
    const middleware=stack.data.application.middleware;
    middleware.requireAuth(req,res,(error?:unknown)=>{
      if(error)return next(error);
      middleware.requireCsrf(req,res,(error?:unknown)=>{
        if(error)return next(error);
        verified.add(req.auth.userId);if(bindIdentity)req.user={user_id:req.auth.userId};next();
      });
    });
  }));
});
after(async()=>{
  for(const server of servers){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  await stack?.close();db?.close();
  // Remove only known, test-owned files, without recursive directory deletion.
  if(storage){for(const file of await readdir(storage))await unlink(join(storage,file));await rmdir(storage);}
  if(directory){for(const file of await readdir(directory))await unlink(join(directory,file));await rmdir(directory);}
  for(const [name,value]of Object.entries(previous)){if(value===undefined)delete process.env[name];else process.env[name]=value;}
});
function browserFor(base:string,source:Browser){const browser=new Browser(base);for(const [name,value]of source.cookies)browser.cookies.set(name,value);browser.token=source.token;return browser;}
const syntheticCiphertext=randomBytes(64);
async function upload(browser:Browser,recipient:string,csrf=true){
  return fetch(browser.base+`/api/attachments?recipient_user_id=${recipient}`,{method:'POST',body:syntheticCiphertext,headers:{
    Origin:'http://localhost:3000',Cookie:[...browser.cookies].map(([k,v])=>`${k}=${v}`).join('; '),
    ...(csrf?{'X-CSRF-Token':browser.token}:{}),'Content-Type':'application/octet-stream',
    'X-Encryption-Algorithm':'AES-256-GCM','X-File-Iv':randomBytes(12).toString('base64'),'X-File-Auth-Tag':randomBytes(16).toString('base64'),
  }});
}
test('two real DATA sessions cannot silently use an unconfigured DB6 authentication host',async()=>{
  for(const [actor,peer]of [[pair.alice,pair.bob],[pair.bob,pair.alice]] as const){
    assert.equal((await actor.browser.request('/api/auth/me')).status,200);
    const browser=browserFor(disabledUrl,actor.browser);assert.equal((await upload(browser,peer.id)).status,503);
    assert.equal((await browser.request('/api/attachments/unknown/download')).status,503);
  }
  assert.equal(db.prepare('SELECT count(*) n FROM Attachments').get().n,0);assert.deepEqual(await readdir(storage),[]);
});
test('DATA req.auth is not a DB6 identity; mapping the verified ID alone still lacks the DB6 account contract',async()=>{
  const alice=browserFor(probeUrl,pair.alice.browser);
  assert.equal((await upload(alice,pair.bob.id,false)).status,403);
  assert.equal((await upload(alice,pair.bob.id)).status,401);assert.ok(verified.has(pair.alice.id));
  bindIdentity=true;
  for(const [actor,peer]of [[pair.alice,pair.bob],[pair.bob,pair.alice]] as const)assert.equal((await upload(browserFor(probeUrl,actor.browser),peer.id)).status,404);
  assert.ok(verified.has(pair.bob.id));assert.equal(db.prepare('SELECT count(*) n FROM Users').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM Attachments').get().n,0);assert.deepEqual(await readdir(storage),[]);
});
