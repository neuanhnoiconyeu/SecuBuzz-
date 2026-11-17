-- Existing relationship projections are historical, not proof of authenticated consent.
ALTER TABLE FriendRequests ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','authenticated'));
ALTER TABLE Friendships ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','authenticated'));
ALTER TABLE Blocks ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy' CHECK(origin IN ('legacy','authenticated'));

CREATE INDEX idx_social_requests_incoming ON FriendRequests(recipient_id,origin,status,created_at,request_id);
CREATE INDEX idx_social_requests_outgoing ON FriendRequests(sender_id,origin,status,created_at,request_id);
CREATE INDEX idx_social_friends_low ON Friendships(user_low,origin,user_high);
CREATE INDEX idx_social_friends_high ON Friendships(user_high,origin,user_low);
CREATE INDEX idx_social_request_pair_history ON FriendRequests(min(sender_id,recipient_id),max(sender_id,recipient_id),origin);
CREATE INDEX idx_social_discovery ON AccountCredentials(status,username_key,user_id);
-- AccountCredentials.username_key already has a UNIQUE B-tree for bounded prefix discovery.

-- Actor-scoped revisions let the frontend reconcile all paginated social collections at one
-- version. These contain no relationship copies and reveal no global activity counter.
CREATE TABLE SocialRevisions (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES Users(user_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision)='integer' AND revision>=0)
);
INSERT INTO SocialRevisions(user_id) SELECT user_id FROM Users;
CREATE TRIGGER social_revision_user AFTER INSERT ON Users BEGIN
    INSERT INTO SocialRevisions(user_id) VALUES(NEW.user_id);
END;
CREATE TRIGGER social_revision_request_insert AFTER INSERT ON FriendRequests WHEN NEW.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (NEW.sender_id,NEW.recipient_id);
END;
CREATE TRIGGER social_revision_request_update AFTER UPDATE ON FriendRequests WHEN NEW.origin='authenticated' OR OLD.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (NEW.sender_id,NEW.recipient_id,OLD.sender_id,OLD.recipient_id);
END;
CREATE TRIGGER social_revision_request_delete AFTER DELETE ON FriendRequests WHEN OLD.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (OLD.sender_id,OLD.recipient_id);
END;
CREATE TRIGGER social_revision_friend_insert AFTER INSERT ON Friendships WHEN NEW.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (NEW.user_low,NEW.user_high);
END;
CREATE TRIGGER social_revision_friend_update AFTER UPDATE ON Friendships WHEN NEW.origin='authenticated' OR OLD.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (NEW.user_low,NEW.user_high,OLD.user_low,OLD.user_high);
END;
CREATE TRIGGER social_revision_friend_delete AFTER DELETE ON Friendships WHEN OLD.origin='authenticated' BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (OLD.user_low,OLD.user_high);
END;
CREATE TRIGGER social_revision_block_insert AFTER INSERT ON Blocks BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=NEW.blocker_id OR (user_id=NEW.blocked_id AND (
        EXISTS(SELECT 1 FROM Friendships WHERE origin='authenticated' AND user_low=min(NEW.blocker_id,NEW.blocked_id) AND user_high=max(NEW.blocker_id,NEW.blocked_id))
        OR EXISTS(SELECT 1 FROM FriendRequests WHERE origin='authenticated' AND min(sender_id,recipient_id)=min(NEW.blocker_id,NEW.blocked_id) AND max(sender_id,recipient_id)=max(NEW.blocker_id,NEW.blocked_id))));
