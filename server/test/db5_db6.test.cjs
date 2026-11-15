const test = require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const {randomUUID}=require('node:crypto');

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'db5-db6-'));
process.env.DB_FILE=path.join(temp,'test.sqlite');
process.env.BASE_SCHEMA_FILE=path.resolve(process.cwd(),'database','schema.sql');
process.env.ATTACHMENT_STORAGE_DIR=path.join(temp,'private-files');
process.env.MAX_ATTACHMENT_BYTES='1048576';
const db=require('../src/db5db6/db.cjs');
const {createApiApp}=require('../src/api-app.cjs');
const authenticate=(req,res,next)=>{req.user={user_id:req.headers['x-test-user']};next();};
const app=createApiApp(authenticate);
let server,base;
const userA=randomUUID(),userB=randomUUID(),userC=randomUUID(),outsider=randomUUID();
function addUser(id,username){db.prepare('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)').run(id,username,username);}
async function call(route,{user=userA,method='GET',body,headers={},raw}={}){
  const h={...headers,'x-test-user':user};
  if(body!==undefined) h['content-type']='application/json';
  const response=await fetch(base+route,{method,headers:h,body:raw!==undefined?raw:(body===undefined?undefined:JSON.stringify(body))});
  const data=response.status===204?null:await response.json();
  return {status:response.status,data};
}

test('DB-5 group roles/history/invitations and DB-6 secure attachment access',async t=>{
  addUser(userA,'owner');addUser(userB,'member');addUser(userC,'invitee');addUser(outsider,'outsider');
  server=http.createServer(app);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{
    await new Promise(resolve=>server.close(resolve));
    db.close();
    fs.rmSync(temp,{recursive:true,force:true});
  });

  const created=await call('/api/groups',{method:'POST',body:{name:'QA group',description:'test'}});
  assert.equal(created.status,201);
  const groupId=created.data.group_id;

  assert.equal((await call(`/api/groups/${groupId}`,{user:outsider})).status,404);
  assert.equal((await call(`/api/groups/${groupId}/members`,{method:'POST',body:{user_id:userB,role:'member'}})).status,201);
  assert.equal((await call(`/api/groups/${groupId}`,{user:userB,method:'PATCH',body:{name:'No permission'}})).status,403);

  const invite=await call(`/api/groups/${groupId}/invitations`,{method:'POST',body:{user_id:userC}});
  assert.equal(invite.status,201);
  assert.equal((await call('/api/groups/invitations/me',{user:userC})).data.length,1);
  assert.equal((await call(`/api/groups/invitations/${invite.data.invitation_id}/accept`,{user:userC,method:'POST'})).status,200);

  const message=await call(`/api/groups/${groupId}/messages`,{user:userB,method:'POST',body:{ciphertext:'ciphertext-1',iv:'iv-1'}});
  assert.equal(message.status,201);
  assert.equal(message.data.group_id,groupId);
  assert.equal(message.data.recipient_id,null);
  assert.equal((await call(`/api/groups/${groupId}/messages`,{user:outsider})).status,404);

  assert.equal((await call(`/api/groups/${groupId}/transfer`,{method:'POST',body:{new_owner_user_id:userB}})).status,200);
  assert.equal((await call(`/api/groups/${groupId}/leave`,{method:'POST'})).status,204);
  assert.equal((await call(`/api/groups/${groupId}/messages`,{user:userA})).status,404);

  // Direct attachment upload: bytes are streamed, metadata is stored in SQLite.
  const uploaded=await call(`/api/attachments?recipient_user_id=${userB}`,{
    method:'POST',raw:Buffer.from('sample pdf bytes'),
    headers:{'content-type':'application/pdf','x-file-name':'report.pdf'}
  });
  assert.equal(uploaded.status,201);
  assert.equal(uploaded.data.original_name,'report.pdf');
  assert.equal((await call('/api/files/search?q=report')).status,200);
  assert.equal((await call(`/api/attachments/${uploaded.data.attachment_id}/download`,{user:outsider})).status,404);
  const download=await fetch(base+`/api/attachments/${uploaded.data.attachment_id}/download`,{headers:{'x-test-user':userB}});
  assert.equal(download.status,200);
  assert.equal(await download.text(),'sample pdf bytes');

  // E2EE metadata: plaintext filename is not persisted.
  const encrypted=await call(`/api/attachments?recipient_user_id=${userB}`,{
    method:'POST',raw:Buffer.from('encrypted bytes'),
    headers:{'content-type':'application/octet-stream','x-file-name':'secret-name.txt',
      'x-encryption-algorithm':'AES-256-GCM','x-file-iv':'iv-value','x-file-auth-tag':'tag-value',
      'x-metadata-ciphertext':'encrypted metadata','x-metadata-iv':'meta-iv','x-metadata-auth-tag':'meta-tag'}
  });
  assert.equal(encrypted.status,201);
  assert.equal(encrypted.data.original_name,null);
  assert.equal(encrypted.data.metadata_ciphertext,'encrypted metadata');
});