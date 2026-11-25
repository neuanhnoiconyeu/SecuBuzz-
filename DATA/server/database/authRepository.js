const { randomUUID }=require('node:crypto');
const { createRepositories,RepositoryError }=require('./repositories');

// Private account operations extend the existing injected DAL; never use these rows as API output.
function createAuthRepository(db) {
    const repositories=createRepositories(db);
    const get=(sql,...args)=>db.prepare(sql).get(...args) || null;
    const joinedBase=`SELECT s.*,a.status AS account_status,a.auth_version AS account_version,
        u.username,p.display_name,p.avatar FROM Sessions s JOIN AccountCredentials a ON a.user_id=s.user_id
        JOIN Users u ON u.user_id=s.user_id JOIN UserProfiles p ON p.user_id=u.user_id`;
    const joinedWithAvatar=`SELECT s.*,a.status AS account_status,a.auth_version AS account_version,
        u.username,p.display_name,p.avatar,av.sha256 AS avatar_sha256 FROM Sessions s JOIN AccountCredentials a ON a.user_id=s.user_id
        JOIN Users u ON u.user_id=s.user_id JOIN UserProfiles p ON p.user_id=u.user_id
        LEFT JOIN UserProfileAvatars av ON av.user_id=u.user_id`;
    const joined=()=>get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='UserProfileAvatars'") ? joinedWithAvatar : joinedBase;
    const repository={
        repositories,
        findCredential:identifier=>get('SELECT * FROM AccountCredentials WHERE username_key=? OR email_key=?',identifier,identifier),
        credentialById:id=>get('SELECT * FROM AccountCredentials WHERE user_id=?',id),
        byHash:hash=>get(joined()+' WHERE s.token_hash=?',hash),
        byId:id=>get(joined()+' WHERE s.session_id=?',id),
        challenge:hash=>get('SELECT * FROM AuthChallenges WHERE challenge_hash=?',hash),
        addChallenge(hash,csrfHash,now,expiry,max) {
            return repositories.transaction(()=>{
                db.prepare('DELETE FROM AuthChallenges WHERE expires_at_ms<=?').run(now);
                if (get('SELECT count(*) AS n FROM AuthChallenges').n>=max) throw new RepositoryError('CAPACITY');
                db.prepare('INSERT INTO AuthChallenges(challenge_hash,csrf_hash,issued_at_ms,expires_at_ms) VALUES(?,?,?,?)').run(hash,csrfHash,now,expiry);
            });
        },
        verifyProof(proof,now) {
            if (proof.type==='preauth') {
                const result=db.prepare('DELETE FROM AuthChallenges WHERE challenge_hash=? AND csrf_hash=? AND expires_at_ms>?')
                    .run(proof.hash,proof.csrfHash,now);
                if (result.changes!==1) throw new RepositoryError('CSRF');
            } else {
                const row=repository.byId(proof.sessionId);
                if (!row || row.user_id!==proof.userId || row.revoked_at_ms!==null || row.expires_at_ms<=now ||
                    row.account_status!=='active' || row.auth_version!==row.account_version || row.csrf_token_hash!==proof.csrfHash) {
                    throw new RepositoryError('CSRF');
                }
            }
        },
        register(input,proof,now) {
            return repositories.transaction(()=>{
                repository.verifyProof(proof,now);
                if (get('SELECT 1 FROM Users WHERE lower(username)=?',input.username)) throw new RepositoryError('DUPLICATE');
                const user=repositories.users.create({username:input.username,display_name:input.displayName});
                db.prepare('INSERT INTO AccountCredentials(user_id,username_key,email_key,password_hash) VALUES(?,?,?,?)')
                    .run(user.user_id,input.username,input.email,input.passwordHash);
                repositories.audit.insert({actor_user_id:user.user_id,event_type:'auth.registered',source:'auth',metadata:{outcome:'created'}});
                return user.user_id;
            });
        },
        issueSession(input,proof,now,config) {
            return repositories.transaction(()=>{
                repository.verifyProof(proof,now);
                let account=repository.credentialById(input.userId);
                if (!account || account.status!=='active' || account.password_hash!==input.verifiedHash) throw new RepositoryError('CREDENTIALS');
                if (input.upgradedHash) {
                    db.prepare('UPDATE AccountCredentials SET password_hash=? WHERE user_id=?').run(input.upgradedHash,input.userId);
                    account=repository.credentialById(input.userId);
                }
                // A new bearer is always generated. Never promote a pre-session or reuse a supplied cookie.
                if (proof.type==='session') repositories.sessions.revoke(proof.sessionId,now);
                const session=repositories.sessions.insert({session_id:randomUUID(),user_id:input.userId,token_hash:input.tokenHash,
                    csrf_token_hash:input.csrfHash,issued_at_ms:now,expires_at_ms:now+config.sessionTtlMs,auth_version:account.auth_version});
                const excess=db.prepare(`SELECT session_id FROM Sessions WHERE user_id=? AND session_id<>? AND revoked_at_ms IS NULL
                    AND expires_at_ms>? ORDER BY issued_at_ms DESC,session_id DESC LIMIT -1 OFFSET ?`)
                    .all(input.userId,session.session_id,now,config.maxSessions-1);
                for (const row of excess) repositories.sessions.revoke(row.session_id,now);
                repositories.audit.insert({actor_user_id:input.userId,event_type:'auth.login',source:'auth',metadata:{outcome:'authenticated'}});
                return repository.byId(session.session_id);
            });
        },
        logout(proof,now) {
            return repositories.transaction(()=>{
                repository.verifyProof(proof,now);
                if (proof.type==='session') {
                    repositories.sessions.revoke(proof.sessionId,now);
                    repositories.audit.insert({actor_user_id:proof.userId,event_type:'auth.logout',source:'auth',metadata:{outcome:'revoked'}});
                }
            });
        },
        disableAccount(id) { return db.prepare("UPDATE AccountCredentials SET status='disabled' WHERE user_id=?").run(id).changes; },
        cleanup(now,retentionMs=604800000) {
            return repositories.transaction(()=>({
                sessions:db.prepare('DELETE FROM Sessions WHERE expires_at_ms<=? OR revoked_at_ms<=?').run(now-retentionMs,now-retentionMs).changes,
                challenges:db.prepare('DELETE FROM AuthChallenges WHERE expires_at_ms<=?').run(now).changes,
                rateBuckets:db.prepare('DELETE FROM AuthRateLimits WHERE expires_at_ms<=?').run(now).changes
            }));
        }
    };
    return repository;
}
module.exports={ createAuthRepository };
