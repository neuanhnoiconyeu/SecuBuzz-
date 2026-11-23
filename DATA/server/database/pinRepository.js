/** Pin metadata DAL. Never updates Messages, message ciphertext or keys. */
function createPinRepository(db) {
    return {
        version: id => db.prepare('SELECT version FROM ConversationPinVersions WHERE conversation_id=?').get(id)?.version ?? 0,
        ensure: id => db.prepare('INSERT OR IGNORE INTO ConversationPinVersions(conversation_id,version) VALUES(?,0)').run(id),
        advance: id => db.prepare('UPDATE ConversationPinVersions SET version=version+1 WHERE conversation_id=?').run(id),
        list: id => db.prepare(`SELECT m.*,p.pinned_by,p.pinned_at FROM MessagePins p JOIN Messages m
            ON m.conversation_id=p.conversation_id AND m.message_id=p.message_id
            WHERE p.conversation_id=? AND m.deleted_at IS NULL ORDER BY p.pinned_at,p.message_id`).all(id),
        has: (cid,id) => Boolean(db.prepare('SELECT 1 FROM MessagePins WHERE conversation_id=? AND message_id=?').get(cid,id)),
        add: (cid,id,actor,at) => db.prepare('INSERT INTO MessagePins(conversation_id,message_id,pinned_by,pinned_at) VALUES(?,?,?,?)').run(cid,id,actor,at),
        remove: (cid,id) => db.prepare('DELETE FROM MessagePins WHERE conversation_id=? AND message_id=?').run(cid,id),
        operation: (actor,id) => db.prepare('SELECT * FROM MessagePinOperations WHERE actor_user_id=? AND operation_id=?').get(actor,id),
        record: row => db.prepare(`INSERT INTO MessagePinOperations(actor_user_id,operation_id,conversation_id,message_id,pinned,expected_version,result_version,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(row.actor,row.operationId,row.cid,row.id,Number(row.pinned),row.expectedVersion,row.version,row.at),
    };
}
module.exports={createPinRepository};
