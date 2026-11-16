const path=require('node:path');
const {createApiApp}=require('./src/api-app.cjs');

// Optional integration: set AUTH_MIDDLEWARE_MODULE to a CommonJS module that exports
// Express middleware. That middleware must verify the session/JWT and set req.user.user_id.
let authenticate=null;
if(process.env.AUTH_MIDDLEWARE_MODULE){
  const modulePath=path.resolve(process.cwd(),process.env.AUTH_MIDDLEWARE_MODULE);
  authenticate=require(modulePath);
  if(authenticate && authenticate.default) authenticate=authenticate.default;
}
const app=createApiApp(authenticate);
const host=process.env.API_HOST||'127.0.0.1';
const port=Number.parseInt(process.env.API_PORT||'3001',10);
app.listen(port,host,()=>process.stdout.write(`DB-5/DB-6 API listening at http://${host}:${port}\n`));
