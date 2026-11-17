const { createHash }=require('node:crypto');
const { AuthError }=require('../auth/errors');
const controls=/[\u0000-\u001f\u007f-\u009f]/u;
function invalid(field) { throw new AuthError('VALIDATION_ERROR',400,field ? [field] : []); }
function identifier(value,field='id') {
    if(typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) invalid(field);
    return value;
}
function object(value,allowed) {
    if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(key=>!allowed.includes(key))) invalid();
}
function target(body) { object(body,['userId']);if(Object.keys(body).length!==1)invalid();return identifier(body.userId,'userId'); }
function emptyBody(body) { if(body!==undefined) {object(body,[]);} }
function profilePatch(body) {
    object(body,['displayName','statusMessage','avatar','presencePreference']);
    if(!Object.keys(body).length) invalid();
    const patch={};
    for(const [key,value] of Object.entries(body)) {
        if(typeof value!=='string' || !value.isWellFormed() || controls.test(value)) invalid(key);
        if(key==='displayName' || key==='statusMessage') {
            const text=value.trim();const max=key==='displayName' ? 40 : 160;
            if([...text].length>max || (key==='displayName' && !text)) invalid(key);
            patch[key==='displayName' ? 'display_name' : 'custom_status']=text;
        } else if(key==='avatar') {
            if(!['initials','smile','star','rocket','cat'].includes(value)) invalid(key);
            patch.avatar=value;
        } else {
            if(!['available','busy','away','invisible'].includes(value)) invalid(key);
            patch.presence_preference=value;
        }
    }
    return patch;
}
function query(input,allowed) { object(input,allowed);if(Object.values(input).some(value=>typeof value!=='string'))invalid(); }
function page(input,kind,actor,filters={}) {
    const limit=input.limit===undefined ? 20 : /^[1-9][0-9]?$/.test(input.limit) ? Number(input.limit) : 0;
    if(limit<1 || limit>50)invalid('limit');
    const context=createHash('sha256').update(JSON.stringify({kind,actor,filters})).digest('hex');
    let after=null,revision=input.revision ?? null;
    if(revision!==null && !/^(0|[1-9][0-9]{0,18})$/.test(revision))invalid('revision');
    if(input.cursor!==undefined) {
        const cursor=input.cursor;
        if(cursor.length>1024 || !/^[A-Za-z0-9_-]+$/.test(cursor) || Buffer.from(cursor,'base64url').toString('base64url')!==cursor)invalid('cursor');
        let parsed;try {parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));}catch {invalid('cursor');}
        const keys=kind==='search' ? 'context,last,v' : 'context,last,revision,v';
        if(!parsed || Object.keys(parsed).sort().join(',')!==keys || parsed.v!==1 || parsed.context!==context ||
            !Array.isArray(parsed.last) || parsed.last.length!==2 || parsed.last.some(value=>typeof value!=='string' || value.length>128 || controls.test(value)))invalid('cursor');
        if(kind==='requests') {
            if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(parsed.last[0]) || !Number.isFinite(Date.parse(parsed.last[0])))invalid('cursor');
        } else if(!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(parsed.last[0])) invalid('cursor');
        if(kind!=='search') {
            if(typeof parsed.revision!=='string' || !/^(0|[1-9][0-9]{0,18})$/.test(parsed.revision) || (revision!==null && revision!==parsed.revision))invalid('cursor');
            revision=parsed.revision;
        }
        identifier(parsed.last[1],'cursor');after=parsed.last;
    }
    return {limit,after,context,revision};
}
function resultPage(rows,pagination,project,position,revision) {
    const more=rows.length>pagination.limit;const visible=rows.slice(0,pagination.limit);
    return {items:visible.map(project),nextCursor:more ? Buffer.from(JSON.stringify({v:1,context:pagination.context,last:position(visible.at(-1)),
        ...(revision===undefined ? {} : {revision})})).toString('base64url') : null,...(revision===undefined ? {} : {revision})};
}
module.exports={identifier,target,emptyBody,profilePatch,query,page,resultPage,invalid};
