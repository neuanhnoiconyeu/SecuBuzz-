-- DB-1 foundation. Legacy tables are preserved except for the validated Messages rebuild.
ALTER TABLE Users ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE Users SET updated_at = created_at;

CREATE TRIGGER users_validate_insert BEFORE INSERT ON Users BEGIN
    SELECT CASE WHEN NEW.user_id IS NULL OR length(trim(NEW.user_id)) = 0
        OR length(trim(NEW.username)) = 0 OR length(trim(NEW.display_name)) = 0
        OR NEW.created_at IS NULL OR NEW.last_seen IS NULL
        THEN RAISE(ABORT, 'invalid_user') END;
END;
CREATE TRIGGER users_validate_update BEFORE UPDATE ON Users BEGIN
    SELECT CASE WHEN NEW.user_id IS NOT OLD.user_id OR length(trim(NEW.username)) = 0
        OR length(trim(NEW.display_name)) = 0 OR NEW.created_at IS NULL OR NEW.last_seen IS NULL
        THEN RAISE(ABORT, 'invalid_user') END;
END;
CREATE TRIGGER users_timestamp_insert AFTER INSERT ON Users BEGIN
    UPDATE Users SET updated_at = NEW.created_at WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER users_timestamp_update AFTER UPDATE OF username, display_name, status, last_seen ON Users BEGIN
    UPDATE Users SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.user_id;
END;

CREATE TABLE UserProfiles (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES Users(user_id) ON DELETE RESTRICT,
    display_name TEXT NOT NULL CHECK(length(trim(display_name)) > 0),
    avatar TEXT NOT NULL DEFAULT 'initials' CHECK(avatar IN ('initials','smile','star','rocket','cat')),
    custom_status TEXT NOT NULL DEFAULT '',
    presence_preference TEXT NOT NULL DEFAULT 'available' CHECK(presence_preference IN ('available','busy','away','invisible')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO UserProfiles(user_id,display_name,created_at,updated_at)
    SELECT user_id,display_name,created_at,created_at FROM Users;
CREATE TRIGGER users_profile_insert AFTER INSERT ON Users BEGIN
    INSERT INTO UserProfiles(user_id,display_name) VALUES(NEW.user_id,NEW.display_name);
END;
CREATE TRIGGER users_profile_update AFTER UPDATE OF display_name ON Users
WHEN NEW.display_name IS NOT OLD.display_name BEGIN
    UPDATE UserProfiles SET display_name = NEW.display_name,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.user_id;
END;
CREATE TRIGGER profile_user_update AFTER UPDATE OF display_name ON UserProfiles
WHEN NEW.display_name IS NOT OLD.display_name BEGIN
    UPDATE Users SET display_name = NEW.display_name WHERE user_id = NEW.user_id AND display_name IS NOT NEW.display_name;
END;

CREATE TABLE Sessions (
    session_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(session_id)) > 0),
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    csrf_token_hash TEXT CHECK(csrf_token_hash IS NULL OR (length(csrf_token_hash) = 64 AND csrf_token_hash NOT GLOB '*[^0-9a-f]*')),
    issued_at_ms INTEGER NOT NULL CHECK(typeof(issued_at_ms) = 'integer' AND issued_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms) = 'integer' AND expires_at_ms > issued_at_ms),
    revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR (typeof(revoked_at_ms) = 'integer' AND revoked_at_ms >= issued_at_ms)),
    last_seen_at_ms INTEGER CHECK(last_seen_at_ms IS NULL OR (typeof(last_seen_at_ms) = 'integer' AND last_seen_at_ms >= issued_at_ms)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_sessions_user_expiry ON Sessions(user_id,expires_at_ms);
CREATE INDEX idx_sessions_expiry ON Sessions(expires_at_ms);

CREATE TABLE FriendRequests (
    request_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(request_id)) > 0),
    sender_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    recipient_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','declined','cancelled')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    resolved_at TEXT,
    CHECK(sender_id <> recipient_id),
    CHECK((status = 'pending' AND resolved_at IS NULL) OR (status <> 'pending' AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX uq_requests_pending_pair ON FriendRequests(min(sender_id,recipient_id),max(sender_id,recipient_id)) WHERE status = 'pending';
CREATE INDEX idx_requests_recipient_status ON FriendRequests(recipient_id,status,created_at);
CREATE INDEX idx_requests_sender_status ON FriendRequests(sender_id,status,created_at);

CREATE TABLE Friendships (
    user_low TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    user_high TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(user_low,user_high), CHECK(user_low < user_high)
);
CREATE INDEX idx_friendships_high ON Friendships(user_high,user_low);
CREATE TABLE Blocks (
    blocker_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    blocked_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(blocker_id,blocked_id), CHECK(blocker_id <> blocked_id)
);
CREATE INDEX idx_blocks_blocked ON Blocks(blocked_id,blocker_id);

-- Preserve original Contacts as compatibility/provenance data; do not infer acceptance dates.
INSERT INTO FriendRequests(request_id,sender_id,recipient_id,created_at)
    SELECT contact_id,user_id,friend_id,created_at FROM Contacts WHERE status = 'pending';
INSERT INTO Friendships(user_low,user_high,created_at)
    SELECT min(user_id,friend_id),max(user_id,friend_id),min(created_at)
    FROM Contacts WHERE status = 'accepted' GROUP BY min(user_id,friend_id),max(user_id,friend_id);
INSERT INTO Blocks(blocker_id,blocked_id,created_at)
    SELECT user_id,friend_id,created_at FROM Contacts WHERE status = 'blocked';

CREATE TABLE Conversations (
    conversation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(conversation_id)) > 0),
    kind TEXT NOT NULL CHECK(kind IN ('direct','group')),
    title TEXT,
    created_by TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    dm_user_low TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    dm_user_high TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    archived_at TEXT,
    CHECK((kind = 'direct' AND dm_user_low IS NOT NULL AND dm_user_high IS NOT NULL AND dm_user_low < dm_user_high AND title IS NULL)
        OR (kind = 'group' AND dm_user_low IS NULL AND dm_user_high IS NULL AND title IS NOT NULL AND length(trim(title)) > 0)),
    UNIQUE(dm_user_low,dm_user_high)
);
CREATE INDEX idx_conversations_updated ON Conversations(updated_at,conversation_id);
CREATE TABLE ConversationMembers (
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('owner','admin','member')),
    joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    left_at TEXT,
    PRIMARY KEY(conversation_id,user_id)
);
CREATE INDEX idx_members_user_active ON ConversationMembers(user_id,left_at,conversation_id);
CREATE UNIQUE INDEX uq_members_active_owner ON ConversationMembers(conversation_id) WHERE role = 'owner' AND left_at IS NULL;
CREATE TRIGGER members_direct_insert BEFORE INSERT ON ConversationMembers BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'direct'
        AND (NEW.user_id NOT IN (dm_user_low,dm_user_high) OR NEW.role <> 'member'))
        THEN RAISE(ABORT,'invalid_direct_member') END;
