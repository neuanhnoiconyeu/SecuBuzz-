const {createRepositories}=require('../database/repositories');
const {createKeyRepository}=require('./repository');
function createSqliteKeyDirectory(db){
    const keys=createKeyRepository(db),repositories=createRepositories(db);
    function read(conversationId,keyId){
        if(!db.inTransaction)throw new TypeError('Key snapshot requires a transaction');
        const row=repositories.conversations.get(conversationId);
        if(!row||row.kind!=='direct'||row.origin!=='authenticated'||row.archived_at!==null)return null;
        // Reuse the exact DB-4A account/member/block visibility policy for both participants.
        if(!repositories.conversations.getDirectForUser(row.dm_user_low,conversationId)||!repositories.conversations.getDirectForUser(row.dm_user_high,conversationId))return null;
        const participantIds=[row.dm_user_low,row.dm_user_high];
        return {conversationId,participantIds,activeDevices:keys.active(participantIds),currentEpoch:keys.current(conversationId),epoch:keys.epoch(conversationId,keyId)};
    }
    return Object.freeze({read,loadConversationKeyState:({conversationId,keyId})=>db.transaction(()=>read(conversationId,keyId)).deferred()});
}
module.exports={createSqliteKeyDirectory};
