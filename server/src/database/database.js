const { randomUUID } = require('node:crypto');
const db = require('./db');

// Data Access Layer (DAL): all SQL is parameterized to prevent SQL injection.
const users = {
  create({ username, display_name }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO Users (user_id, username, display_name) VALUES (?, ?, ?)`)
      .run(id, username.trim(), display_name.trim());
    return this.getById(id);
  },
  getAll() {
    return db.prepare(`SELECT user_id, username, display_name, status, last_seen, created_at, updated_at FROM Users ORDER BY created_at DESC`).all();
  },
  getById(id) {
    return db.prepare(`SELECT user_id, username, display_name, status, last_seen, created_at, updated_at FROM Users WHERE user_id = ?`).get(id);
  },
  update(id, fields) {
    const allowed = ['username', 'display_name', 'status'];
    const entries = Object.entries(fields).filter(([key, value]) => allowed.includes(key) && value !== undefined);
    if (!entries.length) return this.getById(id);
    const setSql = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => typeof value === 'string' ? value.trim() : value);
    db.prepare(`UPDATE Users SET ${setSql}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`).run(...values, id);
    return this.getById(id);
  },
  updateStatus(id, status) {
    db.prepare(`UPDATE Users SET status = ?, last_seen = CASE WHEN ? = 'offline' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE last_seen END, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE user_id = ?`).run(status, status, id);
    return this.getById(id);
  },
  delete(id) {
    return db.prepare(`DELETE FROM Users WHERE user_id = ?`).run(id).changes > 0;
  }
};

const messages = {
  create({ sender_id, recipient_id, ciphertext, iv, auth_tag = null, algorithm = 'AES-256-GCM' }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO Messages (message_id, sender_id, recipient_id, ciphertext, iv, auth_tag, algorithm) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, sender_id, recipient_id, ciphertext, iv, auth_tag, algorithm);
    return this.getById(id);
  },
  getById(id) {
    return db.prepare(`SELECT * FROM Messages WHERE message_id = ?`).get(id);
  },
  getConversation(userA, userB, limit = 100) {
    return db.prepare(`SELECT * FROM Messages WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?) ORDER BY created_at ASC LIMIT ?`)
      .all(userA, userB, userB, userA, limit);
  },
  markDelivered(id) {
    db.prepare(`UPDATE Messages SET delivered_at = COALESCE(delivered_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE message_id = ?`).run(id);
    return this.getById(id);
  },
  markRead(id) {
    db.prepare(`UPDATE Messages SET read_at = COALESCE(read_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE message_id = ?`).run(id);
    return this.getById(id);
  },
  delete(id) {
    return db.prepare(`DELETE FROM Messages WHERE message_id = ?`).run(id).changes > 0;
  }
};

const contacts = {
  add({ user_id, contact_user_id, nickname = null }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO Contacts (contact_id, user_id, contact_user_id, nickname) VALUES (?, ?, ?, ?)`)
      .run(id, user_id, contact_user_id, nickname);
    return db.prepare(`SELECT * FROM Contacts WHERE contact_id = ?`).get(id);
  },
  list(userId) {
    return db.prepare(`SELECT c.contact_id, c.user_id, c.contact_user_id, c.nickname, c.created_at, u.username, u.display_name, u.status FROM Contacts c JOIN Users u ON u.user_id = c.contact_user_id WHERE c.user_id = ? ORDER BY u.username`).all(userId);
  },
  remove(id) {
    return db.prepare(`DELETE FROM Contacts WHERE contact_id = ?`).run(id).changes > 0;
  }
};

const logs = {
  create({ actor_user_id = null, event_type, severity = 'info', summary, source = 'system', finding_code = null }) {
    const id = randomUUID();
    db.prepare(`INSERT INTO SecurityLogs (log_id, actor_user_id, event_type, severity, summary, source, finding_code) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, actor_user_id, event_type, severity, summary, source, finding_code);
    return this.getById(id);
  },
  getById(id) { return db.prepare(`SELECT * FROM SecurityLogs WHERE log_id = ?`).get(id); },
  list({ severity, limit = 100 } = {}) {
    if (severity) return db.prepare(`SELECT * FROM SecurityLogs WHERE severity = ? ORDER BY created_at DESC LIMIT ?`).all(severity, limit);
    return db.prepare(`SELECT * FROM SecurityLogs ORDER BY created_at DESC LIMIT ?`).all(limit);
  }
};

module.exports = { db, users, messages, contacts, logs };