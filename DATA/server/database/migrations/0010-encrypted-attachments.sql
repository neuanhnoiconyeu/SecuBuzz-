-- Additive metadata over DATA's existing ledger. Binary bytes use DB6 private storage.
-- No message envelopes, keys, existing triggers, or previous migrations are changed.
ALTER TABLE Attachments ADD COLUMN e2ee_version INTEGER CHECK(e2ee_version IS NULL OR e2ee_version=1);
ALTER TABLE Attachments ADD COLUMN client_message_id TEXT CHECK(client_message_id IS NULL OR length(client_message_id)=36);
ALTER TABLE Attachments ADD COLUMN ciphertext_sha256 TEXT CHECK(ciphertext_sha256 IS NULL OR length(ciphertext_sha256)=64);
ALTER TABLE Attachments ADD COLUMN expires_at TEXT;
ALTER TABLE Attachments ADD COLUMN purged_at TEXT;
CREATE INDEX idx_attachment_wire ON Attachments(conversation_id,client_message_id,uploaded_by);
CREATE INDEX idx_attachment_cleanup ON Attachments(e2ee_version,status,purged_at,expires_at);
CREATE TABLE EncryptedAttachmentBatches (
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    client_message_id TEXT NOT NULL CHECK(length(client_message_id)=36),
    uploaded_by TEXT NOT NULL,
    attachment_ids TEXT NOT NULL CHECK(json_valid(attachment_ids) AND json_type(attachment_ids)='array' AND json_array_length(attachment_ids) BETWEEN 1 AND 5),
    status TEXT NOT NULL CHECK(status IN ('sealed','committed','revoked')),
    expires_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id,client_message_id),
    FOREIGN KEY(conversation_id,uploaded_by) REFERENCES ConversationMembers(conversation_id,user_id) ON DELETE RESTRICT
);
CREATE TRIGGER encrypted_attachment_batch_insert BEFORE INSERT ON EncryptedAttachmentBatches BEGIN
    SELECT CASE WHEN NEW.status<>'sealed' OR EXISTS(SELECT 1 FROM Messages m
        WHERE m.conversation_id=NEW.conversation_id AND m.client_id=NEW.client_message_id)
      OR (SELECT count(*) FROM Attachments a WHERE a.e2ee_version=1 AND a.status='pending'
        AND a.conversation_id=NEW.conversation_id AND a.client_message_id=NEW.client_message_id
        AND a.uploaded_by=NEW.uploaded_by)<>json_array_length(NEW.attachment_ids)
      OR EXISTS(SELECT 1 FROM json_each(NEW.attachment_ids) i WHERE i.type<>'text' OR NOT EXISTS(
        SELECT 1 FROM Attachments a WHERE a.attachment_id=i.value AND a.e2ee_version=1 AND a.status='pending'
        AND a.conversation_id=NEW.conversation_id AND a.client_message_id=NEW.client_message_id AND a.uploaded_by=NEW.uploaded_by))
      THEN RAISE(ABORT,'invalid_encrypted_attachment_batch') END;
END;
CREATE TRIGGER encrypted_attachment_batch_immutable BEFORE UPDATE ON EncryptedAttachmentBatches BEGIN
    SELECT CASE WHEN NEW.conversation_id<>OLD.conversation_id OR NEW.client_message_id<>OLD.client_message_id
      OR NEW.uploaded_by<>OLD.uploaded_by OR NEW.attachment_ids<>OLD.attachment_ids OR NEW.expires_at<>OLD.expires_at
      OR (OLD.status='revoked' AND NEW.status<>'revoked') OR (OLD.status='committed' AND NEW.status='sealed')
      OR (NEW.status='committed' AND NOT EXISTS(SELECT 1 FROM Messages m WHERE m.conversation_id=OLD.conversation_id
        AND m.client_id=OLD.client_message_id AND m.sender_id=OLD.uploaded_by AND m.origin='authenticated'
        AND m.envelope_version=2 AND m.deleted_at IS NULL))
      THEN RAISE(ABORT,'invalid_encrypted_attachment_batch_update') END;
