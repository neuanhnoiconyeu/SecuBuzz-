-- Yahoo! Security Messenger - SQLite Database Schema
-- Version: 1.0
-- Created: 2026-11-02

-- ============================================================================
-- USERS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  public_key TEXT NOT NULL,
  key_rotation_date DATETIME,
  role TEXT DEFAULT 'user' CHECK(role IN ('user', 'moderator', 'admin', 'security_team')),
  status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'suspended', 'deleted')),
  two_factor_enabled BOOLEAN DEFAULT 0,
  two_factor_secret TEXT,
  last_login DATETIME,
  login_attempts INTEGER DEFAULT 0,
  last_login_attempt DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  deleted_at DATETIME
);

CREATE INDEX idx_users_username ON users(username);
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_status ON users(status);

-- ============================================================================
-- CONTACTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  contact_user_id TEXT NOT NULL,
  nickname TEXT,
  is_blocked BOOLEAN DEFAULT 0,
  is_favorite BOOLEAN DEFAULT 0,
  public_key TEXT,
  contact_added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_message_date DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (contact_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, contact_user_id)
);

CREATE INDEX idx_contacts_user_id ON contacts(user_id);
CREATE INDEX idx_contacts_contact_user_id ON contacts(contact_user_id);
CREATE INDEX idx_contacts_is_blocked ON contacts(is_blocked);

-- ============================================================================
-- MESSAGES TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  content_encrypted TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  nonce TEXT NOT NULL,
  is_read BOOLEAN DEFAULT 0,
  read_at DATETIME,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME,
  edited_at DATETIME,
  is_deleted BOOLEAN DEFAULT 0,
  deleted_at DATETIME,
  retention_expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (recipient_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_messages_sender_id ON messages(sender_id);
CREATE INDEX idx_messages_recipient_id ON messages(recipient_id);
CREATE INDEX idx_messages_sent_at ON messages(sent_at);
CREATE INDEX idx_messages_is_read ON messages(is_read);
CREATE INDEX idx_messages_sender_recipient_date ON messages(sender_id, recipient_id, sent_at DESC);

-- ============================================================================
-- SECURITY LOGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS security_logs (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL CHECK(
    event_type IN (
      'login', 'logout', 'login_failed', 'password_changed', 'key_rotated',
      'unauthorized_access', 'policy_violation', 'message_tampered',
      'brute_force_attempt', 'ip_blocked', 'account_suspended',
      'agent_audit', 'agent_threat_detected', 'alert_triggered'
    )
  ),
  severity TEXT DEFAULT 'low' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  user_id TEXT,
  actor_id TEXT,
  source_ip TEXT,
  user_agent TEXT,
  description TEXT,
  metadata JSON,
  agent_name TEXT CHECK(agent_name IN ('auditor_bot', 'sentinel_bot', 'buzz_guard', 'system')),
  is_resolved BOOLEAN DEFAULT 0,
  resolved_at DATETIME,
  resolved_by TEXT,
  resolution_notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_security_logs_event_type ON security_logs(event_type);
CREATE INDEX idx_security_logs_severity ON security_logs(severity);
CREATE INDEX idx_security_logs_user_id ON security_logs(user_id);
CREATE INDEX idx_security_logs_created_at ON security_logs(created_at DESC);
CREATE INDEX idx_security_logs_agent_name ON security_logs(agent_name);
CREATE INDEX idx_security_logs_is_resolved ON security_logs(is_resolved);

-- ============================================================================
-- SESSIONS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  refresh_token_hash TEXT UNIQUE,
  ip_address TEXT NOT NULL,
  user_agent TEXT,
  device_name TEXT,
  is_active BOOLEAN DEFAULT 1,
  expires_at DATETIME NOT NULL,
  refresh_expires_at DATETIME,
  last_activity DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  terminated_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX idx_sessions_is_active ON sessions(is_active);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);

-- ============================================================================
-- ALERTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  title TEXT NOT NULL,
  description TEXT,
  source_agent TEXT CHECK(source_agent IN ('auditor_bot', 'sentinel_bot', 'buzz_guard')),
  related_event_id TEXT,
  is_acknowledged BOOLEAN DEFAULT 0,
  acknowledged_at DATETIME,
  is_dismissed BOOLEAN DEFAULT 0,
  dismissed_at DATETIME,
  channels TEXT,
  buzz_triggered BOOLEAN DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (related_event_id) REFERENCES security_logs(id) ON DELETE SET NULL
);

CREATE INDEX idx_alerts_user_id ON alerts(user_id);
CREATE INDEX idx_alerts_severity ON alerts(severity);
CREATE INDEX idx_alerts_is_acknowledged ON alerts(is_acknowledged);
CREATE INDEX idx_alerts_created_at ON alerts(created_at DESC);

