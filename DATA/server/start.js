const { createServer }=require('node:http');
const path=require('node:path');
const { openDatabase }=require('./database/connection');
const { databaseConfig }=require('./database/config');
const { loadAuthConfig }=require('./auth/config');
const { loadFeatureConfig }=require('./features/config');
const { createApp }=require('./app');
const { createAttachmentRepository }=require('./database/attachmentRepository');
const { createFilesystemProvider }=require('./attachments/storage/filesystem');
const { createRetentionJob }=require('./attachments/retention');

// T-5C-05 (DB5-R16.7, DB5-R14.10, DB5-R14.17, DB5-R13.3, ARCH-R01.10): the start-up boundary of the feature configuration.
// The three switch variables, as features/config.js reads them. start.js prints a line per set switch, so it names them; a test
// checks that this list and the loader agree.
const SWITCH_VARIABLES=Object.freeze({groupApi:'GROUPS_API_ENABLED',groupMessaging:'GROUP_MESSAGING_ENABLED',attachmentApi:'ATTACHMENTS_API_ENABLED'});
const SETTING_NAME=/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/;
const MIGRATION_FAILURE=/^Migration [0-9]{4}-[a-z0-9-]+\.sql failed; the entire batch was rolled back\./;

// A feature object handed to startServer is test-harness data (DB5-R16.5). It carries no Gate_Record, so in production it is
// refused and the process stops instead of treating the object as authorization. The error names no setting and no value.
class FeatureProvenanceError extends Error {
    constructor() {
        super('An injected feature configuration is refused in production; set the feature switches in the environment.');
        this.name='FeatureProvenanceError';
        this.code='FEATURE_PROVENANCE_REFUSED';
    }
}

// Production is read from the environment the server starts with and from the process itself, so passing a different env
// object into a production process neither allows an injected object nor skips the Gate_Record check.
function resolveFeatures(env,injected) {
    const production=env.NODE_ENV==='production' || process.env.NODE_ENV==='production';
    if (injected!==undefined) {
        if (production) throw new FeatureProvenanceError();
        return injected;
    }
    return loadFeatureConfig(production && env.NODE_ENV!=='production' ? {...env,NODE_ENV:'production'} : env);
}

// One line per switch, every start, in declared order: on or off, never a value. A variable that is unset or holds anything but
// the exact string true is off, so a typo shows as off (tasks.md T-5C-05; design, Startup and configuration failures).
// Printed only for a configuration loaded from the environment: an injected features object skips the load and prints nothing.
function reportSwitches(loaded,log) {
    for (const [name,variable] of Object.entries(SWITCH_VARIABLES)) {
        log(`Feature switch ${variable}: ${loaded[name]===true ? 'on' : 'off'}`);
    }
}

// The one stderr line for a start failure the operator can act on, or null for any other failure. It is built from the error
// code, the setting names and the migration file name only: never a value, a cause, a stack or a path.
function describeStartFailure(error) {
    if (!error || typeof error!=='object') return null;
    if (error.code==='FEATURE_CONFIG_INVALID' && Array.isArray(error.settings)) {
        const names=error.settings.filter(name=>typeof name==='string' && SETTING_NAME.test(name));
        if (names.length>0) return `Feature configuration is incomplete; set a valid value for: ${names.join(', ')}`;
    }
    if (error.code==='FEATURE_PROVENANCE_REFUSED') return new FeatureProvenanceError().message;
    if (error.code==='MIGRATION_FAILED') {
        return typeof error.message==='string' && MIGRATION_FAILURE.test(error.message)
            ? `MIGRATION_FAILED: ${error.message.match(MIGRATION_FAILURE)[0]}`
            : 'MIGRATION_FAILED: a migration failed and the batch was rolled back.';
    }
    return null;
}

async function startServer({env=process.env,db,config=loadAuthConfig(env),features,log=console.log,...dependencies}={}) {
    if (typeof log!=='function') throw new TypeError('startServer needs log to be a function.');
    // The feature configuration loads before openDatabase, so a configuration error never starts a migration. An injected
    // features object skips the load (test harness only); the load is the only way a switch turns on in production.
    const featureConfig=resolveFeatures(env,features);
    if (features===undefined) reportSwitches(featureConfig,log);
    const owned=!db;
    const database=db || openDatabase(databaseConfig(env));
    let server;
    let retentionJob=null;
    try {
        let attachmentStorage=dependencies.storage;
        if (featureConfig.attachmentApi === true && !attachmentStorage) {
            try {
                attachmentStorage=createFilesystemProvider({root:featureConfig.attachments?.storageDir,
                    repositoryRoot:path.resolve(__dirname,'../..')});
            } catch { /* createApp's feature gate remains the authority for fail-closed readiness */ }
        }
        const application=createApp({db:database,config,features:featureConfig,
            ...(attachmentStorage ? {storage:attachmentStorage} : {}),...dependencies});
        if (featureConfig.attachmentApi === true && application.features.attachmentApi !== true) {
            log('Attachment_API disabled: ATTACHMENT_STORAGE_DIR is unavailable');
        }
        if (application.features.attachmentApi === true) {
            retentionJob=createRetentionJob({db:database,repository:createAttachmentRepository(database),storage:attachmentStorage,
                now:dependencies.now || (()=>new Date()),settings:featureConfig.attachments,logger:dependencies.logger || log});
        }
        await application.auth.ready;
        if (retentionJob) await retentionJob.start();
        server=createServer({maxHeaderSize:16384},application.app);
        const uploadTimeoutMs=application.features.attachmentApi === true
            ? (featureConfig.attachments.uploadTimeoutSeconds === undefined ? 15000 : featureConfig.attachments.uploadTimeoutSeconds*1000) : null;
        server.requestTimeout=uploadTimeoutMs ?? 15000;
        // Capture the original path before Express rewrites req.url while mounting routers. The
        // raw socket deadline complements requestTimeout so a stalled upload releases its stream,
        // reservation and .part file even when the HTTP parser has already dispatched the request.
        if (uploadTimeoutMs !== null) server.prependListener('request',(request,response)=>{
            if(request.method!=='POST'||!/^\/api\/attachments\/?$/.test(String(request.url||'').split('?',1)[0]))return;
            const socket=request.socket;
            let timer=setTimeout(()=>socket.destroy(),uploadTimeoutMs);
            timer.unref?.();
            const clear=()=>{if(timer!==null){clearTimeout(timer);timer=null;}};
            request.once('end',clear);socket.once('close',clear);response.once('finish',clear);response.once('close',clear);
        });
        server.headersTimeout=10000;
        server.keepAliveTimeout=5000;
        server.maxHeadersCount=100;
        await new Promise((resolve,reject)=>{
            server.once('error',reject);
            server.listen(Number(env.PORT || 5000),env.HOST || '127.0.0.1',()=>{server.off('error',reject);resolve();});
        });
        return {...application,server,db:database,retentionJob,async close() {
            try {
                await new Promise((resolve,reject)=>{
                    server.close(error=>error ? reject(error) : resolve());
                    server.closeIdleConnections();
                });
            } finally {
                try { if (retentionJob) await retentionJob.stop(); }
                finally { if (owned) database.close(); }
            }
        }};
    } catch (error) {
        if (retentionJob) await retentionJob.stop().catch(()=>{});
        if (server?.listening) server.close();
        if (owned && database.open) database.close();
        throw error;
    }
}
module.exports={startServer,describeStartFailure,FeatureProvenanceError};
