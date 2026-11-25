-- DB-5B group schema: new tables keyed by conversation_id; no existing table, row or value is changed.
-- Group messages stay in Messages (conversation_id is the group). Every new foreign key is ON DELETE RESTRICT.

-- Group_Extension_Record: data that Conversations does not hold. history_policy is set at insert and immutable afterwards (OD-05).
CREATE TABLE GroupExtensions (
    conversation_id TEXT NOT NULL PRIMARY KEY REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    description TEXT CHECK(description IS NULL OR length(description) <= 1000),
    history_policy TEXT NOT NULL DEFAULT 'from_joined' CHECK(history_policy IN ('all','from_joined')),
    membership_revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(membership_revision) = 'integer' AND membership_revision >= 1),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TRIGGER group_extensions_group_only BEFORE INSERT ON GroupExtensions BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'group')
        THEN RAISE(ABORT,'invalid_group_extension') END;
END;
CREATE TRIGGER group_extensions_update BEFORE UPDATE OF conversation_id, history_policy, membership_revision, created_at ON GroupExtensions BEGIN
    SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.created_at IS NOT OLD.created_at OR NEW.history_policy IS NOT OLD.history_policy
        OR (NEW.membership_revision IS NOT OLD.membership_revision AND NEW.membership_revision <> OLD.membership_revision + 1)
        THEN RAISE(ABORT,'group_extension_immutable') END;
END;
CREATE TRIGGER group_extensions_keep BEFORE DELETE ON GroupExtensions BEGIN SELECT RAISE(ABORT,'group_extension_retained'); END;

