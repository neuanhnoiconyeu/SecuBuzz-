-- Shared pin metadata only. Existing message envelopes, lifecycle constraints and keys are unchanged.
CREATE TABLE ConversationPinVersions (
    conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740991)
);
CREATE TABLE MessagePins (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pinned_by TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    pinned_at TEXT NOT NULL CHECK(length(pinned_at) BETWEEN 20 AND 40),
    PRIMARY KEY(conversation_id,message_id),
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT
);
CREATE TABLE MessagePinOperations (
    actor_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
    expected_version INTEGER NOT NULL CHECK(typeof(expected_version)='integer' AND expected_version BETWEEN 0 AND 9007199254740991),
    result_version INTEGER NOT NULL CHECK(typeof(result_version)='integer' AND result_version BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    PRIMARY KEY(actor_user_id,operation_id),
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT
);
CREATE TRIGGER message_pins_eligible_insert BEFORE INSERT ON MessagePins BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM Messages m JOIN ConversationMembers c ON c.conversation_id=m.conversation_id
        WHERE m.conversation_id=NEW.conversation_id AND m.message_id=NEW.message_id
          AND m.origin='authenticated' AND m.envelope_version=2 AND m.message_type='text' AND m.deleted_at IS NULL
          AND c.user_id=NEW.pinned_by AND c.left_at IS NULL
    ) THEN RAISE(ABORT,'invalid_message_pin') END;
END;
CREATE TRIGGER message_pins_immutable BEFORE UPDATE ON MessagePins BEGIN
    SELECT RAISE(ABORT,'message_pin_immutable');
END;
-- Unsend removes the shared pin atomically, without updating any encrypted message fields.
CREATE TRIGGER message_pins_unsend AFTER UPDATE OF deleted_at ON Messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE ConversationPinVersions SET version=CASE WHEN version<9007199254740991 THEN version+1 ELSE version END
      WHERE conversation_id=NEW.conversation_id
        AND EXISTS(SELECT 1 FROM MessagePins WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id);
    DELETE FROM MessagePins WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id;
END;
