const {after,test}=require('node:test');const {randomUUID}=require('node:crypto');const assert=require('node:assert/strict');
const {setup}=require('./support/auth');const {befriend,mutate}=require('./support/social');const {actorContext}=require('./support/messaging');
const {keyDirectoryContract}=require('../../server/test/e2ee/support/keyDirectoryContract.ts');
keyDirectoryContract('authoritative DATA SQLite + DB-2/4A services',async()=>{
    const f=await setup({after}),actors=new Map();
    async function account(){const browser=f.browser(),username='key-'+randomUUID().slice(0,12);assert.equal((await browser.register(username)).status,201);const result=await browser.login(username);
        const actor={id:result.body.user.id,browser,token:await browser.csrf()};actors.set(actor.id,actor);return actor;}
    function harness(application){
        const refs=id=>actorContext({...f,application},actors.get(id));
        const invoke=(work,fallback)=>{try{return work();}catch(e){if(e.protocolReason)return {status:'refused',reason:e.protocolReason};if(e.code==='NOT_FOUND')return {status:'refused',reason:fallback};throw e;}};
        return {directory:application.keys.directory,
            async createConversation(){const a=await account(),b=await account();await befriend(a,b);const r=await mutate(a,'POST','/api/conversations/dm',{recipientId:b.id});return {conversationId:r.body.conversation.id,userIds:[a.id,b.id]};},
            async createOutsider(){return (await account()).id;},
            async registerDevice(user,body){return invoke(()=>{const a=refs(user),r=application.keys.register(a.context,a.proof,body);return {status:r.created?'created':'duplicate'};},'not_found');},
            async revokeDevice(user,id){return invoke(()=>{const a=refs(user);return {status:application.keys.revoke(a.context,a.proof,id).outcome};},'not_found');},
            async publishEpoch(user,id,body){return invoke(()=>{const a=refs(user),r=application.keys.publish(a.context,a.proof,id,body);return {status:r.created?'created':'duplicate'};},'not_participant');},
            async reopen(){await f.anotherServer();return harness(f.applications.at(-1));}
        };
    }
    return harness(f.application);
});
