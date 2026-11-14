const USER_STATUSES = ['online', 'offline', 'away', 'busy'];
const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'];

function validateUser(req, res, next) {
  const { username, display_name } = req.body;
  if (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 32) {
    return res.status(400).json({ error: 'username must be 2–32 characters' });
  }
  if (typeof display_name !== 'string' || display_name.trim().length < 1 || display_name.trim().length > 80) {
    return res.status(400).json({ error: 'display_name must be 1–80 characters' });
  }
  next();
}

function validateUserUpdate(req, res, next) {
  const { username, display_name, status } = req.body;
  if (username !== undefined && (typeof username !== 'string' || username.trim().length < 2 || username.trim().length > 32)) return res.status(400).json({ error: 'Invalid username' });
  if (display_name !== undefined && (typeof display_name !== 'string' || !display_name.trim() || display_name.trim().length > 80)) return res.status(400).json({ error: 'Invalid display_name' });
  if (status !== undefined && !USER_STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  if (![username, display_name, status].some(value => value !== undefined)) return res.status(400).json({ error: 'Provide at least one field to update' });
  next();
}

function validateMessage(req, res, next) {
  const { sender_id, recipient_id, ciphertext, iv } = req.body;
  if (![sender_id, recipient_id, ciphertext, iv].every(value => typeof value === 'string' && value.length > 0)) {
    return res.status(400).json({ error: 'sender_id, recipient_id, ciphertext, and iv are required strings' });
  }
  if (ciphertext.length > 100000 || iv.length > 256) return res.status(400).json({ error: 'Encrypted message payload is too large or invalid' });
  next();
}

function validateLog(req, res, next) {
  const { event_type, summary, severity = 'info' } = req.body;
  if (typeof event_type !== 'string' || !event_type.trim() || event_type.length > 80) return res.status(400).json({ error: 'event_type is required (max 80 characters)' });
  if (typeof summary !== 'string' || !summary.trim() || summary.length > 500) return res.status(400).json({ error: 'summary is required (max 500 characters)' });
  if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: 'Invalid severity' });
  next();
}

module.exports = { validateUser, validateUserUpdate, validateMessage, validateLog, USER_STATUSES, SEVERITIES };