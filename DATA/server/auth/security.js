const { randomBytes,createHash,createHmac,timingSafeEqual } = require('node:crypto');
const { loopback,normalizeIp } = require('./config');
const tokenPattern=/^[A-Za-z0-9_-]{43}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const freshToken=()=>randomBytes(32).toString('base64url');
const csrfFor=(token,purpose)=>createHmac('sha256',token).update(`secubuzz:csrf:v1:${purpose}`).digest('base64url');
const isToken=value=>typeof value==='string' && tokenPattern.test(value) && Buffer.from(value,'base64url').toString('base64url')===value;
const isDemo=id=>id==='local-user' || (typeof id==='string' && /^demo[-_:]/i.test(id));
function matchesHash(value,expected) {
    return isToken(value) && typeof expected==='string' && /^[a-f0-9]{64}$/.test(expected) &&
        timingSafeEqual(Buffer.from(digest(value),'hex'),Buffer.from(expected,'hex'));
}
function cookieValue(header,name) {
    if (header === undefined) return null;
    if (typeof header!=='string' || header.length>8192) return null;
    const values=header.split(';').map(value=>value.trim()).filter(value=>value.slice(0,value.indexOf('='))===name);
    if (values.length!==1) return null;
    const value=values[0].slice(name.length+1);
    return isToken(value) ? value : null;
}
function setCookie(res,name,token,ttlMs,config) {
    res.cookie(name,token,{httpOnly:true,secure:!config.allowHttpLocal,sameSite:'lax',path:'/',maxAge:ttlMs});
}
function clearCookie(res,name,config) {
    res.clearCookie(name,{httpOnly:true,secure:!config.allowHttpLocal,sameSite:'lax',path:'/'});
}
function secureRequest(req,config) {
    if (req.socket.encrypted===true) return true;
    if (config.trustedProxyIps.includes(normalizeIp(req.socket.remoteAddress)) && req.headers['x-forwarded-proto']==='https') return true;
    return config.allowHttpLocal && loopback(req.socket.remoteAddress);
}
function originAllowed(origin,config) { return typeof origin==='string' && config.origins.includes(origin); }
function requestAllowed(req,config) {
    if (!secureRequest(req,config)) return false;
    if (req.headers.origin!==undefined) return originAllowed(req.headers.origin,config);
    if (!['GET','HEAD'].includes(req.method)) return false;
    if (req.headers['sec-fetch-site'] && !['same-origin','none'].includes(req.headers['sec-fetch-site'])) return false;
    if (req.headers.referer) {
        try { return originAllowed(new URL(req.headers.referer).origin,config); } catch { return false; }
    }
    const protocol=config.allowHttpLocal && !req.socket.encrypted ? 'http' : 'https';
    return originAllowed(`${protocol}://${req.headers.host}`,config);
}
module.exports={ digest,freshToken,csrfFor,isToken,isDemo,matchesHash,cookieValue,setCookie,clearCookie,
    secureRequest,originAllowed,requestAllowed };