-- Membership_Interval: one continuous period of active membership, bounded by message sequence numbers (both inclusive).
CREATE TABLE GroupMembershipIntervals (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    interval_no INTEGER NOT NULL CHECK(typeof(interval_no) = 'integer' AND interval_no >= 1),
    first_seq INTEGER NOT NULL CHECK(typeof(first_seq) = 'integer' AND first_seq BETWEEN 1 AND 9007199254740991),
    last_seq INTEGER CHECK(last_seq IS NULL OR (typeof(last_seq) = 'integer' AND last_seq >= first_seq - 1)),
    joined_at TEXT NOT NULL,
    left_at TEXT,
    PRIMARY KEY(conversation_id, user_id, interval_no),
    CHECK((last_seq IS NULL) = (left_at IS NULL)),
    FOREIGN KEY(conversation_id, user_id) REFERENCES ConversationMembers(conversation_id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_group_intervals_open ON GroupMembershipIntervals(conversation_id, user_id) WHERE left_at IS NULL;
CREATE INDEX idx_group_intervals_open_joined ON GroupMembershipIntervals(conversation_id, joined_at, user_id) WHERE left_at IS NULL;
CREATE TRIGGER group_intervals_insert BEFORE INSERT ON GroupMembershipIntervals BEGIN
    SELECT CASE WHEN NEW.interval_no <> coalesce((SELECT max(interval_no) FROM GroupMembershipIntervals
            WHERE conversation_id = NEW.conversation_id AND user_id = NEW.user_id), 0) + 1
        OR EXISTS(SELECT 1 FROM GroupMembershipIntervals WHERE conversation_id = NEW.conversation_id
            AND user_id = NEW.user_id AND last_seq IS NULL)
        OR NEW.first_seq <= coalesce((SELECT max(last_seq) FROM GroupMembershipIntervals
            WHERE conversation_id = NEW.conversation_id AND user_id = NEW.user_id), 0)
        OR NOT EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'group')
        THEN RAISE(ABORT,'invalid_group_interval') END;
END;
CREATE TRIGGER group_intervals_close BEFORE UPDATE ON GroupMembershipIntervals BEGIN
    SELECT CASE WHEN OLD.left_at IS NOT NULL OR NEW.left_at IS NULL OR NEW.last_seq IS NULL
        OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.user_id IS NOT OLD.user_id
        OR NEW.interval_no IS NOT OLD.interval_no OR NEW.first_seq IS NOT OLD.first_seq OR NEW.joined_at IS NOT OLD.joined_at
        THEN RAISE(ABORT,'group_interval_immutable') END;
END;
CREATE TRIGGER group_intervals_keep BEFORE DELETE ON GroupMembershipIntervals BEGIN SELECT RAISE(ABORT,'group_interval_retained'); END;

-- Invitation: states pending, accepted, declined, cancelled, expired; only pending may change.
CREATE TABLE ConversationInvitations (
    invitation_id TEXT NOT NULL PRIMARY KEY CHECK(length(trim(invitation_id)) > 0),
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    invitee_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    inviter_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','accepted','declined','cancelled','expired')),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    resolved_at TEXT,
    CHECK(invitee_id <> inviter_id),
    CHECK(expires_at > created_at),
    CHECK((state = 'pending') = (resolved_at IS NULL)),
    FOREIGN KEY(conversation_id, inviter_id) REFERENCES ConversationMembers(conversation_id, user_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX uq_invitations_pending ON ConversationInvitations(conversation_id, invitee_id) WHERE state = 'pending';
CREATE INDEX idx_invitations_invitee ON ConversationInvitations(invitee_id, state, created_at DESC, invitation_id DESC);
CREATE INDEX idx_invitations_group ON ConversationInvitations(conversation_id, state, created_at DESC, invitation_id DESC);
CREATE INDEX idx_invitations_inviter ON ConversationInvitations(conversation_id, inviter_id);
CREATE TRIGGER invitations_insert BEFORE INSERT ON ConversationInvitations BEGIN
    SELECT CASE WHEN NEW.state <> 'pending' OR NOT EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'group')
        THEN RAISE(ABORT,'invalid_invitation') END;
END;
CREATE TRIGGER invitations_transition BEFORE UPDATE ON ConversationInvitations BEGIN
    SELECT CASE WHEN OLD.state <> 'pending' OR NEW.state = 'pending'
        OR NEW.invitation_id IS NOT OLD.invitation_id OR NEW.conversation_id IS NOT OLD.conversation_id
        OR NEW.invitee_id IS NOT OLD.invitee_id OR NEW.inviter_id IS NOT OLD.inviter_id
        OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
        THEN RAISE(ABORT,'invalid_invitation_transition') END;
END;
CREATE TRIGGER invitations_keep BEFORE DELETE ON ConversationInvitations BEGIN SELECT RAISE(ABORT,'invitation_retained'); END;

-- Read_Position: one row per group and member; the value never decreases.
CREATE TABLE GroupReadPositions (
    conversation_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0 CHECK(typeof(position) = 'integer' AND position BETWEEN 0 AND 9007199254740991),
    updated_at TEXT NOT NULL,
    PRIMARY KEY(conversation_id, user_id),
    FOREIGN KEY(conversation_id, user_id) REFERENCES ConversationMembers(conversation_id, user_id) ON DELETE RESTRICT
);
CREATE TRIGGER group_read_positions_monotonic BEFORE UPDATE OF position ON GroupReadPositions BEGIN
    SELECT CASE WHEN NEW.position < OLD.position THEN RAISE(ABORT,'read_position_monotonic') END;
END;
CREATE TRIGGER group_read_positions_insert BEFORE INSERT ON GroupReadPositions BEGIN
    SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = NEW.conversation_id AND kind = 'group')
        THEN RAISE(ABORT,'invalid_read_position') END;
END;

-- Idempotency keys for group creation (24 hour window enforced by the service).
CREATE TABLE GroupCreationKeys (
    user_id TEXT NOT NULL REFERENCES Users(user_id) ON DELETE RESTRICT,
    idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 256),
    fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64 AND fingerprint NOT GLOB '*[^0-9a-f]*'),
    conversation_id TEXT NOT NULL REFERENCES Conversations(conversation_id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, idempotency_key)
);
CREATE INDEX idx_group_creation_keys_conversation ON GroupCreationKeys(conversation_id);

