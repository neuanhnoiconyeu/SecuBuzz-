const device=row=>row?{deviceKeyId:row.device_key_id,userId:row.user_id,deviceId:row.device_id,keyVersion:row.key_version,
    createdAt:row.created_at,agreementPublicKey:row.agreement_public_key,signingPublicKey:row.signing_public_key,
    signature:row.signature,status:row.status,registeredAt:row.registered_at}:null;
function createKeyRepository(db){
    const get=(sql,...args)=>db.prepare(sql).get(...args),all=(sql,...args)=>db.prepare(sql).all(...args);
    const repository={
        device:id=>device(get('SELECT * FROM DeviceKeys WHERE device_key_id=?',id)),
        history:id=>all('SELECT * FROM DeviceKeys WHERE device_id=? ORDER BY key_version',id).map(device),
        list:user=>all('SELECT * FROM DeviceKeys WHERE user_id=? ORDER BY registered_at DESC,device_key_id DESC LIMIT 50',user).map(device),
        active:users=>all(`SELECT * FROM DeviceKeys WHERE status='active' AND user_id IN (${users.map(()=>'?').join(',')}) ORDER BY user_id,device_key_id`,...users).map(device),
        insertDevice(record,at){db.prepare(`INSERT INTO DeviceKeys(device_key_id,user_id,device_id,key_version,created_at,agreement_public_key,signing_public_key,signature,registered_at)
            VALUES(@deviceKeyId,@userId,@deviceId,@keyVersion,@createdAt,@agreementPublicKey,@signingPublicKey,@signature,@at)`).run({...record,at});return repository.device(record.deviceKeyId);},
        status(ids,status,at){for(const id of ids)db.prepare('UPDATE DeviceKeys SET status=?,status_changed_at=? WHERE device_key_id=?').run(status,at,id);},
        current:id=>{const row=get('SELECT key_id,epoch FROM ConversationKeyEpochs WHERE conversation_id=? ORDER BY epoch DESC LIMIT 1',id);return row?{keyId:row.key_id,epoch:row.epoch}:null;},
        epoch(id,key){const row=get('SELECT * FROM ConversationKeyEpochs WHERE conversation_id=? AND key_id=?',id,key);if(!row)return null;
            return {conversationId:id,keyId:row.key_id,epoch:row.epoch,previousKeyId:row.previous_key_id,creatorUserId:row.creator_user_id,
                creatorDeviceKeyId:row.creator_device_key_id,createdAt:row.created_at,
                wraps:all('SELECT * FROM ConversationKeyWraps WHERE conversation_id=? AND key_id=? ORDER BY position',id,key).map(w=>({recipientUserId:w.recipient_user_id,recipientDeviceKeyId:w.recipient_device_key_id,enc:w.enc,ciphertext:w.ciphertext})),
                signature:row.signature,publishedAt:row.published_at};},
        epochs:(id,before)=>all('SELECT key_id FROM ConversationKeyEpochs WHERE conversation_id=? AND epoch<? ORDER BY epoch DESC LIMIT 21',id,before).map(r=>repository.epoch(id,r.key_id)),
        insertEpoch(e,at){db.prepare(`INSERT INTO ConversationKeyEpochs(conversation_id,key_id,epoch,previous_key_id,creator_user_id,creator_device_key_id,created_at,signature,recipient_set_digest,published_at)
            VALUES(@conversationId,@keyId,@epoch,@previousKeyId,@creatorUserId,@creatorDeviceKeyId,@createdAt,@signature,@recipientSetDigest,@at)`).run({...e,at});
            const insert=db.prepare('INSERT INTO ConversationKeyWraps(conversation_id,key_id,position,recipient_user_id,recipient_device_key_id,enc,ciphertext) VALUES(?,?,?,?,?,?,?)');
            e.wraps.forEach((w,i)=>insert.run(e.conversationId,e.keyId,i,w.recipientUserId,w.recipientDeviceKeyId,w.enc,w.ciphertext));return repository.epoch(e.conversationId,e.keyId);}
    };return repository;
}
module.exports={createKeyRepository};