END;
CREATE TRIGGER members_direct_update BEFORE UPDATE ON ConversationMembers BEGIN
    SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.user_id IS NOT OLD.user_id
        OR EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'direct'
        AND (NEW.user_id NOT IN (dm_user_low,dm_user_high) OR NEW.role <> 'member'))
        THEN RAISE(ABORT,'invalid_member_update') END;
END;
CREATE TRIGGER conversations_identity_update BEFORE UPDATE OF kind, dm_user_low, dm_user_high, conversation_id ON Conversations BEGIN
    SELECT RAISE(ABORT,'conversation_identity_immutable');
END;

-- Hex encoding makes the generated legacy DM IDs collision-free for arbitrary text user IDs.
INSERT INTO Conversations(conversation_id,kind,dm_user_low,dm_user_high,created_at,updated_at)
    SELECT 'legacy-dm:' || hex(min(sender_id,receiver_id)) || ':' || hex(max(sender_id,receiver_id)),
        'direct',min(sender_id,receiver_id),max(sender_id,receiver_id),min(created_at),max(created_at)
    FROM Messages GROUP BY min(sender_id,receiver_id),max(sender_id,receiver_id);
INSERT INTO ConversationMembers(conversation_id,user_id,joined_at)
    SELECT conversation_id,dm_user_low,created_at FROM Conversations
    UNION ALL SELECT conversation_id,dm_user_high,created_at FROM Conversations;

