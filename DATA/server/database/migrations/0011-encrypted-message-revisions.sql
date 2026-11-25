-- Append-only ciphertext revisions. Original Messages rows and all existing triggers remain untouched.
CREATE TABLE MessageEditRevisions (
  message_id TEXT NOT NULL REFERENCES Messages(message_id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 20),
  operation_id TEXT NOT NULL UNIQUE CHECK(length(operation_id)=36),
  sender_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
  signer_device_key_id TEXT NOT NULL REFERENCES DeviceKeys(device_key_id) ON DELETE RESTRICT,
  previous_hash TEXT NOT NULL CHECK(length(previous_hash)=64),
  proof_hash TEXT NOT NULL UNIQUE CHECK(length(proof_hash)=64),
  key_id TEXT NOT NULL CHECK(length(key_id)=22),
  iv TEXT NOT NULL CHECK(length(iv)=16),
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json) AND length(proof_json)<4096),
  envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json) AND length(envelope_json)<131072),
  created_at TEXT NOT NULL,
  PRIMARY KEY(message_id,revision), UNIQUE(key_id,iv)
);
CREATE TRIGGER message_edit_insert_guard BEFORE INSERT ON MessageEditRevisions BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM Messages m WHERE m.message_id=NEW.message_id
    AND m.origin='authenticated' AND m.envelope_version=2 AND m.deleted_at IS NULL AND m.sender_id=NEW.sender_id)
    OR NOT EXISTS(SELECT 1 FROM DeviceKeys d WHERE d.device_key_id=NEW.signer_device_key_id AND d.user_id=NEW.sender_id AND d.status='active')
    OR EXISTS(SELECT 1 FROM Attachments a WHERE a.message_id=NEW.message_id AND a.e2ee_version=1)
    OR NEW.revision<>1+coalesce((SELECT max(revision) FROM MessageEditRevisions WHERE message_id=NEW.message_id),0)
    OR NEW.previous_hash<>coalesce((SELECT proof_hash FROM MessageEditRevisions WHERE message_id=NEW.message_id ORDER BY revision DESC LIMIT 1),(SELECT fingerprint FROM Messages WHERE message_id=NEW.message_id))
    OR EXISTS(SELECT 1 FROM Messages m WHERE m.envelope_version=2 AND m.key_id=NEW.key_id AND m.iv=NEW.iv)
    OR json_extract(NEW.proof_json,'$.revision') IS NOT NEW.revision
    OR json_extract(NEW.proof_json,'$.operationId') IS NOT NEW.operation_id
    OR json_extract(NEW.proof_json,'$.storageId') IS NOT NEW.message_id
    OR json_extract(NEW.proof_json,'$.senderId') IS NOT NEW.sender_id
    OR json_extract(NEW.proof_json,'$.previousHash') IS NOT NEW.previous_hash
    OR json_extract(NEW.proof_json,'$.signerDeviceKeyId') IS NOT NEW.signer_device_key_id
    OR json_extract(NEW.proof_json,'$.v') IS NOT 1
    OR json_extract(NEW.proof_json,'$.keyId') IS NOT NEW.key_id
    OR json_extract(NEW.proof_json,'$.conversationId') IS NOT (SELECT conversation_id FROM Messages WHERE message_id=NEW.message_id)
    OR json_extract(NEW.proof_json,'$.messageId') IS NOT (SELECT client_id FROM Messages WHERE message_id=NEW.message_id)
    OR json_extract(NEW.envelope_json,'$.id') IS NOT NEW.operation_id
    OR json_extract(NEW.envelope_json,'$.senderId') IS NOT NEW.sender_id
    OR json_extract(NEW.envelope_json,'$.conversationId') IS NOT (SELECT conversation_id FROM Messages WHERE message_id=NEW.message_id)
    OR json_extract(NEW.envelope_json,'$.senderName') IS NOT (SELECT sender_name FROM Messages WHERE message_id=NEW.message_id)
    OR json_extract(NEW.envelope_json,'$.timestamp') IS NOT json_extract(NEW.proof_json,'$.editedAt')
    OR json_extract(NEW.envelope_json,'$.type') IS NOT 'text'
    OR json_extract(NEW.envelope_json,'$.encryption.version') IS NOT 2
    OR json_extract(NEW.envelope_json,'$.encryption.keyId') IS NOT NEW.key_id
    OR json_extract(NEW.envelope_json,'$.encryption.iv') IS NOT NEW.iv
    THEN RAISE(ABORT,'message_edit_invalid') END;
END;
CREATE TRIGGER message_edit_immutable BEFORE UPDATE ON MessageEditRevisions BEGIN SELECT RAISE(ABORT,'message_edit_immutable'); END;
CREATE TRIGGER message_edit_no_delete BEFORE DELETE ON MessageEditRevisions BEGIN SELECT RAISE(ABORT,'message_edit_immutable'); END;
CREATE TRIGGER messages_edit_nonce_guard BEFORE INSERT ON Messages WHEN NEW.envelope_version=2 BEGIN
  SELECT CASE WHEN EXISTS(SELECT 1 FROM MessageEditRevisions r WHERE r.key_id=NEW.key_id AND r.iv=NEW.iv)
    THEN RAISE(ABORT,'message_edit_nonce_reuse') END;
END;
