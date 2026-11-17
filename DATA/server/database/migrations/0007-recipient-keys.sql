-- Public device keys and signed HPKE-wrapped epochs only. No private or raw AES keys.
CREATE TABLE DeviceKeys (
    device_key_id TEXT NOT NULL PRIMARY KEY CHECK(length(device_key_id)=43),
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    device_id TEXT NOT NULL CHECK(length(device_id)=22),
    key_version INTEGER NOT NULL CHECK(typeof(key_version)='integer' AND key_version BETWEEN 1 AND 1000000),
    created_at TEXT NOT NULL,
    agreement_public_key TEXT NOT NULL CHECK(length(agreement_public_key)=87),
    signing_public_key TEXT NOT NULL CHECK(length(signing_public_key)=87),
    signature TEXT NOT NULL CHECK(length(signature)=86),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','revoked')),
    registered_at TEXT NOT NULL, status_changed_at TEXT,
    UNIQUE(device_id,key_version), UNIQUE(device_key_id,user_id)
);
CREATE INDEX idx_device_keys_user_status ON DeviceKeys(user_id,status);
CREATE INDEX idx_device_keys_device ON DeviceKeys(device_id);
CREATE UNIQUE INDEX uq_device_keys_active ON DeviceKeys(device_id) WHERE status='active';
CREATE TRIGGER device_keys_insert BEFORE INSERT ON DeviceKeys BEGIN
    SELECT CASE WHEN NEW.status<>'active' OR NEW.status_changed_at IS NOT NULL
        OR EXISTS(SELECT 1 FROM DeviceKeys WHERE device_id=NEW.device_id AND (user_id<>NEW.user_id OR status='revoked' OR key_version>=NEW.key_version))
        OR (SELECT count(*) FROM DeviceKeys WHERE user_id=NEW.user_id AND status='active')>=10
        THEN RAISE(ABORT,'invalid_device_transition') END;
END;
CREATE TRIGGER device_keys_immutable BEFORE UPDATE OF device_key_id,user_id,device_id,key_version,created_at,agreement_public_key,signing_public_key,signature,registered_at ON DeviceKeys BEGIN
    SELECT RAISE(ABORT,'device_key_immutable');
END;
CREATE TRIGGER device_keys_status BEFORE UPDATE OF status,status_changed_at ON DeviceKeys BEGIN
    SELECT CASE WHEN NEW.status_changed_at IS NULL OR NOT ((OLD.status='active' AND NEW.status IN ('superseded','revoked')) OR (OLD.status='superseded' AND NEW.status='revoked'))
        THEN RAISE(ABORT,'invalid_device_transition') END;
END;
CREATE TRIGGER device_keys_keep BEFORE DELETE ON DeviceKeys BEGIN SELECT RAISE(ABORT,'device_key_retained'); END;

CREATE TABLE ConversationKeyEpochs (
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    key_id TEXT NOT NULL CHECK(length(key_id)=22),
    epoch INTEGER NOT NULL CHECK(typeof(epoch)='integer' AND epoch BETWEEN 1 AND 1000000000),
    previous_key_id TEXT CHECK(previous_key_id IS NULL OR length(previous_key_id)=22),
    creator_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    creator_device_key_id TEXT NOT NULL,
    created_at TEXT NOT NULL, signature TEXT NOT NULL CHECK(length(signature)=86),
    recipient_set_digest TEXT NOT NULL CHECK(length(recipient_set_digest)=43), published_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id,key_id), UNIQUE(conversation_id,epoch),
    FOREIGN KEY(creator_device_key_id,creator_user_id) REFERENCES DeviceKeys(device_key_id,user_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,creator_user_id) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,previous_key_id) REFERENCES ConversationKeyEpochs(conversation_id,key_id) ON DELETE RESTRICT,
    CHECK((epoch=1)=(previous_key_id IS NULL))
);
CREATE INDEX idx_key_epochs_history ON ConversationKeyEpochs(conversation_id,epoch DESC);
CREATE TRIGGER key_epochs_order BEFORE INSERT ON ConversationKeyEpochs BEGIN
    SELECT CASE WHEN NEW.epoch<>(SELECT coalesce(max(epoch),0)+1 FROM ConversationKeyEpochs WHERE conversation_id=NEW.conversation_id)
        OR (NEW.epoch>1 AND NEW.previous_key_id IS NOT (SELECT key_id FROM ConversationKeyEpochs WHERE conversation_id=NEW.conversation_id ORDER BY epoch DESC LIMIT 1))
        THEN RAISE(ABORT,'invalid_epoch_order') END;
END;
CREATE TRIGGER key_epochs_immutable BEFORE UPDATE ON ConversationKeyEpochs BEGIN SELECT RAISE(ABORT,'epoch_immutable'); END;
CREATE TRIGGER key_epochs_keep BEFORE DELETE ON ConversationKeyEpochs BEGIN SELECT RAISE(ABORT,'epoch_retained'); END;

