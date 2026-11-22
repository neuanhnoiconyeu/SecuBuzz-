import type {DirectCallConversationResolver} from '../calls/config.ts';
import {isIdentifier} from '../realtime/validation.ts';
import {dataContext,isDataDenial,type DataApplication} from './types.ts';

/** Calling authority comes from DATA's current direct-conversation policy, never client peer claims. */
export function createDataCallResolver(data:DataApplication):DirectCallConversationResolver{
  return {async resolveDirectConversation(actor,id){
    try{
      const raw:unknown=data.conversations.detail(dataContext(actor),id,{}).conversation;
      if(!raw||typeof raw!=='object')throw new Error('Invalid DATA call conversation');
      const c=raw as Record<string,unknown>;
      if(c.interactionAllowed!==true)return null;
      if(c.id!==id||c.type!=='direct'||!Array.isArray(c.participants)||c.participants.length!==2)throw new Error('Invalid DATA call conversation');
      const people=c.participants.map((value:unknown)=>{
        if(!value||typeof value!=='object')throw new Error('Invalid DATA call participant');
        const p=value as Record<string,unknown>;
        if(!isIdentifier(p.id)||typeof p.displayName!=='string'||!p.displayName.trim()||p.displayName.length>160||/[\u0000-\u001f\u007f]/u.test(p.displayName))throw new Error('Invalid DATA call participant');
        return {userId:p.id,displayName:p.displayName};
      });
      if(people[0]!.userId===people[1]!.userId||!people.some(p=>p.userId===actor.userId))return null;
      return {conversationId:id,type:'direct',participants:[people[0]!,people[1]!]};
    }catch(error){if(isDataDenial(error))return null;throw error;}
  }};
}
