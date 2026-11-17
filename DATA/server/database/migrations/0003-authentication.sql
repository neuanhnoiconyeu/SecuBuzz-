-- Private account data is separate from the legacy public Users projection.
CREATE TABLE AccountCredentials (
    user_id TEXT NOT NULL PRIMARY KEY REFERENCES Users(user_id) ON DELETE RESTRICT,
    username_key TEXT NOT NULL UNIQUE CHECK(username_key = lower(username_key) AND length(username_key) BETWEEN 3 AND 30),
    email_key TEXT NOT NULL UNIQUE CHECK(email_key = lower(email_key) AND length(email_key) BETWEEN 3 AND 254),
    password_hash TEXT NOT NULL CHECK(password_hash LIKE '$argon2id$%'),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
    auth_version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(auth_version)='integer' AND auth_version >= 1),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
ALTER TABLE Sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK(typeof(auth_version)='integer' AND auth_version >= 0);
CREATE INDEX idx_users_username_lower ON Users(lower(username));
CREATE TRIGGER users_username_unique_insert BEFORE INSERT ON Users BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM Users WHERE lower(username)=lower(NEW.username))
        THEN RAISE(ABORT,'username_unavailable') END;
END;
CREATE TRIGGER users_username_unique_update BEFORE UPDATE OF username ON Users BEGIN
    SELECT CASE WHEN EXISTS(SELECT 1 FROM Users WHERE lower(username)=lower(NEW.username) AND user_id<>OLD.user_id)
        OR (EXISTS(SELECT 1 FROM AccountCredentials WHERE user_id=OLD.user_id) AND NEW.username IS NOT OLD.username)
        THEN RAISE(ABORT,'username_unavailable') END;
END;
CREATE TRIGGER credentials_identity_insert BEFORE INSERT ON AccountCredentials BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM Users WHERE user_id=NEW.user_id AND lower(username)=NEW.username_key)
        OR NEW.user_id='local-user' OR lower(NEW.user_id) GLOB 'demo[-_:]*'
        THEN RAISE(ABORT,'invalid_account_identity') END;
END;
CREATE TRIGGER credentials_identity_update BEFORE UPDATE OF user_id,username_key ON AccountCredentials BEGIN
    SELECT RAISE(ABORT,'account_identity_immutable');
END;
CREATE TRIGGER credentials_security_update AFTER UPDATE OF password_hash,status ON AccountCredentials
WHEN NEW.password_hash IS NOT OLD.password_hash OR NEW.status IS NOT OLD.status BEGIN
    UPDATE AccountCredentials SET auth_version=OLD.auth_version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id=NEW.user_id;
    UPDATE Sessions SET revoked_at_ms=coalesce(revoked_at_ms,max(issued_at_ms,CAST(unixepoch('subsec')*1000 AS INTEGER)))
        WHERE user_id=NEW.user_id;
END;

CREATE TABLE AuthChallenges (
    challenge_hash TEXT NOT NULL PRIMARY KEY CHECK(length(challenge_hash)=64 AND challenge_hash NOT GLOB '*[^0-9a-f]*'),
    csrf_hash TEXT NOT NULL CHECK(length(csrf_hash)=64 AND csrf_hash NOT GLOB '*[^0-9a-f]*'),
    issued_at_ms INTEGER NOT NULL CHECK(typeof(issued_at_ms)='integer' AND issued_at_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms > issued_at_ms)
);
CREATE INDEX idx_auth_challenges_expiry ON AuthChallenges(expires_at_ms);
CREATE TABLE AuthRateLimits (
    bucket_hash TEXT NOT NULL PRIMARY KEY CHECK(length(bucket_hash)=64 AND bucket_hash NOT GLOB '*[^0-9a-f]*'),
    window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms)='integer' AND window_start_ms >= 0),
    expires_at_ms INTEGER NOT NULL CHECK(typeof(expires_at_ms)='integer' AND expires_at_ms > window_start_ms),
    attempts INTEGER NOT NULL CHECK(typeof(attempts)='integer' AND attempts > 0)
);
CREATE INDEX idx_auth_rate_expiry ON AuthRateLimits(expires_at_ms);
