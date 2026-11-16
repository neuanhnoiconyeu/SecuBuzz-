const { createServer }=require('node:http');
const { openDatabase }=require('./database/connection');
const { databaseConfig }=require('./database/config');
const { loadAuthConfig }=require('./auth/config');
const { createApp }=require('./app');
async function startServer({env=process.env,db,config=loadAuthConfig(env),...dependencies}={}) {
    const owned=!db;
    const database=db || openDatabase(databaseConfig(env));
    let server;
    try {
        const application=createApp({db:database,config,...dependencies});
        await application.auth.ready;
        server=createServer({maxHeaderSize:16384},application.app);
        server.requestTimeout=15000;
        server.headersTimeout=10000;
        server.keepAliveTimeout=5000;
        server.maxHeadersCount=100;
        await new Promise((resolve,reject)=>{
            server.once('error',reject);
            server.listen(Number(env.PORT || 5000),env.HOST || '127.0.0.1',()=>{server.off('error',reject);resolve();});
        });
        return {...application,server,db:database,async close() {
            await new Promise((resolve,reject)=>{
                server.close(error=>error ? reject(error) : resolve());
                server.closeIdleConnections();
            });
            if (owned) database.close();
        }};
    } catch (error) {
        if (server?.listening) server.close();
        if (owned && database.open) database.close();
        throw error;
    }
}
module.exports={startServer};
