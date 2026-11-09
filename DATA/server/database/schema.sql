
PRAGMA foreign_keys = ON;

-- ==========================================
-- 1. USERS
-- ==========================================

CREATE TABLE IF NOT EXISTS Users (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'offline'
        CHECK (status IN ('online', 'offline', 'away')),

    last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. CONTACTS
-- ==========================================

CREATE TABLE IF NOT EXISTS Contacts (
    contact_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    friend_id TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'blocked')),

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    FOREIGN KEY (user_id) REFERENCES Users(user_id),
    FOREIGN KEY (friend_id) REFERENCES Users(user_id),

    UNIQUE (user_id, friend_id),
    CHECK (user_id != friend_id)
);

-- ==========================================
-- 3. MESSAGES
-- ==========================================

CREATE TABLE IF NOT EXISTS Messages (
    message_id TEXT PRIMARY KEY,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,

    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,

    algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    delivered_at DATETIME,
    read_at DATETIME,

    FOREIGN KEY (sender_id) REFERENCES Users(user_id),
    FOREIGN KEY (receiver_id) REFERENCES Users(user_id)
);

-- ==========================================
-- 4. SECURITY LOGS
-- ==========================================

CREATE TABLE IF NOT EXISTS SecurityLogs (
    log_id TEXT PRIMARY KEY,
    user_id TEXT,

    event_type TEXT NOT NULL,

    severity TEXT NOT NULL
        CHECK (
            severity IN (
                'LOW',
                'MEDIUM',
                'HIGH',
                'CRITICAL'
            )
        ),

    source TEXT NOT NULL
        CHECK (
            source IN (
                'auditor_bot',
                'sentinel_bot',
                'buzz_guard'
            )
        ),

    description TEXT NOT NULL,
    details_json TEXT,

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,

    resolved INTEGER NOT NULL DEFAULT 0
        CHECK (resolved IN (0, 1)),

    FOREIGN KEY (user_id) REFERENCES Users(user_id)
);

-- ==========================================
-- 5. PERFORMANCE INDEXES
-- ==========================================

CREATE INDEX IF NOT EXISTS idx_messages_sender
ON Messages(sender_id);

CREATE INDEX IF NOT EXISTS idx_messages_receiver
ON Messages(receiver_id);

CREATE INDEX IF NOT EXISTS idx_messages_created
ON Messages(created_at);

CREATE INDEX IF NOT EXISTS idx_contacts_user
ON Contacts(user_id);

CREATE INDEX IF NOT EXISTS idx_security_severity
ON SecurityLogs(severity);

CREATE INDEX IF NOT EXISTS idx_security_created
ON SecurityLogs(created_at);