-- Option A hardening. With foreign_keys ON (the canonical connection contract), an existing child
-- makes its Conversations parent non-replaceable via immediate ON DELETE RESTRICT, even with
-- recursive_triggers OFF. On a key collision the following INSERT OR IGNORE is a no-op for ordinary
-- INSERT/UPSERT. SQLite propagates an explicit outer OR REPLACE policy into trigger statements,
-- so REPLACE instead tries to replace the referenced parent and is aborted by RESTRICT. It never
-- changes that parent or child. This preserves genuine UPSERT, including max-position reports
-- below the stored position, without relying on implicit-delete triggers or an extra guard table.
-- See https://www.sqlite.org/lang_createtrigger.html (outer conflict-policy propagation).
-- Normal duplicate inserts remain UNIQUE/PRIMARYKEY (DUPLICATE); refused replacements report
-- SQLITE_CONSTRAINT_TRIGGER through immediate RESTRICT (CONFLICT in Group_Repository).
CREATE TRIGGER group_extensions_replacement_guard BEFORE INSERT ON GroupExtensions BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN GroupExtensions r ON r.conversation_id = c.conversation_id WHERE r.conversation_id = NEW.conversation_id OR r.rowid = NEW.rowid;
END;
CREATE TRIGGER invitations_replacement_guard BEFORE INSERT ON ConversationInvitations BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN ConversationInvitations r ON r.conversation_id = c.conversation_id WHERE r.invitation_id = NEW.invitation_id
            OR (r.conversation_id = NEW.conversation_id AND r.invitee_id = NEW.invitee_id AND r.state = 'pending' AND NEW.state = 'pending') OR r.rowid = NEW.rowid;
END;
CREATE TRIGGER group_read_positions_replacement_guard BEFORE INSERT ON GroupReadPositions BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN GroupReadPositions r ON r.conversation_id = c.conversation_id WHERE (r.conversation_id = NEW.conversation_id AND r.user_id = NEW.user_id) OR r.rowid = NEW.rowid;
END;
CREATE TRIGGER group_creation_keys_replacement_guard BEFORE INSERT ON GroupCreationKeys BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN GroupCreationKeys r ON r.conversation_id = c.conversation_id WHERE (r.user_id = NEW.user_id AND r.idempotency_key = NEW.idempotency_key) OR r.rowid = NEW.rowid;
END;
CREATE TRIGGER group_members_replacement_guard BEFORE INSERT ON ConversationMembers BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN ConversationMembers r ON r.conversation_id = c.conversation_id WHERE c.kind = 'group' AND ((r.conversation_id = NEW.conversation_id
            AND (r.user_id = NEW.user_id OR (r.role = 'owner' AND r.left_at IS NULL AND NEW.role = 'owner' AND NEW.left_at IS NULL))) OR r.rowid = NEW.rowid);
END;
CREATE TRIGGER group_owner_replacement_guard BEFORE UPDATE ON ConversationMembers BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN ConversationMembers r ON r.conversation_id = c.conversation_id WHERE c.kind = 'group' AND r.conversation_id = NEW.conversation_id
            AND r.user_id <> OLD.user_id AND r.role = 'owner' AND r.left_at IS NULL AND NEW.role = 'owner' AND NEW.left_at IS NULL;
END;
CREATE TRIGGER group_read_positions_identity BEFORE UPDATE ON GroupReadPositions BEGIN
    SELECT CASE WHEN NEW.conversation_id IS NOT OLD.conversation_id OR NEW.user_id IS NOT OLD.user_id
        THEN RAISE(ABORT,'read_position_identity_immutable') END;
END;
CREATE TRIGGER group_creation_keys_immutable BEFORE UPDATE ON GroupCreationKeys BEGIN
    SELECT CASE WHEN NEW.user_id IS NOT OLD.user_id OR NEW.idempotency_key IS NOT OLD.idempotency_key
        OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.created_at IS NOT OLD.created_at
        THEN RAISE(ABORT,'group_creation_key_immutable') END;
END;

-- An explicit rowid is another unique replacement target. Its value is defined in
-- BEFORE INSERT when explicitly supplied; an automatic rowid cannot collide. Any
-- extra probe caused by an unspecified NEW.rowid is harmless for INSERT/UPSERT.
CREATE TRIGGER group_intervals_replacement_guard BEFORE INSERT ON GroupMembershipIntervals BEGIN
    INSERT OR IGNORE INTO Conversations(conversation_id, kind, title, created_by, dm_user_low, dm_user_high, created_at, updated_at, archived_at, origin)
        SELECT c.conversation_id, c.kind, c.title, c.created_by, c.dm_user_low, c.dm_user_high, c.created_at, c.updated_at, c.archived_at, c.origin FROM Conversations c JOIN GroupMembershipIntervals r ON r.conversation_id = c.conversation_id
        WHERE r.rowid = NEW.rowid OR (r.conversation_id = NEW.conversation_id AND r.user_id = NEW.user_id
            AND (r.interval_no = NEW.interval_no OR (r.left_at IS NULL AND NEW.left_at IS NULL)));
