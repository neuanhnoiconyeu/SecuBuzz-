const express = require('express');
const groups = require('./routes/groups.cjs');
const attachments = require('./routes/attachment.cjs');

function createApiApp(authenticate) {
  const app=express();
  app.disable('x-powered-by');
  app.use(express.json({limit:'2mb'}));
  app.get('/healthz',(req,res)=>res.json({status:'ok'}));
  // The supplied project files do not include an authentication/session middleware.
  // Inject the real middleware here; it must set req.user = { user_id: '...' }.
  const auth=typeof authenticate==='function' ? authenticate : (req,res)=>res.status(503).json({error:'Authentication adapter is not configured'});
  app.use('/api/groups',auth,groups);
  app.use('/api/attachments',auth,attachments);
  app.use('/api/files',auth,attachments);
  app.use((err,req,res,next)=>{
    if(res.headersSent) return next(err);
    const status=Number.isInteger(err.status)?err.status:500;
    res.status(status).json({error:status===500?'Internal server error':err.message});
  });
  return app;
}
module.exports={createApiApp};
