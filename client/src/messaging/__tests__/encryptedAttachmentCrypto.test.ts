import {encryptAttachment,decryptAttachment,fileDigest} from '../encryptedAttachmentCrypto';
import {encodeAuthenticatedContent,decodeAuthenticatedContent} from '../authenticatedContent';
import {parseEncryptedAttachment} from '../../../../shared/encryptedAttachments';
import {makeAttachmentFile} from '../../../test/attachmentFixtures';
const scope={conversationId:'dm-test',messageId:crypto.randomUUID(),senderId:'alice',id:crypto.randomUUID()};
test.each([['private.png','image/png'],['private.mp4','video/mp4'],['private.pdf','application/pdf'],['private.docx','application/vnd.openxmlformats-officedocument.wordprocessingml.document']])('encrypts and authenticates %s without losing its bytes',async(name,type)=>{
  const file=makeAttachmentFile(name,type),encrypted=await encryptAttachment(file,scope);
  expect(encrypted.bytes.byteLength).toBe(file.size+16);
  const content=encodeAuthenticatedContent({text:'',attachments:[encrypted.manifest]});
  expect(decodeAuthenticatedContent(content)?.attachments).toEqual([encrypted.manifest]);
  const blob=await decryptAttachment(encrypted.manifest,encrypted.bytes);
  const {readAttachmentBytes}=await import('../attachmentFiles');
  expect(await readAttachmentBytes(blob)).toEqual(await readAttachmentBytes(file));expect(blob.type).toBe(type);
});
test('rejects corruption, substituted keys, modified metadata and cross-message or conversation replay before returning a Blob',async()=>{
  const encrypted=await encryptAttachment(makeAttachmentFile('secret.pdf','application/pdf'),scope);
  const bad=encrypted.bytes.slice(0);new Uint8Array(bad)[0]^=1;
  await expect(decryptAttachment(encrypted.manifest,bad)).rejects.toThrow('integrity');
  await expect(decryptAttachment({...encrypted.manifest,sha256:await fileDigest(bad)},bad)).rejects.toThrow('integrity');
  for(const patch of [{conversationId:'another-chat'},{messageId:crypto.randomUUID()},{senderId:'bob'},{name:'other.pdf'},{key:'A'.repeat(43)}])
    await expect(decryptAttachment({...encrypted.manifest,...patch},encrypted.bytes)).rejects.toThrow('integrity');
  expect(parseEncryptedAttachment({...encrypted.manifest,extra:true})).toBeNull();
});
test('file keys and IVs are fresh per file, and media forwarding requires a valid encrypted operation',async()=>{
  const file=makeAttachmentFile('secret.pdf','application/pdf'),a=await encryptAttachment(file,scope),b=await encryptAttachment(file,{...scope,id:crypto.randomUUID()});
  expect(a.manifest.key).not.toBe(b.manifest.key);expect(a.manifest.iv).not.toBe(b.manifest.iv);
  const forwarded={text:'Forward',attachments:[a.manifest],forwarded:true as const,operation:{id:'operation',part:'message' as const}};
  expect(decodeAuthenticatedContent(encodeAuthenticatedContent(forwarded))).toEqual(forwarded);
  expect(()=>encodeAuthenticatedContent({...forwarded,operation:{id:'operation',part:'note'}})).toThrow();
  expect(()=>encodeAuthenticatedContent({text:'Forward',attachments:[a.manifest],forwarded:true})).toThrow();
});
