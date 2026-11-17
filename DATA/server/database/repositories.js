const { randomUUID } = require('node:crypto');

class RepositoryError extends Error {
    constructor(code) {
        super(`Database operation failed: ${code}`);
        this.name = 'RepositoryError';
        this.code = code;
    }
}

function translate(error) {
    if (error instanceof RepositoryError) return error;
    const code = error.code || '';
    if (code === 'SQLITE_CONSTRAINT_TRIGGER' && error.message === 'username_unavailable') return new RepositoryError('DUPLICATE');
    if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return new RepositoryError('DUPLICATE');
    if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return new RepositoryError('REFERENCE');
    if (code.startsWith('SQLITE_CONSTRAINT')) return new RepositoryError('INVALID');
    if (code.startsWith('SQLITE_BUSY') || code === 'SQLITE_LOCKED') return new RepositoryError('BUSY');
    return new RepositoryError('DATABASE');
}

function fields(input, allowed) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !allowed.includes(key))) throw new RepositoryError('INVALID');
}

// One bounded joined projection, shared by member lookup and the paginated list.
// Private profile/account fields never enter the conversation DTO.
const directJoins = `JOIN ConversationMembers ml ON ml.conversation_id=c.conversation_id AND ml.user_id=c.dm_user_low AND ml.left_at IS NULL
    JOIN ConversationMembers mh ON mh.conversation_id=c.conversation_id AND mh.user_id=c.dm_user_high AND mh.left_at IS NULL
    JOIN AccountCredentials al ON al.user_id=c.dm_user_low AND al.status='active'
    JOIN AccountCredentials ah ON ah.user_id=c.dm_user_high AND ah.status='active'
    JOIN Users ul ON ul.user_id=c.dm_user_low JOIN UserProfiles pl ON pl.user_id=ul.user_id
    JOIN Users uh ON uh.user_id=c.dm_user_high JOIN UserProfiles ph ON ph.user_id=uh.user_id`;
const directColumns = `c.*,ul.username AS low_username,pl.display_name AS low_display_name,pl.avatar AS low_avatar,
    uh.username AS high_username,ph.display_name AS high_display_name,ph.avatar AS high_avatar,
    EXISTS(SELECT 1 FROM Friendships f WHERE f.user_low=c.dm_user_low AND f.user_high=c.dm_user_high AND f.origin='authenticated') AS interaction_allowed`;
const directVisible = `c.kind='direct' AND c.origin='authenticated' AND c.archived_at IS NULL
    AND @actor IN (c.dm_user_low,c.dm_user_high)
    AND NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=c.dm_user_low AND b.blocked_id=c.dm_user_high)
        OR (b.blocker_id=c.dm_user_high AND b.blocked_id=c.dm_user_low))`;

