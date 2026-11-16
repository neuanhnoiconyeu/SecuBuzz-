const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {socialFixture,befriend,mutate}=require('./social');
const {actorContext}=require('./messaging');
// Kiro's independent WebCrypto/HPKE simulated client, imported only by isolated tests.
const {TestDevice}=require('../../../server/test/e2ee/support/deviceClient.ts');
async function keyFixture(t,options={}){
    const f=await socialFixture(t,options);await befriend(f.alice,f.bob);
    const dm=await mutate(f.alice,'POST','/api/conversations/dm',{recipientId:f.bob.id});assert.equal(dm.status,201);
    f.conversationId=dm.body.conversation.id;f.keysPath=`/api/conversations/${f.conversationId}/keys`;
    for(const actor of [f.alice,f.bob]){
        actor.device=await TestDevice.create(actor.id);actor.registration=await actor.device.registration();
        const result=await mutate(actor,'POST','/api/keys/devices',actor.registration);assert.equal(result.status,201,JSON.stringify(result.body));actor.record=result.body.device;
    }
    f.devices=[f.alice.record,f.bob.record];
    f.makeEpoch=async(actor=f.alice,overrides={})=>{
        const current=f.application.keys.repository.current(f.conversationId);
        return actor.device.createEpoch({conversationId:f.conversationId,epoch:(current?.epoch??0)+1,previousKeyId:current?.keyId??null,devices:f.application.keys.repository.active([f.alice.id,f.bob.id]),...overrides});
    };
    f.publish=async(epoch,actor=f.alice)=>mutate(actor,'POST',f.keysPath+'/epochs',epoch.body);
    f.message=async(epoch,id=randomUUID(),text='Independent E2EE fixture')=>f.alice.device.encrypt(epoch.key,epoch.body.keyId,{conversationId:f.conversationId,id,senderName:'Alice'},text);
    f.submit=(envelope,actor=f.alice)=>mutate(actor,'POST',`/api/conversations/${f.conversationId}/messages`,envelope);
    return f;
}
module.exports={keyFixture,TestDevice,mutate,actorContext};
