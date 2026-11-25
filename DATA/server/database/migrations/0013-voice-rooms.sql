-- Independent authenticated community-room catalog. Message/key contracts are unchanged.
CREATE TABLE VoiceRooms (
 room_id TEXT PRIMARY KEY NOT NULL CHECK(length(room_id) BETWEEN 1 AND 64),
 owner_id TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 64),
 name_key TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
 CHECK(owner_id IS NOT NULL OR room_id IN ('lounge','study-room','dev-corner'))
);
CREATE UNIQUE INDEX voice_rooms_active_name ON VoiceRooms(name_key) WHERE deleted_at IS NULL;
CREATE INDEX voice_rooms_owner ON VoiceRooms(owner_id) WHERE deleted_at IS NULL;
CREATE TRIGGER voice_rooms_identity BEFORE UPDATE ON VoiceRooms BEGIN
 SELECT CASE WHEN NEW.room_id IS NOT OLD.room_id OR NEW.owner_id IS NOT OLD.owner_id
  OR NEW.created_at IS NOT OLD.created_at OR OLD.deleted_at IS NOT NULL OR OLD.owner_id IS NULL
  THEN RAISE(ABORT,'voice_room_immutable') END;
END;
CREATE TRIGGER voice_rooms_retained BEFORE DELETE ON VoiceRooms BEGIN
 SELECT RAISE(ABORT,'voice_room_retained');
END;
INSERT INTO VoiceRooms(room_id,owner_id,name,name_key,created_at,updated_at) VALUES
 ('lounge',NULL,'Lounge','lounge',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('study-room',NULL,'Study Room','study room',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('dev-corner',NULL,'Dev Corner','dev corner',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
