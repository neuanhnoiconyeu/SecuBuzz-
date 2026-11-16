const assert=require('node:assert/strict');
const { setup }=require('./auth');
async function socialFixture(t,options={}) {
    const f=await setup(t,options);const actors={};
    for(const name of ['alice','bob','carol']) {
        const browser=f.browser();const username=`social-${name}`;
        assert.equal((await browser.register(username,{displayName:name[0].toUpperCase()+name.slice(1)})).status,201);
        const login=await browser.login(username);assert.equal(login.status,200);
        actors[name]={browser,id:login.body.user.id,username,token:await browser.csrf()};
    }
    return {...f,...actors};
}
async function mutate(actor,method,path,body,headers={}) {
    return actor.browser.request(path,{method,body,headers:{'X-CSRF-Token':actor.token,...headers}});
}
async function send(a,b) {return mutate(a,'POST','/api/friends/requests',{userId:b.id});}
async function befriend(a,b) {
    const sent=await send(a,b);assert.equal(sent.status,201);
    const accepted=await mutate(b,'POST',`/api/friends/requests/${sent.body.request.id}/accept`);
    assert.equal(accepted.status,200);return sent.body.request.id;
}
module.exports={socialFixture,mutate,send,befriend};
