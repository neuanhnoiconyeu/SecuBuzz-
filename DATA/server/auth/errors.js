class AuthError extends Error {
    constructor(code,status,fields=[]) { super(code); this.name='AuthError'; this.code=code; this.status=status; this.fields=fields; }
}
function sendError(res,code,status,fields=[]) { return res.status(status).json({code,fields}); }
module.exports={ AuthError,sendError };
