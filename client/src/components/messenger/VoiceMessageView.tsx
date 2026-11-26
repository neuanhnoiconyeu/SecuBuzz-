import {useCallback,useEffect,useMemo,useRef,useState} from 'react';
import {Mic} from 'lucide-react';
import {useAttachmentSource} from '@/hooks/useAttachmentSource';
import type {MessageAttachment,VoiceMessageMetadata} from '@/messaging/messageModel';
import {verifyVoicePlayback} from '@/messaging/voiceAudio';
import {Button} from '@/components/ui';

/** The existing voice layout and native controls serve both demo URLs and verified encrypted audio. */
export function VoiceMessageView({voice,senderName,ownerId,conversationId}:{voice:VoiceMessageMetadata;senderName:string;ownerId:string;conversationId:string}){
  const local=useMemo<MessageAttachment>(()=>({id:'local-voice',name:'voice.weba',type:'audio',url:voice.audioUrl,sizeBytes:0}),[voice.audioUrl]);
  const verify=useCallback((blob:Blob,signal:AbortSignal)=>verifyVoicePlayback(blob,voice.durationSeconds,signal),[voice.durationSeconds]);
  const [retryToken,retry]=useState(0);
  const source=useAttachmentSource(voice.attachment??local,{ownerId,conversationId,...(voice.attachment?{validateBlob:verify,retryToken}:{})});
  const [failed,setFailed]=useState(false);
  const player=useRef<HTMLAudioElement>(null);
  const encrypted=Boolean(voice.attachment);
  useEffect(()=>{
    if(!encrypted)return;const audio=player.current;
    return()=>{if(audio){audio.pause();audio.removeAttribute('src');audio.load();}};
  },[encrypted,source.previewUrl]);
  return <div className="voice-message-card">
    <Mic size={14} style={{flexShrink:0}}/>
    {source.loading?<span role="status">Loading encrypted voice message…</span>:source.error?<><span role="alert">{source.error}</span>{encrypted&&<Button size="sm" variant="ghost" onClick={()=>{setFailed(false);retry(value=>value+1);}}>Retry voice message</Button>}</>:<>
      <audio ref={player} controls preload="metadata" aria-label={`Voice message from ${senderName}`} src={source.previewUrl} style={{height:'28px',maxWidth:'200px',minWidth:0}} onError={()=>setFailed(true)}/>
      <span style={{fontSize:'0.75rem',whiteSpace:'nowrap',flexShrink:0}}>{Math.max(1,Math.round(voice.durationSeconds))}s</span>
    </>}
    {failed&&<span role="status">This browser could not play the voice message.</span>}
  </div>;
}
