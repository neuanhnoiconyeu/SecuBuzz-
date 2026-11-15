/**
 * Authentication adapter contract.
 * Your real login/session/JWT middleware MUST set req.user = { user_id: '...' }.
 * Never replace this with a user ID supplied in the request body or an arbitrary header.
 */
function requireAuth(req, res, next) {
  const userId = req.user && (req.user.user_id || req.user.id);
  if (typeof userId !== 'string' || !userId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  req.authUserId = userId;
  next();
}
module.exports = { requireAuth };