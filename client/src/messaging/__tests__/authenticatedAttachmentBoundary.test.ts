import {mapDb6Upload} from '../db6Attachments';
import {AUTHENTICATED_CONTENT_PREFIX,decodeAuthenticatedContent} from '../authenticatedContent';
import {REAL_ACCOUNT_MESSAGING_CAPABILITIES} from '../messagingCapabilities';
import {presentMessages} from '@/components/messenger/authenticatedChatPresentation';
import {envelope} from '@/realtime/testing/authenticatedFixtures';
import type {StoredMessage} from '@/security/e2ee/model';

test('real-account capabilities enable encrypted files and voice while calls remain disabled',()=>{
  expect(REAL_ACCOUNT_MESSAGING_CAPABILITIES.attachments).toBe(true);
  expect(REAL_ACCOUNT_MESSAGING_CAPABILITIES.voiceMessages).toBe(true);
  expect(REAL_ACCOUNT_MESSAGING_CAPABILITIES.directCalls).toBe(false);
});
test('DB6 encrypted metadata cannot be mistaken for the existing plaintext attachment transport',()=>{
  const row={attachment_id:'550e8400-e29b-41d4-a716-446655440000',original_name:null,mime_type:'application/octet-stream',size_bytes:32,
    group_id:null,recipient_user_id:'bob',encryption_algorithm:'AES-256-GCM',deleted_at:null,expires_at:null,file_iv:'opaque',file_auth_tag:'opaque'};
  expect(mapDb6Upload(row,{type:'direct',recipientUserId:'bob'},{name:'private.pdf',size:32})).toBeNull();
});
test('unapproved file-key metadata is rejected by the current content version and never rendered or marked verified',()=>{
  const text=AUTHENTICATED_CONTENT_PREFIX+JSON.stringify({v:1,text:'Caption',attachments:[{id:'file',name:'private.pdf',key:'PRIVATE_FILE_KEY'}]});
  expect(decodeAuthenticatedContent(text)).toBeNull();
  const message:StoredMessage={...envelope,storageId:'storage',sequence:1,revision:0,state:'active',deletedAt:null,storedAt:envelope.timestamp,updatedAt:envelope.timestamp};
  const presented=presentMessages([{message,text,error:null}]);
  expect(presented.messages[0]?.type).toBe('security_alert');expect(presented.messages[0]?.content).not.toMatch(/PRIVATE_FILE_KEY|private.pdf/);
  expect(presented.verifiedIds.has(message.id)).toBe(false);
});
test('a valid protected manifest bound to another message is never rendered or marked verified',()=>{
  const manifest={v:1,id:crypto.randomUUID(),conversationId:envelope.conversationId,messageId:crypto.randomUUID(),senderId:envelope.senderId,
    name:'private.pdf',mimeType:'application/pdf',size:64,key:'A'.repeat(43),iv:'A'.repeat(16),sha256:'a'.repeat(64)};
  const text=AUTHENTICATED_CONTENT_PREFIX+JSON.stringify({v:2,text:'',attachments:[manifest]});
  expect(decodeAuthenticatedContent(text)?.attachments).toHaveLength(1);
  const message:StoredMessage={...envelope,id:crypto.randomUUID(),storageId:'storage',sequence:1,revision:0,state:'active',deletedAt:null,storedAt:envelope.timestamp,updatedAt:envelope.timestamp};
  const presented=presentMessages([{message,text,error:null}]);expect(presented.messages[0]?.type).toBe('security_alert');
  expect(presented.messages[0]?.attachments).toBeUndefined();expect(presented.verifiedIds.has(message.id)).toBe(false);
});
