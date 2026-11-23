function createReactionRepository(db) {
    return {
        version: (cid,id)=>db.prepare('SELECT version FROM MessageReactionVersions WHERE conversation_id=? AND message_id=?').get(cid,id)?.version??0,
        actors: (cid,id)=>db.prepare('SELECT user_id,emoji,revision,updated_at FROM MessageReactionActors WHERE conversation_id=? AND message_id=? ORDER BY user_id').all(cid,id),
        actor: (cid,id,user)=>db.prepare('SELECT * FROM MessageReactionActors WHERE conversation_id=? AND message_id=? AND user_id=?').get(cid,id,user),
        ensure: (cid,id)=>db.prepare('INSERT OR IGNORE INTO MessageReactionVersions VALUES(?,?,0)').run(cid,id),
        advance: (cid,id)=>db.prepare('UPDATE MessageReactionVersions SET version=version+1 WHERE conversation_id=? AND message_id=?').run(cid,id),
        set: (cid,id,user,emoji,revision,at)=>db.prepare(`INSERT INTO MessageReactionActors VALUES(?,?,?,?,?,?)
            ON CONFLICT(conversation_id,message_id,user_id) DO UPDATE SET emoji=excluded.emoji,revision=excluded.revision,updated_at=excluded.updated_at`).run(cid,id,user,emoji,revision,at),
        operation: (user,id)=>db.prepare('SELECT * FROM MessageReactionOperations WHERE actor_user_id=? AND operation_id=?').get(user,id),
        record: row=>db.prepare('INSERT INTO MessageReactionOperations VALUES(?,?,?,?,?,?,?,?,?)').run(row.user,row.operationId,row.cid,row.id,row.emoji,row.expectedRevision,row.revision,row.version,row.at),
    };
}
module.exports={createReactionRepository};
