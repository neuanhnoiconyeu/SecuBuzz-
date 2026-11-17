const { randomUUID }=require('node:crypto');
const { createRepositories }=require('./repositories');

// Public projections only; caller supplies the verified actor. No connection or auth duplication.
const publicColumns='u.user_id,u.username,p.display_name,p.avatar,a.username_key';
const publicJoins='JOIN Users u ON u.user_id=a.user_id JOIN UserProfiles p ON p.user_id=u.user_id';
const noBlock=`NOT EXISTS(SELECT 1 FROM Blocks b WHERE (b.blocker_id=@actor AND b.blocked_id=u.user_id)
    OR (b.blocker_id=u.user_id AND b.blocked_id=@actor))`;
const relationships=`LEFT JOIN Friendships f ON f.user_low=min(@actor,u.user_id) AND f.user_high=max(@actor,u.user_id) AND f.origin='authenticated'
    LEFT JOIN FriendRequests r ON min(r.sender_id,r.recipient_id)=min(@actor,u.user_id)
    AND max(r.sender_id,r.recipient_id)=max(@actor,u.user_id) AND r.status='pending' AND r.origin='authenticated'`;
const relationshipColumns=`CASE WHEN u.user_id=@actor THEN 'self' WHEN f.user_low IS NOT NULL THEN 'friend'
    WHEN r.recipient_id=@actor THEN 'incoming' WHEN r.sender_id=@actor THEN 'outgoing' ELSE 'none' END AS relationship,r.request_id`;
