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
function contractVersion(input) {
    query(input,['contractVersion']);
    const value=input.contractVersion ?? '1';
    if(value!=='1'&&value!=='2')invalid('contractVersion');
    return Number(value);
}
function page(input,actor) {
    query(input,['limit','cursor','contractVersion']);
    const version=input.contractVersion ?? '1';
    if(version!=='1'&&version!=='2')invalid('contractVersion');
    const limit=input.limit===undefined ? 20 : /^[1-9][0-9]?$/.test(input.limit) ? Number(input.limit) : 0;
    if (limit<1 || limit>50) invalid('limit');
    const contractVersion=Number(version);
    const context=createHash('sha256').update(JSON.stringify({kind:`direct-conversations-v${contractVersion}`,actor})).digest('hex');
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
    return {limit,after,context,contractVersion};
}
const CONVERSATION_THEME_IDS = ['default', 'ocean', 'sunset', 'forest', 'berry', 'midnight'];
const controls = /[\u0000-\u001f\u007f-\u009f]/u;

function preferencesPatch(body, participantIds) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) invalid();
    const keys = Object.keys(body);
    if (!keys.length || keys.some(key => !['themeId', 'nicknames'].includes(key))) invalid();
    const patch = {};
    if (Object.prototype.hasOwnProperty.call(body, 'themeId')) {
        if (typeof body.themeId !== 'string' || !CONVERSATION_THEME_IDS.includes(body.themeId)) invalid('themeId');
        patch.themeId = body.themeId;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'nicknames')) {
        if (!body.nicknames || typeof body.nicknames !== 'object' || Array.isArray(body.nicknames)) invalid('nicknames');
        const entries = Object.entries(body.nicknames);
        if (!entries.length || entries.length > 2) invalid('nicknames');
        const nicknames = {};
        for (const [targetId, raw] of entries) {
            if (!participantIds.includes(targetId)) invalid('nicknames');
            if (raw === null) { nicknames[targetId] = null; continue; }
            if (typeof raw !== 'string' || !raw.isWellFormed() || controls.test(raw)) invalid('nicknames');
            const trimmed = raw.trim();
            if ([...trimmed].length > 40) invalid('nicknames');
            nicknames[targetId] = trimmed ? trimmed : null;
        }
        patch.nicknames = nicknames;
    }
    return patch;
}

module.exports={conversationId,recipient,page,contractVersion,query,invalid,preferencesPatch,CONVERSATION_THEME_IDS};