END;
CREATE TRIGGER groupextensions_row_identity BEFORE UPDATE ON GroupExtensions
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;
CREATE TRIGGER groupmembershipintervals_row_identity BEFORE UPDATE ON GroupMembershipIntervals
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;
CREATE TRIGGER conversationinvitations_row_identity BEFORE UPDATE ON ConversationInvitations
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;
CREATE TRIGGER groupreadpositions_row_identity BEFORE UPDATE ON GroupReadPositions
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;
CREATE TRIGGER groupcreationkeys_row_identity BEFORE UPDATE ON GroupCreationKeys
WHEN NEW.rowid IS NOT OLD.rowid
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;
CREATE TRIGGER conversationmembers_row_identity BEFORE UPDATE ON ConversationMembers
WHEN NEW.rowid IS NOT OLD.rowid AND EXISTS(SELECT 1 FROM Conversations WHERE conversation_id = OLD.conversation_id AND kind = 'group')
BEGIN SELECT RAISE(ABORT,'group_row_identity_immutable'); END;

-- Backfill of existing rows (DB5-R14.13, COMP-03). Two INSERT ... SELECT statements that only insert; they run in the
-- runner's transaction together with the DDL above. They read group rows of Conversations and ConversationMembers,
-- and Messages only for the message_seq of authenticated messages of the same group. No other table is read or written.

-- One Group_Extension_Record per group conversation of any origin, with the narrower policy from_joined (DB5-R08).
-- The row is inserted once and never updated, so group_extensions_update is not involved.
INSERT INTO GroupExtensions(conversation_id, description, history_policy, membership_revision, created_at)
    SELECT conversation_id, NULL, 'from_joined', 1, created_at FROM Conversations WHERE kind = 'group';

-- One Membership_Interval (interval_no 1) per existing member of such a group (least access, DB5-R08.3):
--   first_seq: the lowest message_seq of an authenticated message created at or after joined_at, otherwise the highest
--              message_seq of the group plus 1 (1 for a group without authenticated messages);
--   last_seq:  NULL (open interval) for an active member; for a member with left_at, the highest message_seq created at
--              or before left_at, otherwise first_seq - 1 (an empty period).
-- Timestamps are compared after strftime brings both sides to one UTC format, so a mix of formats (for example
-- 'YYYY-MM-DD HH:MM:SS' and 'YYYY-MM-DDTHH:MM:SS.SSSZ') cannot widen an interval. A value that does not parse matches no
-- message, which can only narrow the interval.
INSERT INTO GroupMembershipIntervals(conversation_id, user_id, interval_no, first_seq, last_seq, joined_at, left_at)
    SELECT p.conversation_id, p.user_id, 1, p.first_seq,
        CASE WHEN p.left_at IS NULL THEN NULL
            ELSE coalesce((SELECT max(m.message_seq) FROM Messages m
                WHERE m.conversation_id = p.conversation_id AND m.origin = 'authenticated'
                AND strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at) <= strftime('%Y-%m-%dT%H:%M:%fZ', p.left_at)), p.first_seq - 1) END,
        p.joined_at, p.left_at
    FROM (SELECT cm.conversation_id, cm.user_id, cm.joined_at, cm.left_at,
            coalesce((SELECT min(m.message_seq) FROM Messages m
                WHERE m.conversation_id = cm.conversation_id AND m.origin = 'authenticated'
                AND strftime('%Y-%m-%dT%H:%M:%fZ', m.created_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', cm.joined_at)),
                (SELECT coalesce(max(m.message_seq), 0) + 1 FROM Messages m
                WHERE m.conversation_id = cm.conversation_id AND m.origin = 'authenticated')) AS first_seq
        FROM ConversationMembers cm JOIN Conversations c ON c.conversation_id = cm.conversation_id
        WHERE c.kind = 'group') p;