-- ============================================================================
-- IP BLOCKLIST TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS ip_blocklist (
  id TEXT PRIMARY KEY,
  ip_address TEXT NOT NULL UNIQUE,
  reason TEXT,
  severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  blocked_by_agent TEXT CHECK(blocked_by_agent IN ('auditor_bot', 'sentinel_bot', 'system')),
  temporary BOOLEAN DEFAULT 1,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  removed_at DATETIME
);

CREATE INDEX idx_ip_blocklist_ip_address ON ip_blocklist(ip_address);
CREATE INDEX idx_ip_blocklist_expires_at ON ip_blocklist(expires_at);
CREATE INDEX idx_ip_blocklist_temporary ON ip_blocklist(temporary);

-- ============================================================================
-- COMPLIANCE REPORTS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_reports (
  id TEXT PRIMARY KEY,
  report_type TEXT NOT NULL CHECK(report_type IN ('weekly_audit', 'monthly_summary', 'incident_report', 'custom')),
  generated_by TEXT NOT NULL,
  period_start DATETIME NOT NULL,
  period_end DATETIME NOT NULL,
  summary TEXT,
  findings JSON,
  recommendations JSON,
  is_signed BOOLEAN DEFAULT 0,
  signature TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (generated_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_compliance_reports_report_type ON compliance_reports(report_type);
CREATE INDEX idx_compliance_reports_created_at ON compliance_reports(created_at DESC);

-- ============================================================================
-- THREAT INTELLIGENCE TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS threat_intelligence (
  id TEXT PRIMARY KEY,
  threat_type TEXT NOT NULL,
  pattern_signature TEXT UNIQUE NOT NULL,
  severity TEXT DEFAULT 'medium' CHECK(severity IN ('low', 'medium', 'high', 'critical')),
  detected_by_agent TEXT CHECK(detected_by_agent IN ('sentinel_bot', 'system')),
  description TEXT,
  mitigation_steps TEXT,
  is_active BOOLEAN DEFAULT 1,
  occurrence_count INTEGER DEFAULT 1,
  first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_seen DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_threat_intelligence_threat_type ON threat_intelligence(threat_type);
CREATE INDEX idx_threat_intelligence_is_active ON threat_intelligence(is_active);
CREATE INDEX idx_threat_intelligence_last_seen ON threat_intelligence(last_seen DESC);

-- ============================================================================
-- AUDIT TRAIL TABLE (Immutable)
-- ============================================================================

CREATE TABLE IF NOT EXISTS audit_trail (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  user_id TEXT,
  changes JSON,
  reason TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_audit_trail_user_id ON audit_trail(user_id);
CREATE INDEX idx_audit_trail_action ON audit_trail(action);
CREATE INDEX idx_audit_trail_created_at ON audit_trail(created_at DESC);

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Update users.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trigger_users_updated_at
AFTER UPDATE ON users
FOR EACH ROW
BEGIN
  UPDATE users SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Update contacts.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trigger_contacts_updated_at
AFTER UPDATE ON contacts
FOR EACH ROW
BEGIN
  UPDATE contacts SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Update threat_intelligence.updated_at timestamp
CREATE TRIGGER IF NOT EXISTS trigger_threat_intelligence_updated_at
AFTER UPDATE ON threat_intelligence
FOR EACH ROW
BEGIN
  UPDATE threat_intelligence SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Recent Security Events (last 7 days)
CREATE VIEW IF NOT EXISTS v_recent_security_events AS
SELECT
  id,
  event_type,
  severity,
  user_id,
  description,
  agent_name,
  created_at
FROM security_logs
WHERE created_at >= datetime('now', '-7 days')
ORDER BY created_at DESC;

-- Active Sessions by User
CREATE VIEW IF NOT EXISTS v_active_sessions AS
SELECT
  s.id,
  s.user_id,
  u.username,
  s.ip_address,
  s.device_name,
  s.last_activity,
  s.created_at
FROM sessions s
JOIN users u ON s.user_id = u.id
WHERE s.is_active = 1 AND s.expires_at > CURRENT_TIMESTAMP;

-- Outstanding Alerts
CREATE VIEW IF NOT EXISTS v_outstanding_alerts AS
SELECT
  id,
  user_id,
  alert_type,
  severity,
  title,
  is_acknowledged,
  created_at
FROM alerts
WHERE is_dismissed = 0 AND is_acknowledged = 0
ORDER BY severity DESC, created_at DESC;

-- User Activity Summary
CREATE VIEW IF NOT EXISTS v_user_activity_summary AS
SELECT
  u.id,
  u.username,
  COUNT(DISTINCT m.id) as message_count,
  MAX(m.sent_at) as last_message_date,
  COUNT(DISTINCT c.id) as contact_count,
  COUNT(DISTINCT s.id) as active_sessions
FROM users u
LEFT JOIN messages m ON (u.id = m.sender_id OR u.id = m.recipient_id)
LEFT JOIN contacts c ON u.id = c.user_id
LEFT JOIN sessions s ON u.id = s.user_id AND s.is_active = 1
WHERE u.status = 'active'
GROUP BY u.id, u.username;
