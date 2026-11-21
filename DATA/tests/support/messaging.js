const assert=require('node:assert/strict');
const path=require('node:path');
const fs=require('node:fs');
const { stripTypeScriptTypes }=require('node:module');
const { spawn }=require('node:child_process');
const { once }=require('node:events');
const { socialFixture,befriend,mutate }=require('./social');
const { Browser,envDefaults }=require('./auth');
// Explicit isolated composition only. DATA/server.js never imports this verifier.
const fixtureVerifier=Object.freeze({testOnly:true,async verifyEnvelope(){return {verified:true};}});
async function messagingFixture(t,{messageOptions={},...options}={}){
    const f=await socialFixture(t,{...options,messageOptions:{recipientKeyVerifier:fixtureVerifier,...messageOptions}});
    await befriend(f.alice,f.bob);const created=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id});assert.equal(created.status,201);
    return {...f,conversationId:created.body.conversation.id};
}
let cryptoModule;
async function loadTypeScript(source){
    const input=fs.readFileSync(source,'utf8');let javascript;
    try{javascript=stripTypeScriptTypes(input,{mode:'transform',sourceUrl:source});}
    catch(error){
        if(error.code!=='ERR_INVALID_ARG_VALUE'||!error.message.includes('options.mode'))throw error;
        // Some Node runtimes provide only strip mode, which cannot erase constructor parameter properties.
        // Keep native loading where supported; otherwise reuse the installed frontend compiler in tests only.
        const typescript=require('../../../client/node_modules/typescript');
        javascript=typescript.transpileModule(input,{fileName:source,compilerOptions:{target:typescript.ScriptTarget.ES2020,module:typescript.ModuleKind.ESNext}}).outputText;
    }
    return import('data:text/javascript;base64,'+Buffer.from(javascript).toString('base64'));
}
async function encrypted(actor,conversationId,id='client-message-1',text='Isolated encrypted fixture'){
    if(!cryptoModule){
        const source=path.resolve(__dirname,'../../../client/src/utils/crypto.ts');
        cryptoModule=loadTypeScript(source);
    }
    const client=await cryptoModule;const key=await client.generateEncryptionKey();const timestamp=new Date().toISOString();
    const envelope={id,conversationId,senderId:actor.id,senderName:actor.displayName??'Alice',timestamp,type:'text',
        encryption:await client.encryptMessage(text,key,{conversationId,messageId:id,senderId:actor.id,senderName:actor.displayName??'Alice',timestamp})};
    return {envelope,key,client};
}
const submit=(f,actor,envelope)=>mutate(actor,'POST',`/api/conversations/${f.conversationId}/messages`,envelope);
function actorContext(f,actor){const token=actor.browser.cookies.get(f.config.sessionCookie),row=f.application.auth.resolveToken(token).row;
    return {context:{userId:row.user_id,sessionId:row.session_id},proof:f.application.auth.csrfProof(token,null,actor.token)};}
async function worker(f){
    const child=spawn(process.execPath,[path.join(__dirname,'messaging-worker.cjs')],{cwd:path.join(__dirname,'../..'),windowsHide:true,
        env:{...process.env,...envDefaults,DB_PATH:f.filename,SECUBUZZ_ISOLATED_MESSAGE_WORKER:'1'},stdio:['ignore','pipe','pipe']});f.children.push(child);
    const port=await new Promise((resolve,reject)=>{let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('Isolated messaging worker timeout'));},15000);
        child.stdout.on('data',chunk=>{output+=chunk;const match=/listening on port (\d+)/.exec(output);if(match){clearTimeout(timer);resolve(Number(match[1]));}});
        child.once('error',()=>{clearTimeout(timer);reject(new Error('Isolated messaging worker failed'));});child.once('exit',()=>{clearTimeout(timer);reject(new Error('Worker exited before startup'));});child.stderr.on('data',()=>{});});
    return {child,browser:new Browser(`http://127.0.0.1:${port}`),async stop(){const done=once(child,'exit');child.kill();await done;}};
}
module.exports={messagingFixture,encrypted,submit,actorContext,worker,fixtureVerifier,loadTypeScript};
