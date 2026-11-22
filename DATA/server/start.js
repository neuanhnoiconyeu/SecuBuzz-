const { createServer }=require('node:http');
const { openDatabase }=require('./database/connection');
const { databaseConfig }=require('./database/config');
const { loadAuthConfig }=require('./auth/config');
const { loadFeatureConfig }=require('./features/config');
const { createApp }=require('./app');

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
    try {
        const application=createApp({db:database,config,features:featureConfig,...dependencies});
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
module.exports={startServer,describeStartFailure,FeatureProvenanceError};
