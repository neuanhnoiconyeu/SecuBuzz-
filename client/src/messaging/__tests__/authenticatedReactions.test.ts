import {webcrypto} from 'node:crypto';
import {ApiError,type ApiRequest} from '@/api/sessionApi';
import type {StoredMessage} from '@/security/e2ee/model';
import {conversation,envelope} from '@/realtime/testing/authenticatedFixtures';
import {AuthenticatedReactions,type ReactionRecord} from '../authenticatedReactions';
import {isReactionEmoji} from '../../../../shared/reactionEmoji';
import {ALL_EMOJIS} from '@/components/messenger/emojiData';
const m:StoredMessage={...envelope,storageId:'storage-id',sequence:1,revision:0,state:'active',deletedAt:null,storedAt:envelope.timestamp,updatedAt:envelope.timestamp};
beforeAll(()=>Object.defineProperty(globalThis,'crypto',{configurable:true,value:webcrypto}));
async function fixture(initial=false,id=m.id){
  const target={...m,id};
  let record:ReactionRecord={storageId:m.storageId,messageId:target.id,state:'active',version:initial?1:0,actors:initial?[{userId:'alice',emoji:'👍',revision:1,updatedAt:envelope.timestamp}]:[]};
  const post=jest.fn(async(intent:{emoji:string|null;expectedRevision:number;operationId:string})=>{
    const own=record.actors.find(a=>a.userId==='alice');
    record={...record,version:record.version+1,actors:[...record.actors.filter(a=>a.userId!=='alice'),{userId:'alice',emoji:intent.emoji,revision:(own?.revision??0)+1,updatedAt:envelope.timestamp}]};
    return{conversationId:conversation.id,storageId:m.storageId,messageId:target.id,userId:'alice',emoji:intent.emoji,revision:(own?.revision??0)+1,version:record.version,operationId:intent.operationId};
  });
  const request=jest.fn(async(_path:string,options?:ApiRequest):Promise<unknown>=>options?.method==='POST'?post(options.body as Parameters<typeof post>[0]):{conversationId:conversation.id,items:[record]});
  const store=new AuthenticatedReactions({actor:{id:'alice',username:'alice'},request,dispose(){}});store.authorize([conversation]);store.watch(conversation.id,[target]);await store.refresh(conversation.id);
  return{store,request,post,target,record:(value:ReactionRecord)=>{record=value;}};
}
test('Unicode validation accepts the existing full emoji dataset without permitting text or multiple emojis',()=>{
  expect(ALL_EMOJIS.filter(entry=>!isReactionEmoji(entry.emoji)).map(e=>e.emoji)).toEqual([]);
  for(const input of ['text','👍👍','1','\u200d','🇻','👍\n',null])expect(isReactionEmoji(input)).toBe(false);
});

test.each(['__proto__','constructor','toString'])('wire IDs cannot collide with dictionary properties: %s',async id=>{
  const f=await fixture(false,id);await f.store.set(f.target,'👍');
  expect(f.store.getSnapshot().records[conversation.id]?.[id]?.actors[0]?.emoji).toBe('👍');
  expect(Object.getPrototypeOf(f.store.getSnapshot().records[conversation.id])).toBeNull();f.store.dispose();
});
test('add, replace and remove use absolute intentions, stable storage IDs and the current actor revision',async()=>{
  const f=await fixture();await f.store.set(m,'👍');await f.store.set(m,'👩🏽‍💻');await f.store.set(m,null);
  expect(f.post.mock.calls.map(([body])=>[body.emoji,body.expectedRevision])).toEqual([['👍',0],['👩🏽‍💻',1],[null,2]]);
  expect(f.request).toHaveBeenCalledWith('/api/messages/storage-id/reaction',expect.objectContaining({method:'POST'}));
  expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.actors).toEqual([expect.objectContaining({userId:'alice',emoji:null,revision:3})]);f.store.dispose();
});
test('duplicate clicks share a request and preserve displayed counts until confirmed',async()=>{
  const f=await fixture();let finish!:()=>void;
  f.post.mockImplementationOnce(async intent=>{await new Promise<void>(r=>{finish=r;});return{conversationId:conversation.id,storageId:m.storageId,messageId:m.id,userId:'alice',emoji:intent.emoji,revision:1,version:1,operationId:intent.operationId};});
  const first=f.store.set(m,'👍'),second=f.store.set(m,'👍');expect(first).toBe(second);expect(f.post).toHaveBeenCalledTimes(1);
  expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.actors).toEqual([]);
  f.record({storageId:m.storageId,messageId:m.id,state:'active',version:1,actors:[{userId:'alice',emoji:'👍',revision:1,updatedAt:envelope.timestamp}]});finish();await first;f.store.dispose();
});
test('failed removal preserves the reaction and retries the same unresolved operation',async()=>{
  const f=await fixture(true);f.post.mockRejectedValueOnce(new ApiError('service_unavailable'));
  await expect(f.store.set(m,null)).rejects.toThrow();expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.actors[0]?.emoji).toBe('👍');
  await f.store.set(m,null);expect(f.post.mock.calls[0]![0]).toEqual(f.post.mock.calls[1]![0]);f.store.dispose();
});
test('lost acknowledgment reconciles without another mutation and cannot remove the other participant',async()=>{
  const f=await fixture();f.post.mockImplementationOnce(async()=>{
    f.record({storageId:m.storageId,messageId:m.id,state:'active',version:2,actors:[{userId:'alice',emoji:'🔥',revision:1,updatedAt:envelope.timestamp},{userId:'bob',emoji:'👍',revision:1,updatedAt:envelope.timestamp}]});throw new ApiError('unavailable');
  });await f.store.set(m,'🔥');expect(f.post).toHaveBeenCalledTimes(1);expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.actors).toHaveLength(2);f.store.dispose();
});
test('malformed duplicate actors and stale snapshots cannot overwrite confirmed state',async()=>{
  const f=await fixture(true),actor={userId:'alice',emoji:'🔥',revision:2,updatedAt:envelope.timestamp};
  f.record({storageId:m.storageId,messageId:m.id,state:'active',version:2,actors:[actor,actor]});await expect(f.store.refresh(conversation.id)).rejects.toThrow();
  expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.version).toBe(1);
  f.record({storageId:m.storageId,messageId:m.id,state:'deleted',version:3,actors:[]});await f.store.refresh(conversation.id);
  f.record({storageId:m.storageId,messageId:m.id,state:'active',version:4,actors:[actor]});await f.store.refresh(conversation.id);
  expect(f.store.getSnapshot().records[conversation.id]?.[m.id]?.state).toBe('deleted');f.store.dispose();
});
test('authorization removal ignores late responses and disposal prevents account data retention',async()=>{
  const f=await fixture(true);let finish!:(value:unknown)=>void;f.request.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
  const pending=f.store.refresh(conversation.id);f.store.authorize([]);finish({conversationId:conversation.id,items:[]});await pending;
  expect(f.store.getSnapshot().records).toEqual({});await expect(f.store.set(m,'👍')).rejects.toThrow();f.store.dispose();expect(f.store.getSnapshot().records).toEqual({});
});
