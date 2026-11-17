const { digest }=require('./security');
// Synchronous replaceable interface: consume([{key,limit,windowMs}], nowMs).
// SQLite transactions share limits across workers using the same database file.
function createSqliteRateLimiter(db) {
    return {
        consume(buckets,nowMs) {
            return db.transaction(()=>{
                db.prepare('DELETE FROM AuthRateLimits WHERE expires_at_ms<=?').run(nowMs);
                const candidates=buckets.map(bucket=>{
                    const hash=digest(bucket.key);
                    const previous=db.prepare('SELECT * FROM AuthRateLimits WHERE bucket_hash=?').get(hash);
                    return {...bucket,hash,previous};
                });
                const denied=candidates.filter(bucket=>bucket.previous && bucket.previous.attempts>=bucket.limit);
                if (denied.length) return {allowed:false,retryAfterSeconds:Math.max(1,...denied.map(bucket=>Math.ceil((bucket.previous.expires_at_ms-nowMs)/1000)))};
                for (const bucket of candidates) {
                    db.prepare(`INSERT INTO AuthRateLimits(bucket_hash,window_start_ms,expires_at_ms,attempts) VALUES(?,?,?,1)
                        ON CONFLICT(bucket_hash) DO UPDATE SET attempts=attempts+1`).run(bucket.hash,nowMs,nowMs+bucket.windowMs);
                }
                return {allowed:true};
            }).immediate();
        }
    };
}
module.exports={ createSqliteRateLimiter };