// An injected, already migrated connection is owned by the caller. No repository logs values.
// These are trusted internal persistence operations, not an authorization boundary.
function createRepositories(db) {
    const get = (sql, ...args) => db.prepare(sql).get(...args) || null;
    const all = (sql, ...args) => db.prepare(sql).all(...args);
    const run = (sql, ...args) => ({ changes: db.prepare(sql).run(...args).changes });
    const atomic = work => db.transaction(work).immediate();
    const pair = (a, b) => {
        if (typeof a !== 'string' || typeof b !== 'string') throw new RepositoryError('INVALID');
        return Buffer.compare(Buffer.from(a),Buffer.from(b)) < 0 ? [a,b] : [b,a];
    };
    const now = () => new Date().toISOString();
    const repositories = {
        users: {
            create(input) {
                fields(input, ['user_id','username','display_name']);
                const id = input.user_id ?? randomUUID();
                run('INSERT INTO Users(user_id,username,display_name) VALUES(?,?,?)', id,input.username,input.display_name);
                return repositories.users.get(id);
            },
            get: id => get('SELECT * FROM Users WHERE user_id=?', id),
            list: () => all('SELECT * FROM Users ORDER BY username'),
            setStatus: (id, status) => run('UPDATE Users SET status=?,last_seen=CURRENT_TIMESTAMP WHERE user_id=?', status,id)
        },
        profiles: {
            get: id => get('SELECT * FROM UserProfiles WHERE user_id=?', id),
            update(id, input) {
                fields(input, ['display_name','avatar','custom_status','presence_preference']);
                run(`UPDATE UserProfiles SET display_name=coalesce(?,display_name),avatar=coalesce(?,avatar),
                    custom_status=coalesce(?,custom_status),presence_preference=coalesce(?,presence_preference),updated_at=? WHERE user_id=?`,
                input.display_name ?? null,input.avatar ?? null,input.custom_status ?? null,input.presence_preference ?? null,now(),id);
                return repositories.profiles.get(id);
            }
        },
        sessions: {
            insert(input) {
                fields(input, ['session_id','user_id','token_hash','csrf_token_hash','issued_at_ms','expires_at_ms','auth_version']);
                run(`INSERT INTO Sessions(session_id,user_id,token_hash,csrf_token_hash,issued_at_ms,expires_at_ms,auth_version) VALUES(?,?,?,?,?,?,?)`,
                    input.session_id,input.user_id,input.token_hash,input.csrf_token_hash ?? null,input.issued_at_ms,input.expires_at_ms,input.auth_version ?? 0);
                return repositories.sessions.get(input.session_id);
            },
            get: id => get('SELECT * FROM Sessions WHERE session_id=?', id),
            findByHash: hash => get('SELECT * FROM Sessions WHERE token_hash=?', hash),
            revoke: (id, atMs) => run('UPDATE Sessions SET revoked_at_ms=coalesce(revoked_at_ms,?) WHERE session_id=?', atMs,id),
            touch: (id, atMs) => run('UPDATE Sessions SET last_seen_at_ms=? WHERE session_id=?', atMs,id)
        },
        friendRequests: {
            insert(input) {
                fields(input, ['request_id','sender_id','recipient_id']);
                const id = input.request_id ?? randomUUID();
                run('INSERT INTO FriendRequests(request_id,sender_id,recipient_id) VALUES(?,?,?)',id,input.sender_id,input.recipient_id);
                return repositories.friendRequests.get(id);
            },
            get: id => get('SELECT * FROM FriendRequests WHERE request_id=?', id),
            listForUser: id => all('SELECT * FROM FriendRequests WHERE sender_id=? OR recipient_id=? ORDER BY created_at,request_id',id,id),
            setStatus(id, status, resolvedAt) {
                run('UPDATE FriendRequests SET status=?,resolved_at=? WHERE request_id=?',status,resolvedAt,id);
                return repositories.friendRequests.get(id);
            }
        },
        friendships: {
            insert(a, b) {
                const [low, high] = pair(a,b);
                run('INSERT INTO Friendships(user_low,user_high) VALUES(?,?)',low,high);
                return repositories.friendships.get(a,b);
            },
            get(a,b) { return get('SELECT * FROM Friendships WHERE user_low=? AND user_high=?',...pair(a,b)); },
            listForUser: id => all('SELECT * FROM Friendships WHERE user_low=? OR user_high=? ORDER BY user_low,user_high',id,id)
        },
        blocks: {
            insert(a,b) { run('INSERT INTO Blocks(blocker_id,blocked_id) VALUES(?,?)',a,b); return repositories.blocks.get(a,b); },
            get: (a,b) => get('SELECT * FROM Blocks WHERE blocker_id=? AND blocked_id=?',a,b),
            listForUser: id => all('SELECT * FROM Blocks WHERE blocker_id=? ORDER BY blocked_id',id),
            remove: (a,b) => run('DELETE FROM Blocks WHERE blocker_id=? AND blocked_id=?',a,b)
        },
        conversations: {
            create(input) {
                fields(input, ['conversation_id','kind','title','created_by','dm_user_low','dm_user_high','origin']);
                return atomic(() => {
                    const id = input.conversation_id ?? randomUUID();
                    const values = [id,input.kind,input.title ?? null,input.created_by ?? null,input.dm_user_low ?? null,input.dm_user_high ?? null];
                    // Legacy callers also run against earlier migration versions in upgrade tests.
                    if (Object.prototype.hasOwnProperty.call(input,'origin')) {
                        run(`INSERT INTO Conversations(conversation_id,kind,title,created_by,dm_user_low,dm_user_high,origin) VALUES(?,?,?,?,?,?,?)`,...values,input.origin);
                    } else {
                        run(`INSERT INTO Conversations(conversation_id,kind,title,created_by,dm_user_low,dm_user_high) VALUES(?,?,?,?,?,?)`,...values);
                    }
                    if (input.kind === 'direct') {
                        repositories.members.insert({conversation_id:id,user_id:input.dm_user_low});
                        repositories.members.insert({conversation_id:id,user_id:input.dm_user_high});
                    } else if (input.created_by) {
                        repositories.members.insert({conversation_id:id,user_id:input.created_by,role:'owner'});
                    }
                    return repositories.conversations.get(id);
                });
            },
            get: id => get('SELECT * FROM Conversations WHERE conversation_id=?',id),
            findDirect(a,b) { return get('SELECT * FROM Conversations WHERE dm_user_low=? AND dm_user_high=?',...pair(a,b)); },
            listForUser: id => all(`SELECT c.* FROM Conversations c JOIN ConversationMembers m USING(conversation_id)
                WHERE m.user_id=? AND m.left_at IS NULL ORDER BY c.updated_at,c.conversation_id`,id),
            archive: (id, at) => run('UPDATE Conversations SET archived_at=?,updated_at=? WHERE conversation_id=?',at,now(),id),
            createAuthenticatedDirect(actor,recipient) {
                const [low,high] = pair(actor,recipient);
                return repositories.conversations.create({kind:'direct',created_by:actor,dm_user_low:low,dm_user_high:high,origin:'authenticated'});
            },
            activateDirect: (id, at) => run("UPDATE Conversations SET origin='authenticated',updated_at=? WHERE conversation_id=? AND kind='direct' AND origin='legacy'",at,id),
            getDirectForUser: (actor, id) => get(`SELECT ${directColumns} FROM Conversations c ${directJoins}
                WHERE ${directVisible} AND c.conversation_id=@id`,{actor,id}),
            listDirectForUser: (actor, {limit,after=null}) => all(`SELECT ${directColumns} FROM Conversations c ${directJoins}
                WHERE ${directVisible} AND (@lastTime IS NULL OR (c.updated_at,c.conversation_id)<(@lastTime,@lastId))
                ORDER BY c.updated_at DESC,c.conversation_id DESC LIMIT @take`,
            {actor,take:limit+1,lastTime:after?.[0] ?? null,lastId:after?.[1] ?? null})
        },
        members: {
            insert(input) {
                fields(input, ['conversation_id','user_id','role']);
                run('INSERT INTO ConversationMembers(conversation_id,user_id,role) VALUES(?,?,?)',input.conversation_id,input.user_id,input.role ?? 'member');
                return repositories.members.get(input.conversation_id,input.user_id);
            },
            get: (conversation,id) => get('SELECT * FROM ConversationMembers WHERE conversation_id=? AND user_id=?',conversation,id),
            list: conversation => all('SELECT * FROM ConversationMembers WHERE conversation_id=? ORDER BY user_id',conversation),
            setRole: (conversation,id,role) => run('UPDATE ConversationMembers SET role=? WHERE conversation_id=? AND user_id=?',role,conversation,id),
            leave: (conversation,id,at) => run('UPDATE ConversationMembers SET left_at=? WHERE conversation_id=? AND user_id=?',at,conversation,id)
        },
        messages: {
            insert(input) {
                fields(input, ['message_id','conversation_id','sender_id','receiver_id','ciphertext','iv','algorithm',
                    'envelope_version','encoding','sender_name','client_timestamp','message_type','fingerprint','client_id']);
                run(`INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv,algorithm,
                    envelope_version,encoding,sender_name,client_timestamp,message_type,fingerprint,client_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                input.message_id ?? randomUUID(),input.conversation_id,input.sender_id,input.receiver_id ?? null,input.ciphertext,input.iv,
                input.algorithm ?? 'AES-256-GCM',input.envelope_version ?? null,input.encoding ?? null,input.sender_name ?? null,
                input.client_timestamp ?? null,input.message_type ?? null,input.fingerprint ?? null,input.client_id ?? null);
                // Preserve the generated ID when callers omit message_id.
                return get('SELECT * FROM Messages WHERE rowid=last_insert_rowid()');
            },
            get: id => get('SELECT * FROM Messages WHERE message_id=?',id),
            insertAuthenticated(input) {
                fields(input,['message_id','conversation_id','sender_id','receiver_id','ciphertext','iv','envelope_version','encoding',
                    'sender_name','client_timestamp','message_type','fingerprint','client_id','message_seq','created_at','key_id']);
                const withKey=input.key_id!==undefined;
                run(`INSERT INTO Messages(message_id,conversation_id,sender_id,receiver_id,ciphertext,iv,algorithm,envelope_version,encoding,
                    sender_name,client_timestamp,message_type,fingerprint,client_id,origin,message_seq,created_at,updated_at${withKey?',key_id':''})
                    VALUES(?,?,?,?,?,?,'AES-256-GCM',?,?,?,?,?,?,?,'authenticated',?,?,?${withKey?',?':''})`,
                input.message_id,input.conversation_id,input.sender_id,input.receiver_id,input.ciphertext,input.iv,input.envelope_version,input.encoding,
                input.sender_name,input.client_timestamp,input.message_type,input.fingerprint,input.client_id,input.message_seq,input.created_at,input.created_at,...(withKey?[input.key_id]:[]));
                return repositories.messages.get(input.message_id);
            },
            findAuthenticatedClient: (conversation,id) => get("SELECT * FROM Messages WHERE conversation_id=? AND client_id=? AND origin='authenticated'",conversation,id),
            getAuthenticated: id => get("SELECT * FROM Messages WHERE message_id=? AND origin='authenticated'",id),
            highWater: conversation => get("SELECT coalesce(max(message_seq),0) AS n FROM Messages WHERE conversation_id=? AND origin='authenticated'",conversation).n,
            history: (conversation,{limit,highWater,before}) => all(`SELECT * FROM Messages WHERE conversation_id=@conversation AND origin='authenticated'
                AND message_seq<=@highWater AND (@before IS NULL OR message_seq<@before)
                ORDER BY message_seq DESC LIMIT @take`,{conversation,highWater,before,take:limit+1}),
            tombstone: (id,at) => run("UPDATE Messages SET deleted_at=?,updated_at=?,revision=revision+1 WHERE message_id=? AND origin='authenticated' AND deleted_at IS NULL",at,at,id),
            list: (conversation,limit = 50,offset = 0) => all(`SELECT * FROM Messages WHERE conversation_id=?
                ORDER BY created_at DESC,message_id DESC LIMIT ? OFFSET ?`,conversation,limit,offset).reverse(),
            setLegacyStatus(id,status) {
                if (!['delivered','read'].includes(status)) throw new RepositoryError('INVALID');
                const column = { delivered:'delivered_at',read:'read_at' }[status];
                return atomic(() => {
                    const result = run(`UPDATE Messages SET ${column}=coalesce(${column},?),updated_at=? WHERE message_id=?`,now(),now(),id);
                    const message = repositories.messages.get(id);
                    if (message?.receiver_id) repositories.receipts.insert({conversation_id:message.conversation_id,
                        message_id:id,user_id:message.receiver_id,status,observed_at:message[column]});
                    return result;
                });
            }
        },
        receipts: {
            insert(input) {
                fields(input, ['conversation_id','message_id','user_id','status','observed_at']);
                run(`INSERT INTO MessageReceipts(conversation_id,message_id,user_id,status,observed_at) VALUES(?,?,?,?,?)
                    ON CONFLICT(conversation_id,message_id,user_id,status) DO NOTHING`,
                input.conversation_id,input.message_id,input.user_id,input.status,input.observed_at);
                return get('SELECT * FROM MessageReceipts WHERE conversation_id=? AND message_id=? AND user_id=? AND status=?',
                    input.conversation_id,input.message_id,input.user_id,input.status);
            },
            list: (conversation,id) => all('SELECT * FROM MessageReceipts WHERE conversation_id=? AND message_id=? ORDER BY user_id,status',conversation,id),
            get: (conversation,message,user,status) => get('SELECT * FROM MessageReceipts WHERE conversation_id=? AND message_id=? AND user_id=? AND status=?',conversation,message,user,status)
        },
        attachments: {
            insert(input) {
                fields(input, ['attachment_id','conversation_id','message_id','uploaded_by','storage_key','encrypted_metadata','media_type','byte_size']);
                const id = input.attachment_id ?? randomUUID();
                run(`INSERT INTO Attachments(attachment_id,conversation_id,message_id,uploaded_by,storage_key,encrypted_metadata,media_type,byte_size)
                    VALUES(?,?,?,?,?,?,?,?)`,id,input.conversation_id,input.message_id ?? null,input.uploaded_by,input.storage_key,
                input.encrypted_metadata ?? null,input.media_type ?? 'application/octet-stream',input.byte_size);
                return repositories.attachments.get(id);
            },
            get: id => get('SELECT * FROM Attachments WHERE attachment_id=?',id),
            setStatus: (id,status) => run('UPDATE Attachments SET status=?,updated_at=? WHERE attachment_id=?',status,now(),id)
        },
        audit: {
            insert(input) {
                fields(input, ['audit_id','actor_user_id','event_type','severity','source','subject_id','metadata']);
                const metadata = input.metadata ?? {};
                // Only explicit scalar metadata, never prompts, message bodies, credentials or keys.
                const allowed = ['reason_code','operation','outcome','count','duration_ms'];
                fields(metadata,allowed);
                if (Object.entries(metadata).some(([key,value]) =>
                    ['count','duration_ms'].includes(key) ? !Number.isFinite(value) || value < 0 :
                        typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,64}$/.test(value))) throw new RepositoryError('INVALID');
                const id = input.audit_id ?? randomUUID();
                run(`INSERT INTO AuditLogs(audit_id,actor_user_id,event_type,severity,source,subject_id,metadata_json) VALUES(?,?,?,?,?,?,?)`,
                id,input.actor_user_id ?? null,input.event_type,input.severity ?? 'info',input.source,input.subject_id ?? null,JSON.stringify(metadata));
                return repositories.audit.get(id);
            },
            get: id => get('SELECT * FROM AuditLogs WHERE audit_id=?',id),
            listForActor: (id,limit = 50) => all('SELECT * FROM AuditLogs WHERE actor_user_id=? ORDER BY created_at DESC,audit_id DESC LIMIT ?',id,limit)
        },
        legacy: {
            addContact(userId,friendId) {
                return atomic(() => {
                    const id = randomUUID();
                    run('INSERT INTO Contacts(contact_id,user_id,friend_id) VALUES(?,?,?)',id,userId,friendId);
                    repositories.friendRequests.insert({request_id:id,sender_id:userId,recipient_id:friendId});
                    return get('SELECT * FROM Contacts WHERE contact_id=?',id);
                });
            },
            getContacts: id => all(`SELECT c.contact_id,c.status AS contact_status,u.user_id,u.username,u.display_name,u.status AS online_status
                FROM Contacts c JOIN Users u ON c.friend_id=u.user_id WHERE c.user_id=? ORDER BY u.username`,id),
            saveMessage(sender,receiver,ciphertext,iv) {
                return atomic(() => {
                    let conversation = repositories.conversations.findDirect(sender,receiver);
                    if (!conversation) {
                        const [low,high] = pair(sender,receiver);
                        conversation = repositories.conversations.create({kind:'direct',dm_user_low:low,dm_user_high:high});
                    }
                    return repositories.messages.insert({conversation_id:conversation.conversation_id,sender_id:sender,receiver_id:receiver,ciphertext,iv});
                });
            },
            getConversation: (a,b,limit = 50,offset = 0) => all(`SELECT * FROM Messages WHERE (sender_id=? AND receiver_id=?)
                OR (sender_id=? AND receiver_id=?) ORDER BY created_at DESC,message_id DESC LIMIT ? OFFSET ?`,a,b,b,a,limit,offset).reverse(),
            createSecurityLog(userId,eventType,severity,source,description,details = {}) {
                const id = randomUUID();
                run(`INSERT INTO SecurityLogs(log_id,user_id,event_type,severity,source,description,details_json) VALUES(?,?,?,?,?,?,?)`,
                    id,userId,eventType,severity,source,description,JSON.stringify(details));
                return get('SELECT * FROM SecurityLogs WHERE log_id=?',id);
            },
            getSecurityLogs: (limit = 50,offset = 0) => all('SELECT * FROM SecurityLogs ORDER BY created_at DESC LIMIT ? OFFSET ?',limit,offset),
            getCriticalLogs: () => all("SELECT * FROM SecurityLogs WHERE severity='CRITICAL' ORDER BY created_at DESC")
        }
    };
    // Normalize errors once, without logging database content or SQLite diagnostic strings.
    for (const repository of Object.values(repositories)) {
        for (const [name,operation] of Object.entries(repository)) {
            repository[name] = (...args) => { try { return operation(...args); } catch (error) { throw translate(error); } };
        }
    }
    repositories.transaction = work => {
        if (typeof work !== 'function' || work.constructor?.name === 'AsyncFunction') throw new RepositoryError('INVALID');
        try { return atomic(() => {
            const result = work(repositories);
            if (result && typeof result.then === 'function') throw new RepositoryError('INVALID');
            return result;
        }); } catch (error) { throw translate(error); }
    };
    return repositories;
}
module.exports = { createRepositories, RepositoryError };