-- Build/copy/validate/drop/rename is safe here: no legacy table references Messages.
CREATE TABLE Messages_next (
    message_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(message_id)) > 0),
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    sender_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    receiver_id TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    ciphertext TEXT NOT NULL CHECK(length(ciphertext) > 0),
    iv TEXT NOT NULL CHECK(length(iv) > 0),
    algorithm TEXT NOT NULL DEFAULT 'AES-256-GCM' CHECK(length(algorithm) > 0),
    envelope_version INTEGER,
    encoding TEXT,
    sender_name TEXT,
    client_timestamp TEXT,
    message_type TEXT,
    fingerprint TEXT CHECK(fingerprint IS NULL OR (length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*')),
    client_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    delivered_at TEXT,
    read_at TEXT,
    CHECK(receiver_id IS NULL OR sender_id <> receiver_id),
    CHECK((envelope_version IS NULL AND encoding IS NULL AND sender_name IS NULL AND client_timestamp IS NULL AND message_type IS NULL AND fingerprint IS NULL)
        OR (envelope_version IS NOT NULL AND envelope_version = 1 AND algorithm = 'AES-256-GCM'
            AND encoding IS NOT NULL AND encoding = 'base64' AND sender_name IS NOT NULL
            AND length(sender_name) > 0 AND client_timestamp IS NOT NULL AND length(client_timestamp) > 0
            AND message_type IS NOT NULL AND message_type = 'text' AND fingerprint IS NOT NULL)),
    FOREIGN KEY(conversation_id,sender_id) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT,
    UNIQUE(conversation_id,message_id), UNIQUE(conversation_id,sender_id,client_id)
);
INSERT INTO Messages_next(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv,algorithm,created_at,updated_at,delivered_at,read_at)
    SELECT message_id,'legacy-dm:' || hex(min(sender_id,receiver_id)) || ':' || hex(max(sender_id,receiver_id)),
        sender_id,receiver_id,ciphertext,iv,algorithm,created_at,created_at,delivered_at,read_at FROM Messages;
DROP TABLE Messages;
ALTER TABLE Messages_next RENAME TO Messages;
CREATE INDEX idx_messages_sender ON Messages(sender_id);
CREATE INDEX idx_messages_receiver ON Messages(receiver_id);
CREATE INDEX idx_messages_created ON Messages(created_at);
CREATE INDEX idx_messages_conversation_cursor ON Messages(conversation_id,created_at,message_id);
CREATE TRIGGER messages_member_insert BEFORE INSERT ON Messages BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM ConversationMembers
        WHERE conversation_id = NEW.conversation_id AND user_id = NEW.sender_id AND left_at IS NULL)
        THEN RAISE(ABORT,'inactive_sender') END;
    SELECT CASE WHEN EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND
        ((kind = 'group' AND NEW.receiver_id IS NOT NULL) OR (kind = 'direct' AND
        (NEW.receiver_id IS NULL OR NEW.receiver_id NOT IN (dm_user_low,dm_user_high)))))
        THEN RAISE(ABORT,'invalid_message_recipient') END;
END;
CREATE TRIGGER messages_envelope_immutable BEFORE UPDATE OF message_id,conversation_id,sender_id,receiver_id,ciphertext,iv,
    algorithm,envelope_version,encoding,sender_name,client_timestamp,message_type,fingerprint,client_id,created_at ON Messages BEGIN
    SELECT RAISE(ABORT,'message_envelope_immutable');
END;

CREATE TABLE MessageReceipts (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('delivered','read')),
    observed_at TEXT NOT NULL,
    recorded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY(conversation_id,message_id,user_id,status),
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,user_id) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX idx_receipts_user ON MessageReceipts(user_id,recorded_at);
CREATE TRIGGER receipts_not_sender BEFORE INSERT ON MessageReceipts BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM Messages WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id AND sender_id=NEW.user_id)
        THEN RAISE(ABORT,'sender_receipt') END;
END;
INSERT INTO MessageReceipts(conversation_id,message_id,user_id,status,observed_at,recorded_at)
    SELECT conversation_id,message_id,receiver_id,'delivered',delivered_at,delivered_at FROM Messages WHERE delivered_at IS NOT NULL
    UNION ALL SELECT conversation_id,message_id,receiver_id,'read',read_at,read_at FROM Messages WHERE read_at IS NOT NULL;

CREATE TABLE Attachments (
    attachment_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(attachment_id)) > 0),
    conversation_id TEXT NOT NULL,
    message_id TEXT,
    uploaded_by TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE CHECK(length(trim(storage_key)) > 0),
    encrypted_metadata TEXT,
    media_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    byte_size INTEGER NOT NULL CHECK(typeof(byte_size) = 'integer' AND byte_size >= 0),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','ready','deleted')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    FOREIGN KEY(conversation_id) REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,uploaded_by) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX idx_attachments_conversation ON Attachments(conversation_id,status,created_at);
CREATE INDEX idx_attachments_message ON Attachments(conversation_id,message_id);

CREATE TABLE AuditLogs (
    audit_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(audit_id)) > 0),
    actor_user_id TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    event_type TEXT NOT NULL CHECK(length(trim(event_type)) > 0),
    severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info','low','medium','high','critical')),
    source TEXT NOT NULL CHECK(length(trim(source)) > 0),
    subject_id TEXT,
    legacy_log_id TEXT UNIQUE REFERENCES SecurityLogs(log_id) ON DELETE RESTRICT,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json) AND json_type(metadata_json) = 'object'),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_actor_created ON AuditLogs(actor_user_id,created_at,audit_id);
CREATE INDEX idx_audit_event_created ON AuditLogs(event_type,created_at,audit_id);
CREATE INDEX idx_audit_created ON AuditLogs(created_at,audit_id);
INSERT INTO AuditLogs(audit_id,actor_user_id,event_type,severity,source,legacy_log_id,created_at)
    SELECT log_id,user_id,event_type,lower(severity),source,log_id,created_at FROM SecurityLogs;
CREATE TRIGGER security_audit_insert AFTER INSERT ON SecurityLogs BEGIN
    INSERT INTO AuditLogs(audit_id,actor_user_id,event_type,severity,source,legacy_log_id,created_at)
        VALUES(NEW.log_id,NEW.user_id,NEW.event_type,lower(NEW.severity),NEW.source,NEW.log_id,NEW.created_at);
END;
