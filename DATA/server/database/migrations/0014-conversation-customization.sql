-- Additive V2.5 customization: persistent profile avatar files, conversation themes, and per-conversation nicknames.
CREATE TABLE UserProfileAvatars (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES Users(user_id) ON DELETE CASCADE,
    storage_key TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
    byte_size INTEGER NOT NULL CHECK(byte_size > 0 AND byte_size <= 2097152),
    sha256 TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ConversationThemes (
    conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES Conversations(conversation_id) ON DELETE CASCADE,
    theme_id TEXT NOT NULL DEFAULT 'default' CHECK(theme_id IN ('default','ocean','sunset','forest','berry','midnight')),
    updated_by TEXT REFERENCES Users(user_id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE ConversationNicknames (
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE CASCADE,
    target_user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE CASCADE,
    nickname TEXT NOT NULL CHECK(length(trim(nickname)) > 0 AND length(nickname) <= 40),
    updated_by TEXT REFERENCES Users(user_id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (conversation_id, target_user_id)
);

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
