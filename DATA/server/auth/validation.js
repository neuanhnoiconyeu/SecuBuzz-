const { AuthError }=require('./errors');
const controls=/[\u0000-\u001f\u007f-\u009f]/u;
function validate(body,registration) {
    const allowed=registration ? ['username','email','password','displayName'] : ['identifier','password'];
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!allowed.includes(key))) {
        throw new AuthError('VALIDATION_ERROR',400);
    }
    const invalid=[];
    const password=body.password;
    // No trimming, normalization, truncation or composition rules; reject malformed surrogate input.
    if (typeof password!=='string' || !password.isWellFormed() || Buffer.byteLength(password)>1024 ||
        [...password].length < (registration ? 15 : 1)) invalid.push('password');
    if (!registration) {
        if (typeof body.identifier!=='string' || !body.identifier.trim() || body.identifier.length>254 || controls.test(body.identifier)) invalid.push('identifier');
        if (invalid.length) throw new AuthError('VALIDATION_ERROR',400,invalid);
        return {identifier:body.identifier.trim().toLowerCase(),password};
    }
    const username=typeof body.username==='string' ? body.username.trim().toLowerCase() : '';
    const email=typeof body.email==='string' ? body.email.trim().toLowerCase() : '';
    if (!/^[a-z0-9][a-z0-9._-]{2,29}$/.test(username) || username==='local-user' || /^demo[-_.:]/.test(username)) invalid.push('username');
    if (email.length>254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
        email.includes('..') || email.startsWith('.') || email.includes('.@')) invalid.push('email');
    const displayName=body.displayName===undefined ? username : typeof body.displayName==='string' ? body.displayName.trim() : '';
    if (!displayName || !displayName.isWellFormed() || [...displayName].length>40 || controls.test(displayName)) invalid.push('displayName');
    if (invalid.length) throw new AuthError('VALIDATION_ERROR',400,invalid);
    return {username,email,displayName,password};
}
module.exports={ validate };
