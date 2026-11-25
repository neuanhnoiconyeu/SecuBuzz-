CREATE TABLE UserProfileAvatars_v15 (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES Users(user_id) ON DELETE RESTRICT,
    storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
    byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 2097152),
    sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO UserProfileAvatars_v15(user_id,storage_key,mime_type,byte_size,sha256,updated_at)
    SELECT user_id,storage_key,mime_type,byte_size,sha256,updated_at FROM UserProfileAvatars;
DROP TRIGGER social_revision_avatar_insert;
DROP TRIGGER social_revision_avatar_update;
DROP TRIGGER social_revision_avatar_delete;
DROP TABLE UserProfileAvatars;
ALTER TABLE UserProfileAvatars_v15 RENAME TO UserProfileAvatars;
CREATE TRIGGER social_revision_avatar_insert AFTER INSERT ON UserProfileAvatars BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id<>NEW.user_id AND user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=NEW.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=NEW.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=NEW.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=NEW.user_id AND origin='authenticated');
END;
CREATE TRIGGER social_revision_avatar_update AFTER UPDATE ON UserProfileAvatars BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id<>NEW.user_id AND user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=NEW.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=NEW.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=NEW.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=NEW.user_id AND origin='authenticated');
END;
CREATE TRIGGER social_revision_avatar_delete AFTER DELETE ON UserProfileAvatars BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id<>OLD.user_id AND user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=OLD.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=OLD.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=OLD.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=OLD.user_id AND origin='authenticated');
END;

CREATE TABLE ConversationThemes_v15 (
    conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    theme_id TEXT NOT NULL DEFAULT 'default' CHECK(theme_id IN ('default','ocean','sunset','forest','berry','midnight')),
    updated_by TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO ConversationThemes_v15(conversation_id,theme_id,updated_by,updated_at)
    SELECT conversation_id,theme_id,updated_by,updated_at FROM ConversationThemes;
DROP TABLE ConversationThemes;
ALTER TABLE ConversationThemes_v15 RENAME TO ConversationThemes;

CREATE TABLE ConversationNicknames_v15 (
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    target_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    nickname TEXT NOT NULL CHECK(length(trim(nickname)) > 0 AND length(nickname) <= 40),
    updated_by TEXT REFERENCES Users(user_id) ON DELETE RESTRICT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (conversation_id, target_user_id)
);
INSERT INTO ConversationNicknames_v15(conversation_id,target_user_id,nickname,updated_by,updated_at)
    SELECT conversation_id,target_user_id,nickname,updated_by,updated_at FROM ConversationNicknames;
DROP TABLE ConversationNicknames;
ALTER TABLE ConversationNicknames_v15 RENAME TO ConversationNicknames;
