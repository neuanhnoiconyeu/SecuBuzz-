require('dotenv').config({path:require('node:path').join(__dirname,'../.env'),quiet:true});
const { openDatabase }=require('../server/database/connection');
const { createAuthRepository }=require('../server/database/authRepository');
try {
    const db=openDatabase();
    try { console.log(JSON.stringify(createAuthRepository(db).cleanup(Date.now()))); }
    finally { db.close(); }
} catch {
    console.error('Auth cleanup failed. Check database configuration and availability.');
    process.exitCode=1;
}
