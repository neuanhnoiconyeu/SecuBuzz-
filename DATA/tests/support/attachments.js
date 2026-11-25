const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const {Readable}=require('node:stream');const {encode}=require('../../server/attachments/frame');
function storageRoot(t){const base=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(base,'secubuzz-db5-'));t.after(()=>{for(const name of fs.readdirSync(root))fs.unlinkSync(path.join(root,name));fs.rmdirSync(root);});return root;}
function guardStorageRoot(root){const real=fs.realpathSync(root),base=fs.realpathSync(os.tmpdir()),rel=path.relative(base,real);if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel))throw new Error('storage root outside temporary directory');return real;}
function frame(header,content){return encode(header,content);}
function upload(browser,header,bytes,csrf){return browser.request('/api/attachments',{method:'POST',rawBody:frame(header,bytes),headers:{'Content-Type':'application/vnd.secubuzz.attachment-frame','X-CSRF-Token':csrf}});}
function snapshotStorage(root){return fs.readdirSync(guardStorageRoot(root)).sort().map(name=>({name,size:fs.statSync(path.join(root,name)).size}));}
function extendSnapshot(snapshot,root){return {...snapshot,storage:snapshotStorage(root)};}
module.exports={storageRoot,guardStorageRoot,frame,upload,snapshotStorage,extendSnapshot};
