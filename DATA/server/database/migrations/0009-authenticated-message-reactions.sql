-- Metadata only. No encrypted message fields or existing protection triggers are modified.
CREATE TABLE MessageReactionVersions (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(version)='integer' AND version BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(conversation_id,message_id),
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT
);
CREATE TABLE MessageReactionActors (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    emoji TEXT CHECK(emoji IS NULL OR length(emoji) BETWEEN 1 AND 64),
    revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision BETWEEN 1 AND 9007199254740991),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id,message_id,user_id),
    FOREIGN KEY(conversation_id,message_id) REFERENCES MessageReactionVersions(conversation_id,message_id) ON DELETE RESTRICT
);
CREATE TABLE MessageReactionOperations (
    actor_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    operation_id TEXT NOT NULL CHECK(length(operation_id)=36),
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    emoji TEXT CHECK(emoji IS NULL OR length(emoji) BETWEEN 1 AND 64),
    expected_revision INTEGER NOT NULL CHECK(typeof(expected_revision)='integer' AND expected_revision BETWEEN 0 AND 9007199254740991),
    result_revision INTEGER NOT NULL CHECK(typeof(result_revision)='integer' AND result_revision BETWEEN 0 AND 9007199254740991),
    result_version INTEGER NOT NULL CHECK(typeof(result_version)='integer' AND result_version BETWEEN 0 AND 9007199254740991),
    created_at TEXT NOT NULL,
    PRIMARY KEY(actor_user_id,operation_id),
    FOREIGN KEY(conversation_id,message_id) REFERENCES Messages(conversation_id,message_id) ON DELETE RESTRICT
);
CREATE TRIGGER message_reaction_eligible_insert BEFORE INSERT ON MessageReactionActors BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM Messages m JOIN ConversationMembers c ON c.conversation_id=m.conversation_id
      WHERE m.conversation_id=NEW.conversation_id AND m.message_id=NEW.message_id AND m.origin='authenticated'
      AND m.envelope_version=2 AND m.message_type='text' AND m.deleted_at IS NULL AND c.user_id=NEW.user_id AND c.left_at IS NULL)
      THEN RAISE(ABORT,'invalid_message_reaction') END;
END;
CREATE TRIGGER message_reaction_eligible_update BEFORE UPDATE ON MessageReactionActors BEGIN
    SELECT CASE WHEN NEW.conversation_id<>OLD.conversation_id OR NEW.message_id<>OLD.message_id OR NEW.user_id<>OLD.user_id
      OR NEW.revision<>OLD.revision+1 OR NOT EXISTS(SELECT 1 FROM Messages m JOIN ConversationMembers c ON c.conversation_id=m.conversation_id
      WHERE m.conversation_id=NEW.conversation_id AND m.message_id=NEW.message_id AND m.origin='authenticated'
      AND m.envelope_version=2 AND m.deleted_at IS NULL AND c.user_id=NEW.user_id AND c.left_at IS NULL)
      THEN RAISE(ABORT,'invalid_message_reaction') END;
END;
CREATE TRIGGER message_reactions_unsend AFTER UPDATE OF deleted_at ON Messages
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL BEGIN
    UPDATE MessageReactionVersions SET version=CASE WHEN version<9007199254740991 THEN version+1 ELSE version END
      WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id;
    DELETE FROM MessageReactionActors WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id;
    DELETE FROM MessageReactionOperations WHERE conversation_id=NEW.conversation_id AND message_id=NEW.message_id;
END;
