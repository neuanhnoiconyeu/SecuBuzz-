'use strict';

// Test-owned transcription of design section API contracts: groups (DB5-R13).
const common = [[401,'UNAUTHENTICATED'],[401,'SESSION_EXPIRED'],[403,'FORBIDDEN'],
    [400,'VALIDATION_ERROR'],[413,'PAYLOAD_TOO_LARGE'],[415,'UNSUPPORTED_MEDIA_TYPE'],
    [429,'RATE_LIMITED'],[500,'INTERNAL_ERROR'],[503,'FEATURE_UNAVAILABLE'],[503,'SERVICE_UNAVAILABLE']];
const definitions = [
    ['G01','POST','/','any',[201,200],'any',['name','description','historyPolicy','idempotencyKey'],[[409,'IDEMPOTENCY_CONFLICT']]],
    ['G02','GET','/','member',[200],'any',[],[]],
    ['G03','GET','/:id','member',[200],'any',[],[[404,'NOT_FOUND']]],
    ['G04','PATCH','/:id','owner',[200],'any',['name','description','membershipRevision'],[[404,'NOT_FOUND'],[409,'CONFLICT'],[409,'STALE_STATE']]],
    ['G05','GET','/:id/members','member',[200],'any',[],[[404,'NOT_FOUND']]],
    ['G06','POST','/:id/members','admin',[201],'any',['userId'],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G07','DELETE','/:id/members/:userId','admin',[204],'any',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G08','PATCH','/:id/members/:userId','owner',[200],'any',['role','membershipRevision'],[[404,'NOT_FOUND'],[409,'CONFLICT'],[409,'STALE_STATE']]],
    ['G09','POST','/:id/leave','member',[204],'any',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G10','POST','/:id/transfer','owner',[200],'any',['userId','membershipRevision'],[[404,'NOT_FOUND'],[409,'CONFLICT'],[409,'STALE_STATE']]],
    ['G11','POST','/:id/archive','owner',[200],'any',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G12','POST','/:id/invitations','admin',[201],'any',['userId'],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G13','GET','/:id/invitations','admin',[200],'any',[],[[404,'NOT_FOUND']]],
    ['G14','DELETE','/:id/invitations/:invitationId','admin',[204],'any',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G15','GET','/invitations','invitee',[200],'self',[],[]],
    ['G16','POST','/invitations/:invitationId/accept','invitee',[200],'invitee',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G17','POST','/invitations/:invitationId/decline','invitee',[204],'invitee',[],[[404,'NOT_FOUND'],[409,'CONFLICT']]],
    ['G26','GET','/feature-status','any',[200],'any',[],[]]
];
const freeze = value => { if(value && typeof value==='object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const CONTRACT = freeze(definitions.map(([id,method,path,minimumRole,success,scope,requestFields,extra]) => ({
    id,method,path,minimumRole,success,scope,requestFields,
    validationFields: id==='G01'||id==='G04' ? ['historyPolicy'] : [],
    fieldErrors: id==='G01'||id==='G04' ? {historyPolicy:[[400,'VALIDATION_ERROR']]} : {},
    roleQualifier: ({G05:'owner or admin for former=true',G07:'admin removes members only',
        G09:'owner cannot leave',G14:'inviter, owner or admin'})[id] || null,
    errors:[...common,...(method==='GET'?[]:[[403,'CSRF_INVALID']]),...extra]
})));
function assertContractRoutes(routes) {
    const actual=routes.map(({id,method,path})=>`${id} ${method} ${path}`).sort();
    const expected=CONTRACT.map(({id,method,path})=>`${id} ${method} ${path}`).sort();
    require('node:assert/strict').deepEqual(actual,expected,'frozen router table equals the independent contract');
}
function assertContractResponse(id,response) {
    const row=CONTRACT.find(row=>row.id===id);
    if(!row) throw new Error(`unknown contract route ${id}`);
    if(response.status<400) {
        if(!row.success.includes(response.status)) throw new Error(`${id}: undocumented success ${response.status}`);
    } else if(!row.errors.some(([status,code])=>status===response.status&&code===response.body?.code)) {
        throw new Error(`${id}: undocumented error ${response.status} ${response.body?.code}`);
    }
}
function assertGroupResponse(method,url,response) {
    const pathname=new URL(url,'http://localhost').pathname;
    if(pathname!=='/api/groups'&&!pathname.startsWith('/api/groups/'))return response;
    const relative=pathname.slice('/api/groups'.length)||'/';
    const parts=value=>value==='/'?[]:value.split('/').filter(Boolean);
    const match=row=>row.method===(method==='HEAD'?'GET':method)&&(()=>{const a=parts(row.path),b=parts(relative);return a.length===b.length&&a.every((p,i)=>p.startsWith(':')?Boolean(b[i]):p===b[i]);})();
    const row=CONTRACT.find(match);
    // Nonexistent methods/paths still traverse Origin/session/CSRF/gate/rate/body
    // checks. They may return those common errors or the final 404, never success.
    if(!row) {
        const errors=[...common,[403,'CSRF_INVALID'],[404,'NOT_FOUND']];
        if(!errors.some(([status,code])=>status===response.status&&(method==='HEAD'||code===response.body?.code)))
            throw new Error(`unmatched group route returned undocumented response: ${method} ${relative} ${response.status}`);
        return response;
    }
    if(method==='HEAD') {
        if(![...row.success,...row.errors.map(([status])=>status)].includes(response.status))throw new Error(`undocumented HEAD status ${response.status}`);
        return response; // HTTP HEAD carries no JSON error body.
    }
    assertContractResponse(row.id,response);return response;
}
const {Browser:BaseBrowser,setup:baseSetup}=require('./auth');
function wrapBrowser(browser) {
    const request=browser.request.bind(browser);
    browser.request=async(url,options={})=>assertGroupResponse(options.method||'GET',url,await request(url,options));
    const clone=browser.clone.bind(browser);
    browser.clone=()=>wrapBrowser(clone());
    return browser;
}
class Browser extends BaseBrowser {
    constructor(...args) { super(...args);wrapBrowser(this); }
}
async function setup(...args) {
    const fixture=await baseSetup(...args);
    const browser=fixture.browser;
    fixture.browser=()=>wrapBrowser(browser());
    const another=fixture.anotherServer;
    fixture.anotherServer=async()=>wrapBrowser(await another());
    return fixture;
}
module.exports={ CONTRACT, assertContractRoutes, assertContractResponse, assertGroupResponse, setup, Browser };