END;
CREATE TRIGGER social_revision_block_update AFTER UPDATE ON Blocks
WHEN NEW.blocker_id IS NOT OLD.blocker_id OR NEW.blocked_id IS NOT OLD.blocked_id BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id IN (NEW.blocker_id,NEW.blocked_id,OLD.blocker_id,OLD.blocked_id);
END;
CREATE TRIGGER social_revision_block_delete AFTER DELETE ON Blocks BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=OLD.blocker_id OR (user_id=OLD.blocked_id AND (
        EXISTS(SELECT 1 FROM Friendships WHERE origin='authenticated' AND user_low=min(OLD.blocker_id,OLD.blocked_id) AND user_high=max(OLD.blocker_id,OLD.blocked_id))
        OR EXISTS(SELECT 1 FROM FriendRequests WHERE origin='authenticated' AND min(sender_id,recipient_id)=min(OLD.blocker_id,OLD.blocked_id) AND max(sender_id,recipient_id)=max(OLD.blocker_id,OLD.blocked_id))));
END;
CREATE TRIGGER social_revision_profile_self AFTER UPDATE ON UserProfiles BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=NEW.user_id;
END;
CREATE TRIGGER social_revision_profile_public AFTER UPDATE OF display_name,avatar ON UserProfiles
WHEN NEW.display_name IS NOT OLD.display_name OR NEW.avatar IS NOT OLD.avatar BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id<>NEW.user_id AND user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=NEW.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=NEW.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=NEW.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=NEW.user_id AND origin='authenticated'
        UNION SELECT blocker_id FROM Blocks WHERE blocked_id=NEW.user_id)
        AND (NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id)
            OR (b.blocker_id=NEW.user_id AND b.blocked_id=SocialRevisions.user_id))
            OR EXISTS(SELECT 1 FROM Blocks b WHERE b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id));
END;
CREATE TRIGGER social_revision_account_insert AFTER INSERT ON AccountCredentials BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=NEW.user_id OR user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=NEW.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=NEW.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=NEW.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=NEW.user_id AND origin='authenticated'
        UNION SELECT blocker_id FROM Blocks WHERE blocked_id=NEW.user_id)
        AND (user_id=NEW.user_id OR NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id)
            OR (b.blocker_id=NEW.user_id AND b.blocked_id=SocialRevisions.user_id))
            OR EXISTS(SELECT 1 FROM Blocks b WHERE b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id));
END;
CREATE TRIGGER social_revision_account_update AFTER UPDATE OF status ON AccountCredentials WHEN NEW.status IS NOT OLD.status BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=NEW.user_id OR user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=NEW.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=NEW.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=NEW.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=NEW.user_id AND origin='authenticated'
        UNION SELECT blocker_id FROM Blocks WHERE blocked_id=NEW.user_id)
        AND (user_id=NEW.user_id OR NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id)
            OR (b.blocker_id=NEW.user_id AND b.blocked_id=SocialRevisions.user_id))
            OR EXISTS(SELECT 1 FROM Blocks b WHERE b.blocker_id=SocialRevisions.user_id AND b.blocked_id=NEW.user_id));
END;
CREATE TRIGGER social_revision_account_delete AFTER DELETE ON AccountCredentials BEGIN
    UPDATE SocialRevisions SET revision=revision+1 WHERE user_id=OLD.user_id OR user_id IN (
        SELECT user_high FROM Friendships WHERE user_low=OLD.user_id AND origin='authenticated'
        UNION SELECT user_low FROM Friendships WHERE user_high=OLD.user_id AND origin='authenticated'
        UNION SELECT sender_id FROM FriendRequests WHERE recipient_id=OLD.user_id AND origin='authenticated'
        UNION SELECT recipient_id FROM FriendRequests WHERE sender_id=OLD.user_id AND origin='authenticated'
        UNION SELECT blocker_id FROM Blocks WHERE blocked_id=OLD.user_id)
        AND (user_id=OLD.user_id OR NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=SocialRevisions.user_id AND b.blocked_id=OLD.user_id)
            OR (b.blocker_id=OLD.user_id AND b.blocked_id=SocialRevisions.user_id))
            OR EXISTS(SELECT 1 FROM Blocks b WHERE b.blocker_id=SocialRevisions.user_id AND b.blocked_id=OLD.user_id));
END;
