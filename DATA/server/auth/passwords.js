const argon2 = require('argon2');
const { randomBytes } = require('node:crypto');
// OWASP Argon2id minimum: 19 MiB, 2 iterations, one lane. No production downgrade switch.
const parameters=Object.freeze({type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1,hashLength:32});
function createPasswordHasher() {
    const dummy=argon2.hash(randomBytes(32),parameters);
    const costs=hash=>typeof hash==='string' && hash.length<=512 && /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
    return {
        hash:password=>argon2.hash(password,parameters),
        async verify(hash,password) {
            const cost=costs(hash);
            if (!cost || +cost[2]>262144 || +cost[3]>10 || +cost[4]>4) {
                await argon2.verify(await dummy,password);
                return false;
            }
            return argon2.verify(hash,password);
        },
        needsRehash(hash) {
            const cost=costs(hash);
            return !!cost && (+cost[1]<19 || +cost[2]<parameters.memoryCost || +cost[3]<parameters.timeCost) && argon2.needsRehash(hash,parameters);
        },
        ready:dummy.then(()=>undefined)
    };
}
module.exports={ createPasswordHasher,parameters };
