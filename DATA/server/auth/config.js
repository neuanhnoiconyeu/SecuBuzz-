const { isIP } = require('node:net');
const normalizeIp = value => typeof value === 'string' ? value.replace(/^::ffff:/,'') : '';
const loopback = value => ['127.0.0.1','::1'].includes(normalizeIp(value));

function loadAuthConfig(env = process.env) {
    const environment=env.NODE_ENV || 'development';
    if (!['development','test','production'].includes(environment)) throw new Error('NODE_ENV must be development, test or production.');
    const production = environment === 'production';
    const allowHttpLocal = env.AUTH_ALLOW_HTTP_LOCAL === 'true';
    if (production && allowHttpLocal) throw new Error('Local HTTP authentication is forbidden in production.');
    const origins = (env.AUTH_ALLOWED_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
    if (!origins.length) throw new Error('AUTH_ALLOWED_ORIGINS must contain explicit application origins.');
    for (const origin of origins) {
        let url;
        try { url = new URL(origin); } catch { throw new Error('Invalid AUTH_ALLOWED_ORIGINS configuration.'); }
        if (url.origin !== origin || !['https:','http:'].includes(url.protocol) || url.username || url.password ||
            (url.protocol === 'http:' && (!allowHttpLocal || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
            throw new Error('Origins must be canonical HTTPS origins, or explicitly enabled loopback HTTP origins.');
        }
    }
    const trustedProxyIps = (env.AUTH_TRUST_PROXY_IPS || '').split(',').map(value=>value.trim()).filter(Boolean);
    if (trustedProxyIps.some(ip=>!isIP(ip))) throw new Error('AUTH_TRUST_PROXY_IPS accepts exact IP addresses only.');
    function duration(name, fallback, min, max) {
        const value=Number(env[name] || fallback);
        if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name} configuration.`);
        return value;
    }
    return Object.freeze({
        production,allowHttpLocal,origins:Object.freeze(origins),trustedProxyIps:Object.freeze(trustedProxyIps.map(normalizeIp)),
        sessionCookie:allowHttpLocal ? 'secubuzz_session' : '__Host-secubuzz_session',
        preCookie:allowHttpLocal ? 'secubuzz_preauth' : '__Host-secubuzz_preauth',
        sessionTtlMs:duration('AUTH_SESSION_TTL_SECONDS',28800,300,604800)*1000,
        challengeTtlMs:600000,maxChallenges:10000,maxSessions:5
    });
}
module.exports={ loadAuthConfig,normalizeIp,loopback };
