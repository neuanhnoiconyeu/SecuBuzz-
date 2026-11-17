require('dotenv').config({path:require('node:path').join(__dirname,'.env'),quiet:true});
const { startServer }=require('./server/start');
if (require.main===module) {
    startServer().then(application=>{
        console.log('SecuBuzz API listening on port '+application.server.address().port);
        let stopping=false;
        const stop=()=>{if (stopping) return;stopping=true;application.close().catch(()=>{process.exitCode=1;});};
        process.once('SIGINT',stop);
        process.once('SIGTERM',stop);
    }).catch(()=>{console.error('API startup failed. Check auth configuration, dependencies and database availability.');process.exitCode=1;});
}
module.exports={startServer};
