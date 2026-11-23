import {VOICE_LIMITS} from '../../../shared/encryptedVoice';
import {matchesAttachmentSignature} from '../../../shared/attachmentSignatures';
import {readAttachmentBytes} from './attachmentFiles';
const formats:Record<string,string>={'audio/webm':'weba','audio/mp4':'m4a','audio/ogg':'ogg','audio/wav':'wav'};
export async function inspectVoiceAudio(blob:Blob,signal?:AbortSignal):Promise<{durationSeconds:number;mimeType:string;extension:string}>{
  const mimeType=blob.type.split(';')[0]!.trim().toLowerCase(),extension=formats[mimeType];
  if(!extension||blob.size<=0||blob.size>VOICE_LIMITS.maxBytes)throw new Error('Voice recordings must use supported audio and be 20 MB or less.');
  if(signal?.aborted)throw new Error('Voice processing was cancelled.');
  const bytes=await readAttachmentBytes(blob);
  if(!matchesAttachmentSignature('voice.'+extension,new Uint8Array(bytes.slice(0,4096))))throw new Error('This recording is not valid audio. Record it again.');
  if(typeof OfflineAudioContext==='undefined')throw new Error('This browser cannot verify recorded audio. Try a supported browser.');
  let audio:AudioBuffer;
  try{audio=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes);}
  catch{throw new Error('This recording could not be decoded. Record it again or try another browser.');}
  if(signal?.aborted)throw new Error('Voice processing was cancelled.');
  if(!Number.isFinite(audio.duration)||audio.duration<=0||audio.duration>VOICE_LIMITS.maxSeconds||audio.numberOfChannels<1||audio.numberOfChannels>2)throw new Error('Voice recordings must be mono or stereo and no longer than 5 minutes.');
  return {durationSeconds:Math.max(0.001,Math.round(audio.duration*1000)/1000),mimeType,extension};
}
export async function verifyVoicePlayback(blob:Blob,durationSeconds:number,signal?:AbortSignal):Promise<void>{
  const decoded=await inspectVoiceAudio(blob,signal);
  if(!Number.isFinite(durationSeconds)||durationSeconds<=0||durationSeconds>VOICE_LIMITS.maxSeconds||Math.abs(decoded.durationSeconds-durationSeconds)>0.5)throw new Error('The voice recording duration could not be verified.');
}