function createSocialRepository(db) {
    const repositories=createRepositories(db);
    const get=(sql,parameters)=>db.prepare(sql).get(parameters) || null;
    const all=(sql,parameters)=>db.prepare(sql).all(parameters);
    const pair=(a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))<0 ? [a,b] : [b,a];
    const cursorParameters=p=>({take:p.limit+1,lastName:p.after?.[0] ?? null,lastId:p.after?.[1] ?? null});
    return {
        repositories,
        revision:actor=>db.prepare('SELECT revision FROM SocialRevisions WHERE user_id=@actor').safeIntegers(true).get({actor}).revision.toString(),
        read:work=>db.transaction(work).deferred(),
        // Preserve domain authorization errors while SQLite rolls back the same connection.
        // The generic DB-1 wrapper intentionally converts non-repository errors to DATABASE.
        write:work=>db.transaction(work).immediate(),
        active:id=>get(`SELECT ${publicColumns} FROM AccountCredentials a ${publicJoins} WHERE a.user_id=@id AND a.status='active'`,{id}),
        isBlocked(a,b) {return !!get('SELECT 1 FROM Blocks WHERE (blocker_id=@a AND blocked_id=@b) OR (blocker_id=@b AND blocked_id=@a)',{a,b});},
        blockedIds:actor=>all('SELECT blocked_id AS user_id FROM Blocks WHERE blocker_id=@actor UNION SELECT blocker_id AS user_id FROM Blocks WHERE blocked_id=@actor',{actor}).map(row=>row.user_id),
        ownProfile:actor=>get(`SELECT ${publicColumns},p.custom_status,p.presence_preference FROM AccountCredentials a ${publicJoins}
            WHERE a.user_id=@actor AND a.status='active'`,{actor}),
        publicProfile:(actor,id)=>get(`SELECT ${publicColumns},${relationshipColumns} FROM AccountCredentials a ${publicJoins} ${relationships}
            WHERE u.user_id=@id AND a.status='active' AND ${noBlock}`,{actor,id}),
        search(actor,prefix,pagination) {
            return all(`SELECT ${publicColumns},${relationshipColumns} FROM AccountCredentials a ${publicJoins} ${relationships}
                WHERE a.username_key>=@prefix AND a.username_key<@end AND a.status='active' AND ${noBlock}
                AND (@lastName IS NULL OR (a.username_key,u.user_id)>(@lastName,@lastId))
                ORDER BY a.username_key,u.user_id LIMIT @take`,{actor,prefix,end:prefix+'\uffff',...cursorParameters(pagination)});
        },
        friends(actor,pagination) {
            return all(`WITH own AS (
                SELECT user_high AS other FROM Friendships WHERE user_low=@actor AND origin='authenticated'
                UNION ALL SELECT user_low FROM Friendships WHERE user_high=@actor AND origin='authenticated')
                SELECT ${publicColumns} FROM own JOIN AccountCredentials a ON a.user_id=own.other ${publicJoins}
                WHERE a.status='active' AND ${noBlock} AND (@lastName IS NULL OR (a.username_key,u.user_id)>(@lastName,@lastId))
                ORDER BY a.username_key,u.user_id LIMIT @take`,{actor,...cursorParameters(pagination)});
        },
        blocks(actor,pagination) {
            return all(`SELECT ${publicColumns} FROM Blocks b JOIN AccountCredentials a ON a.user_id=b.blocked_id ${publicJoins}
                WHERE b.blocker_id=@actor AND a.status='active'
                AND (@lastName IS NULL OR (a.username_key,u.user_id)>(@lastName,@lastId))
                ORDER BY a.username_key,u.user_id LIMIT @take`,{actor,...cursorParameters(pagination)});
        },
        requests(actor,direction,status,pagination) {
            return all(`WITH own AS (
                SELECT r.*,'incoming' AS direction,sender_id AS other FROM FriendRequests r WHERE recipient_id=@actor AND @direction<>'outgoing'
                    AND origin='authenticated' AND (@status='all' OR status=@status)
                UNION ALL SELECT r.*,'outgoing',recipient_id FROM FriendRequests r WHERE sender_id=@actor AND @direction<>'incoming'
                    AND origin='authenticated' AND (@status='all' OR status=@status))
                SELECT ${publicColumns},own.request_id,own.status,own.created_at,own.resolved_at,own.direction
                FROM own JOIN AccountCredentials a ON a.user_id=own.other ${publicJoins} WHERE a.status='active' AND ${noBlock}
                AND (@lastTime IS NULL OR (own.created_at,own.request_id)<(@lastTime,@lastId))
                ORDER BY own.created_at DESC,own.request_id DESC LIMIT @take`,{actor,direction,status,
                take:pagination.limit+1,lastTime:pagination.after?.[0] ?? null,lastId:pagination.after?.[1] ?? null});
        },
        request:id=>get("SELECT * FROM FriendRequests WHERE request_id=@id AND origin='authenticated'",{id}),
        pending(a,b) {return get("SELECT * FROM FriendRequests WHERE min(sender_id,recipient_id)=@low AND max(sender_id,recipient_id)=@high AND status='pending' AND origin='authenticated'",{low:pair(a,b)[0],high:pair(a,b)[1]});},
        friendship(a,b) {const [low,high]=pair(a,b);return get("SELECT * FROM Friendships WHERE user_low=@low AND user_high=@high AND origin='authenticated'",{low,high});},
        retireLegacyPending(a,b,at) {
            const [low,high]=pair(a,b);
            db.prepare("UPDATE FriendRequests SET status='cancelled',resolved_at=@at WHERE origin='legacy' AND status='pending' AND min(sender_id,recipient_id)=@low AND max(sender_id,recipient_id)=@high").run({low,high,at});
        },
        insertRequest(sender,recipient,at) {
            const id=randomUUID();db.prepare("INSERT INTO FriendRequests(request_id,sender_id,recipient_id,created_at,origin) VALUES(?,?,?,?,'authenticated')").run(id,sender,recipient,at);
            return id;
        },
        resolveRequest(id,status,at) {db.prepare('UPDATE FriendRequests SET status=?,resolved_at=? WHERE request_id=?').run(status,at,id);},
        acceptFriendship(a,b,at) {
            const [low,high]=pair(a,b);
            db.prepare(`INSERT INTO Friendships(user_low,user_high,created_at,origin) VALUES(?,?,?,'authenticated')
                ON CONFLICT(user_low,user_high) DO UPDATE SET origin='authenticated',created_at=excluded.created_at WHERE Friendships.origin='legacy'`).run(low,high,at);
        },
        removeFriendship(a,b) {const [low,high]=pair(a,b);db.prepare('DELETE FROM Friendships WHERE user_low=? AND user_high=?').run(low,high);},
        block(actor,target,at) {
            db.prepare(`INSERT INTO Blocks(blocker_id,blocked_id,created_at,origin) VALUES(?,?,?,'authenticated')
                ON CONFLICT(blocker_id,blocked_id) DO UPDATE SET origin='authenticated'`).run(actor,target,at);
            const [low,high]=pair(actor,target);
            db.prepare("UPDATE FriendRequests SET status='cancelled',resolved_at=? WHERE min(sender_id,recipient_id)=? AND max(sender_id,recipient_id)=? AND status='pending'").run(at,low,high);
        },
        unblock(actor,target) {db.prepare('DELETE FROM Blocks WHERE blocker_id=? AND blocked_id=?').run(actor,target);}
    };
}
module.exports={createSocialRepository};
