-- DB-6B reconciliation migration. Applies after main's 0008-0012 history.
-- main 0010-encrypted-attachments.sql already added expires_at; this migration does not repeat it.
-- All DB-6B triggers are scoped to canonical rows (e2ee_version IS NULL) so main's
-- e2ee_version=1 encrypted-attachment lifecycle and its triggers remain authoritative for those rows.
ALTER TABLE Attachments ADD COLUMN integrity_digest TEXT CHECK(integrity_digest IS NULL OR (length(integrity_digest) = 64 AND integrity_digest NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE Attachments ADD COLUMN deleted_at TEXT;
ALTER TABLE Attachments ADD COLUMN purge_state TEXT NOT NULL DEFAULT 'not_purged' CHECK(purge_state IN ('not_purged','purged'));
ALTER TABLE Attachments ADD COLUMN declared_algorithm TEXT CHECK(declared_algorithm IS NULL OR length(declared_algorithm) BETWEEN 1 AND 64);
ALTER TABLE Attachments ADD COLUMN declared_format_version TEXT CHECK(declared_format_version IS NULL OR length(declared_format_version) BETWEEN 1 AND 64);

CREATE INDEX idx_attachments_pending_expiry ON Attachments(expires_at) WHERE status = 'pending';
CREATE INDEX idx_attachments_uploader_usage ON Attachments(uploaded_by, status);
CREATE INDEX idx_attachments_search ON Attachments(conversation_id, created_at DESC, attachment_id DESC) WHERE status = 'ready';
CREATE INDEX idx_attachments_purge ON Attachments(deleted_at) WHERE status = 'deleted' AND purge_state = 'not_purged';

CREATE TRIGGER attachments_immutable BEFORE UPDATE OF attachment_id, conversation_id, uploaded_by, storage_key, byte_size, created_at,
    integrity_digest, declared_algorithm, declared_format_version, encrypted_metadata, media_type ON Attachments
    WHEN NEW.e2ee_version IS NULL BEGIN
    SELECT RAISE(ABORT,'attachment_identity_immutable');
END;

CREATE TRIGGER attachments_lifecycle BEFORE UPDATE ON Attachments WHEN NEW.e2ee_version IS NULL BEGIN
    SELECT CASE WHEN OLD.status = 'deleted' AND (
        NEW.attachment_id IS NOT OLD.attachment_id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.message_id IS NOT OLD.message_id
        OR NEW.uploaded_by IS NOT OLD.uploaded_by OR NEW.storage_key IS NOT OLD.storage_key OR NEW.encrypted_metadata IS NOT OLD.encrypted_metadata
        OR NEW.media_type IS NOT OLD.media_type OR NEW.byte_size IS NOT OLD.byte_size OR NEW.status IS NOT OLD.status
        OR NEW.created_at IS NOT OLD.created_at OR NEW.updated_at IS NOT OLD.updated_at OR NEW.integrity_digest IS NOT OLD.integrity_digest
        OR NEW.expires_at IS NOT OLD.expires_at OR NEW.deleted_at IS NOT OLD.deleted_at
        OR NEW.declared_algorithm IS NOT OLD.declared_algorithm OR NEW.declared_format_version IS NOT OLD.declared_format_version
        OR (NEW.purge_state IS NOT OLD.purge_state AND NOT (OLD.purge_state = 'not_purged' AND NEW.purge_state = 'purged')))
        THEN RAISE(ABORT,'invalid_attachment_lifecycle') END;
    SELECT CASE WHEN (OLD.status = 'deleted' AND (NEW.status IS NOT OLD.status OR NEW.message_id IS NOT OLD.message_id OR NEW.deleted_at IS NOT OLD.deleted_at))
        OR (NEW.status IS NOT OLD.status AND NOT ((OLD.status = 'pending' AND NEW.status IN ('ready','deleted')) OR (OLD.status = 'ready' AND NEW.status = 'deleted')))
        OR (NEW.status = 'ready' AND NEW.message_id IS NULL)
        OR (OLD.message_id IS NOT NULL AND NEW.message_id IS NOT OLD.message_id)
        OR (OLD.message_id IS NULL AND NEW.message_id IS NOT NULL AND NOT (OLD.status = 'pending' AND NEW.status = 'ready'))
        OR ((NEW.status = 'deleted') <> (NEW.deleted_at IS NOT NULL))
        OR (NEW.purge_state = 'purged' AND NEW.status <> 'deleted')
        OR (OLD.purge_state = 'purged' AND NEW.purge_state <> 'purged')
        THEN RAISE(ABORT,'invalid_attachment_lifecycle')
END;

    SELECT CASE WHEN OLD.message_id IS NULL AND NEW.message_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM Messages m
        WHERE m.conversation_id = NEW.conversation_id AND m.message_id = NEW.message_id AND m.sender_id = NEW.uploaded_by)
        THEN RAISE(ABORT,'attachment_message_sender') END;
END;

CREATE TRIGGER attachments_metadata_insert BEFORE INSERT ON Attachments WHEN NEW.e2ee_version IS NULL BEGIN
    SELECT CASE WHEN length(NEW.encrypted_metadata) > 16384 THEN RAISE(ABORT,'attachment_metadata_too_long') END;
END;

CREATE TABLE AttachmentReservations (
    reservation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(reservation_id)) > 0),
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    declared_bytes INTEGER NOT NULL CHECK(typeof(declared_bytes) = 'integer' AND declared_bytes >= 1),
    source_digest TEXT NOT NULL CHECK(length(source_digest) = 64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);
CREATE INDEX idx_reservations_user ON AttachmentReservations(user_id);
CREATE INDEX idx_reservations_conversation ON AttachmentReservations(conversation_id);
CREATE INDEX idx_reservations_source ON AttachmentReservations(source_digest);
CREATE INDEX idx_reservations_expiry ON AttachmentReservations(expires_at);
