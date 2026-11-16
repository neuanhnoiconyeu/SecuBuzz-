-- Add state to the existing store. Historical envelopes/IDs/receipts remain unchanged.
ALTER TABLE Messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','authenticated'));
ALTER TABLE Messages ADD COLUMN message_seq INTEGER;
ALTER TABLE Messages ADD COLUMN deleted_at TEXT;
ALTER TABLE Messages ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0);

-- Wire message IDs are scoped to the conversation, as in Kiro's MessageStore.
-- The original global PK remains an independent server-generated storage ID.
CREATE UNIQUE INDEX uq_messages_authenticated_client ON Messages(conversation_id,client_id) WHERE origin='authenticated';
CREATE UNIQUE INDEX uq_messages_authenticated_sequence ON Messages(conversation_id,message_seq) WHERE origin='authenticated';
CREATE INDEX idx_messages_authenticated_history ON Messages(conversation_id,message_seq DESC) WHERE origin='authenticated';

CREATE TRIGGER messages_authenticated_insert BEFORE INSERT ON Messages WHEN NEW.origin='authenticated' BEGIN
    SELECT CASE WHEN NEW.envelope_version IS NOT 1 OR NEW.client_id IS NULL OR length(NEW.client_id) NOT BETWEEN 1 AND 256
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
