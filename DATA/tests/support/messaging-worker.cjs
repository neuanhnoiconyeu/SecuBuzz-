// No production/environment flag enables fixture verification in DATA/server.js.
// This dedicated test entrypoint refuses normal environments and non-fixture DB paths.
if(require.main===module&&process.env.SECUBUZZ_ISOLATED_MESSAGE_WORKER==='1'){
    const path=require('node:path');const os=require('node:os');
    const database=path.resolve(process.env.DB_PATH||'');const prefix=path.join(os.tmpdir(),'secubuzz-db2-').toLowerCase();
    if(process.env.NODE_ENV!=='test'||!database.toLowerCase().startsWith(prefix)||path.basename(database)!=='auth.sqlite')throw new Error('Isolated fixture database required');
    const {startServer}=require('../../server/start');const {fixtureVerifier}=require('./messaging');
    startServer({messageOptions:{recipientKeyVerifier:fixtureVerifier}}).then(app=>{
        console.log('Isolated messaging fixture listening on port '+app.server.address().port);
        let closing=false;const close=()=>{if(closing)return;closing=true;app.close().catch(()=>{process.exitCode=1;});};process.once('SIGINT',close);process.once('SIGTERM',close);
    }).catch(()=>{console.error('Isolated fixture startup failed');process.exitCode=1;});
}
