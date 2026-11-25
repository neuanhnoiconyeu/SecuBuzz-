const {test}=require('node:test');
const assert=require('node:assert/strict');
const {ATTACHMENT_LIMITS}=require('../../shared/attachmentPolicy.ts');
const {LIMITS,sizeDecision,MESSAGE_LIMITS}=require('../server/attachments/validation');
const {createRandom}=require('./support/random');
const map={image:'imageSizeMb',document:'documentSizeMb',audio:'audioSizeMb',archive:'archiveSizeMb',video:'videoSizeMb'};
function assertPolicyMatches(table){
    for(const [category,key] of Object.entries(map))assert.equal(table[category]*1048576,ATTACHMENT_LIMITS[key]*1048576,`${category} limit`);
}
test('P-39: server per-file and per-message limits match client policy across generated boundaries',()=>{
    assertPolicyMatches(LIMITS);
    for(const [category,key] of Object.entries(map)){
        const limit=ATTACHMENT_LIMITS[key]*1048576;
        for(const n of [0,1,limit-1,limit,limit+1])assert.equal(sizeDecision(n,category).status,n===0?400:n<=limit?200:413);
        const random=createRandom(39001);
        for(let i=0;i<100;i++){
            const n=random.int(0,limit*2);
            assert.equal(sizeDecision(n,category).status,n===0?400:n<=limit?200:413);
        }
    }
    assert.equal(MESSAGE_LIMITS.maxCount,ATTACHMENT_LIMITS.maxCount);
    assert.equal(MESSAGE_LIMITS.maxTotalBytes,ATTACHMENT_LIMITS.maxTotalSizeMb*1048576);
    assert.equal(sizeDecision(52428800).status,200);
    const mutated={...LIMITS,image:LIMITS.image+1};
    assert.throws(()=>assertPolicyMatches(mutated),assert.AssertionError);
});
