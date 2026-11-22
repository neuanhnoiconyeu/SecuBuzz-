/** @jest-environment node */
import 'fake-indexeddb/auto';
import {BrowserKeyStore} from '../storage';
import {parseEditProof,editStatement} from '../../../../../shared/messageRevisions';

const core={v:1 as const,storageId:'stored',messageId:'wire',conversationId:'chat',senderId:'alice',revision:1,operationId:'11111111-2222-4333-8444-555555555555',previousHash:'a'.repeat(64),keyId:'A'.repeat(22),signerDeviceKeyId:'A'.repeat(43),editedAt:'2026-11-22T00:00:00.000Z',envelopeHash:'b'.repeat(64),signature:'A'.repeat(86)};
test('revision proofs reject gaps outside bounds, caller-added fields and noncanonical identities',()=>{
 expect(parseEditProof(core)).toEqual(core);
 for(const input of [{...core,revision:0},{...core,revision:21},{...core,revision:1.5},{...core,operationId:'../other'},{...core,previousHash:'not-a-hash'},{...core,plaintext:'never public'},{...core,editedAt:'2026-11-22'}])expect(parseEditProof(input)).toBeNull();
 expect(editStatement(core)).not.toBe(editStatement({...core,storageId:'other'}));
 expect(editStatement(core)).not.toBe(editStatement({...core,previousHash:'f'.repeat(64)}));
});
test('atomic account-scoped watermarks persist after reload and refuse rollback, forks and resurrection',async()=>{
 const name='revision-watermarks-'+Math.random(),a=new BrowserKeyStore('alice',name),b=new BrowserKeyStore('bob',name);
 await expect(a.observeRevision('message',['root'])).resolves.toBe(true);
 await expect(a.observeRevision('message',['root','first','second'])).resolves.toBe(true);a.close();
 const restored=new BrowserKeyStore('alice',name);
 await expect(restored.observeRevision('message',['root','first'])).resolves.toBe(false);
 await expect(restored.observeRevision('message',['root','first','fork'])).resolves.toBe(false);
 await expect(b.observeRevision('message',['bob-root'])).resolves.toBe(true);
 await expect(restored.observeRevision('message',['root','first','second','third'])).resolves.toBe(true);
 await expect(restored.observeRevision('message',[],true)).resolves.toBe(true);
 await expect(restored.observeRevision('message',['root','first','second','third','resurrect'])).resolves.toBe(false);restored.close();b.close();
});
test('racing history reads cannot lower an already observed revision',async()=>{
 const store=new BrowserKeyStore('alice','revision-race-'+Math.random());
 await expect(store.observeRevision('message',['root','one','two'])).resolves.toBe(true);
 const results=await Promise.all([store.observeRevision('message',['root','one']),store.observeRevision('message',['root','one','two','three'])]);
 expect(results).toEqual([false,true]);await expect(store.observeRevision('message',['root','one','two'])).resolves.toBe(false);store.close();
});