CREATE TABLE ConversationKeyWraps (
    conversation_id TEXT NOT NULL, key_id TEXT NOT NULL,
    position INTEGER NOT NULL CHECK(typeof(position)='integer' AND position BETWEEN 0 AND 19),
    recipient_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    recipient_device_key_id TEXT NOT NULL,
    enc TEXT NOT NULL CHECK(length(enc)=87), ciphertext TEXT NOT NULL CHECK(length(ciphertext)=64),
    PRIMARY KEY(conversation_id,key_id,recipient_device_key_id), UNIQUE(conversation_id,key_id,position),
    FOREIGN KEY(conversation_id,key_id) REFERENCES ConversationKeyEpochs(conversation_id,key_id) ON DELETE RESTRICT,
    FOREIGN KEY(recipient_device_key_id,recipient_user_id) REFERENCES DeviceKeys(device_key_id,user_id) ON DELETE RESTRICT,
    FOREIGN KEY(conversation_id,recipient_user_id) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT
);
CREATE INDEX idx_key_wraps_device ON ConversationKeyWraps(recipient_device_key_id,conversation_id,key_id);
CREATE TRIGGER key_wraps_immutable BEFORE UPDATE ON ConversationKeyWraps BEGIN SELECT RAISE(ABORT,'wrap_immutable'); END;
CREATE TRIGGER key_wraps_keep BEFORE DELETE ON ConversationKeyWraps BEGIN SELECT RAISE(ABORT,'wrap_retained'); END;

-- Rebuild Messages with foreign_keys ON throughout the runner's immediate transaction.
-- Preserve dependent rows in transaction-local copies, recreate their original constraints,
-- indexes and triggers, and restore every value before foreign_key_check and commit.

CREATE TEMP TABLE _v7_receipts AS SELECT * FROM MessageReceipts;
CREATE TEMP TABLE _v7_attachments AS SELECT * FROM Attachments;
DROP TABLE MessageReceipts;
DROP TABLE Attachments;
CREATE TABLE Messages_v7 (
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
    origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','authenticated')),
    message_seq INTEGER,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
    key_id TEXT,
    FOREIGN KEY(conversation_id,key_id) REFERENCES ConversationKeyEpochs(conversation_id,key_id) ON DELETE RESTRICT,
    CHECK((envelope_version IS NULL AND key_id IS NULL) OR (envelope_version IS 1 AND key_id IS NULL) OR (envelope_version IS 2 AND key_id IS NOT NULL AND length(key_id)=22)),
    CHECK(receiver_id IS NULL OR sender_id <> receiver_id),
    CHECK((envelope_version IS NULL AND encoding IS NULL AND sender_name IS NULL AND client_timestamp IS NULL AND message_type IS NULL AND fingerprint IS NULL)
        OR (envelope_version IS NOT NULL AND envelope_version IN (1,2) AND algorithm = 'AES-256-GCM'
            AND encoding IS NOT NULL AND encoding = 'base64' AND sender_name IS NOT NULL
            AND length(sender_name) > 0 AND client_timestamp IS NOT NULL AND length(client_timestamp) > 0
            AND message_type IS NOT NULL AND message_type = 'text' AND fingerprint IS NOT NULL)),
    FOREIGN KEY(conversation_id,sender_id) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT,
    UNIQUE(conversation_id,message_id), UNIQUE(conversation_id,sender_id,client_id)
);

INSERT INTO Messages_v7 SELECT *,NULL FROM Messages;
DROP TABLE Messages;
ALTER TABLE Messages_v7 RENAME TO Messages;
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
    key_id,algorithm,envelope_version,encoding,sender_name,client_timestamp,message_type,fingerprint,client_id,created_at ON Messages BEGIN
    SELECT RAISE(ABORT,'message_envelope_immutable');
END;


CREATE UNIQUE INDEX uq_messages_authenticated_client ON Messages(conversation_id,client_id) WHERE origin='authenticated';
CREATE UNIQUE INDEX uq_messages_authenticated_sequence ON Messages(conversation_id,message_seq) WHERE origin='authenticated';
CREATE INDEX idx_messages_authenticated_history ON Messages(conversation_id,message_seq DESC) WHERE origin='authenticated';

CREATE TRIGGER messages_authenticated_insert BEFORE INSERT ON Messages WHEN NEW.origin='authenticated' BEGIN
    SELECT CASE WHEN (NEW.envelope_version IS NULL OR NEW.envelope_version NOT IN (1,2)) OR NEW.client_id IS NULL OR length(NEW.client_id) NOT BETWEEN 1 AND 256
        OR NEW.message_seq IS NULL OR typeof(NEW.message_seq)<>'integer' OR NEW.message_seq NOT BETWEEN 1 AND 9007199254740991
        OR NEW.deleted_at IS NOT NULL OR NEW.revision<>0
        THEN RAISE(ABORT,'invalid_authenticated_message') END;
END;
CREATE TRIGGER messages_storage_identity_immutable BEFORE UPDATE OF origin,message_seq ON Messages BEGIN
    SELECT RAISE(ABORT,'message_storage_identity_immutable');
END;
CREATE TRIGGER messages_tombstone_monotonic BEFORE UPDATE OF deleted_at,revision ON Messages BEGIN
    SELECT CASE WHEN OLD.origin<>'authenticated' OR OLD.deleted_at IS NOT NULL OR NEW.deleted_at IS NULL
        OR NEW.revision<>OLD.revision+1 THEN RAISE(ABORT,'invalid_message_lifecycle') END;
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

INSERT INTO MessageReceipts SELECT * FROM _v7_receipts;
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


INSERT INTO Attachments SELECT * FROM _v7_attachments;
DROP TABLE _v7_receipts;
DROP TABLE _v7_attachments;
