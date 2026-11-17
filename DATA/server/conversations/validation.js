const { createHash } = require('node:crypto');
const { identifier, query, invalid } = require('../social/validation');

function conversationId(value, field='id') {
    // DB-1 legacy IDs encode both user IDs and can exceed the social ID limit.
    if (typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,1023}$/.test(value)) invalid(field);
    return value;
}
function recipient(body) {
    if (!body || typeof body!=='object' || Array.isArray(body) ||
        Object.keys(body).length!==1 || !Object.prototype.hasOwnProperty.call(body,'recipientId')) invalid();
    return identifier(body.recipientId,'recipientId');
}
function page(input,actor) {
    query(input,['limit','cursor']);
    const limit=input.limit===undefined ? 20 : /^[1-9][0-9]?$/.test(input.limit) ? Number(input.limit) : 0;
    if (limit<1 || limit>50) invalid('limit');
    const context=createHash('sha256').update(JSON.stringify({kind:'direct-conversations-v1',actor})).digest('hex');
    let after=null;
    if (input.cursor!==undefined) {
        const encoded=input.cursor;
        if (encoded.length>2048 || !/^[A-Za-z0-9_-]+$/.test(encoded) || Buffer.from(encoded,'base64url').toString('base64url')!==encoded) invalid('cursor');
        let decoded; try { decoded=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')); } catch { invalid('cursor'); }
        if (!decoded || Object.keys(decoded).sort().join(',')!=='context,last,v' || decoded.v!==1 || decoded.context!==context ||
            !Array.isArray(decoded.last) || decoded.last.length!==2 || typeof decoded.last[0]!=='string' ||
            !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(decoded.last[0]) || !Number.isFinite(Date.parse(decoded.last[0]))) invalid('cursor');
        conversationId(decoded.last[1],'cursor'); after=decoded.last;
    }
    return {limit,after,context};
}
module.exports={conversationId,recipient,page,query,invalid};