END;
CREATE TRIGGER encrypted_attachment_scope_insert BEFORE INSERT ON Attachments WHEN NEW.e2ee_version=1 BEGIN
    SELECT CASE WHEN NEW.client_message_id IS NULL OR NEW.ciphertext_sha256 IS NULL OR NEW.expires_at IS NULL
      OR NEW.message_id IS NOT NULL OR NEW.status<>'pending' OR NEW.byte_size<17
      OR NEW.media_type<>'application/octet-stream' OR NEW.encrypted_metadata IS NOT NULL OR NEW.purged_at IS NOT NULL
      OR EXISTS(SELECT 1 FROM EncryptedAttachmentBatches b WHERE b.conversation_id=NEW.conversation_id AND b.client_message_id=NEW.client_message_id)
      OR (SELECT count(*) FROM Attachments a WHERE a.e2ee_version=1 AND a.conversation_id=NEW.conversation_id
        AND a.client_message_id=NEW.client_message_id AND a.uploaded_by=NEW.uploaded_by AND a.status<>'deleted')>=5
      OR NOT EXISTS(SELECT 1 FROM Conversations c JOIN ConversationMembers m ON m.conversation_id=c.conversation_id
        WHERE c.conversation_id=NEW.conversation_id AND c.origin='authenticated' AND c.archived_at IS NULL
        AND m.user_id=NEW.uploaded_by AND m.left_at IS NULL)
      THEN RAISE(ABORT,'invalid_encrypted_attachment') END;
END;
CREATE TRIGGER encrypted_attachment_immutable BEFORE UPDATE ON Attachments WHEN OLD.e2ee_version=1 BEGIN
    SELECT CASE WHEN NEW.attachment_id<>OLD.attachment_id OR NEW.conversation_id<>OLD.conversation_id
      OR NEW.uploaded_by<>OLD.uploaded_by OR NEW.client_message_id IS NOT OLD.client_message_id
      OR NEW.e2ee_version IS NOT OLD.e2ee_version OR NEW.ciphertext_sha256 IS NOT OLD.ciphertext_sha256
      OR NEW.storage_key<>OLD.storage_key OR NEW.byte_size<>OLD.byte_size OR NEW.expires_at IS NOT OLD.expires_at
      OR NEW.encrypted_metadata IS NOT OLD.encrypted_metadata OR NEW.media_type<>OLD.media_type
      OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id)
      OR (OLD.status='deleted' AND NEW.status<>'deleted')
      OR (OLD.status='ready' AND NEW.status='pending')
      OR (NEW.status='ready' AND NOT EXISTS(SELECT 1 FROM EncryptedAttachmentBatches b,json_each(b.attachment_ids) i
        WHERE b.conversation_id=OLD.conversation_id AND b.client_message_id=OLD.client_message_id
        AND b.uploaded_by=OLD.uploaded_by AND b.status IN ('sealed','committed') AND i.value=OLD.attachment_id))
      OR (NEW.status='ready' AND NOT EXISTS(SELECT 1 FROM Messages m WHERE m.message_id=NEW.message_id
        AND m.conversation_id=OLD.conversation_id AND m.client_id=OLD.client_message_id AND m.sender_id=OLD.uploaded_by
        AND m.origin='authenticated' AND m.envelope_version=2 AND m.deleted_at IS NULL))
      THEN RAISE(ABORT,'invalid_encrypted_attachment_update') END;
END;
CREATE TRIGGER encrypted_attachments_unsend AFTER UPDATE OF deleted_at ON Messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE Attachments SET status='deleted',updated_at=NEW.updated_at
      WHERE e2ee_version=1 AND message_id=NEW.message_id AND conversation_id=NEW.conversation_id;
    UPDATE EncryptedAttachmentBatches SET status='revoked'
      WHERE conversation_id=NEW.conversation_id AND client_message_id=NEW.client_id AND uploaded_by=NEW.sender_id;
END;
