-- Keep historical conversations and ciphertext unchanged. Only an explicit,
-- authenticated friendship-approved operation can activate a legacy DM.
ALTER TABLE Conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'
    CHECK(origin IN ('legacy','authenticated'));
CREATE INDEX idx_conversations_authenticated_direct_updated
    ON Conversations(updated_at DESC,conversation_id DESC)
    WHERE kind='direct' AND origin='authenticated' AND archived_at IS NULL;
