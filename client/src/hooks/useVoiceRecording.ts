import { useCallback, useEffect, useRef, useState } from 'react';
import type { RecordedVoiceDraft } from '@/messaging/messageModel';
import { createAttachmentUrl, releaseAttachmentUrl } from '@/messaging/attachmentUrls';

/** Owns the microphone and the draft URL; accepted messages retain their own URL reference. */
export function useVoiceRecording(active: boolean, disabled: boolean,limits:{maxSeconds?:number;maxBytes?:number}={}) {
  const [draft, setDraft] = useState<RecordedVoiceDraft | null>(null);
  const draftRef = useRef<RecordedVoiceDraft | null>(null);
  const [recording, setRecording] = useState(false), [requesting, setRequesting] = useState(false);
  const [seconds, setSeconds] = useState(0), [error, setError] = useState('');
  const alive = useRef(false), generation = useRef(0), pending = useRef(false);
  const allowed = useRef({ active, disabled,...limits }); allowed.current = { active, disabled,...limits };
  const recorder = useRef<MediaRecorder | null>(null);
  const releaseStream = useRef<(() => void) | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stoppedAt = useRef<number | null>(null);
  const clearTimer = useCallback(() => {
    if (timer.current !== null) { clearInterval(timer.current); timer.current = null; }
  }, []);
  const clearDraft = useCallback(() => {
    if (draftRef.current) releaseAttachmentUrl(draftRef.current.audioUrl);
    draftRef.current = null;
    if (alive.current) { setDraft(null); setError(''); }
  }, []);
  const cancel = useCallback(() => {
    generation.current++; pending.current = false; clearTimer();
    const current = recorder.current; recorder.current = null;
    if (current) {
      current.ondataavailable = null; current.onstop = null; current.onerror = null;
      try { if (current.state !== 'inactive') current.stop(); } catch { /* Track cleanup still runs. */ }
    }
    releaseStream.current?.(); releaseStream.current = null;
    if (alive.current) { setRecording(false); setRequesting(false); }
  }, [clearTimer]);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; cancel(); clearDraft(); };
  }, [cancel, clearDraft]);
  useEffect(() => { if (!active || disabled) cancel(); }, [active, disabled, cancel]);

  const start = async () => {
    if (!alive.current || !allowed.current.active || allowed.current.disabled || pending.current || recorder.current) return;
    setError('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setError('This browser cannot record audio. Open the app in Chrome or Edge.'); return;
    }
    const attempt = ++generation.current;
    const current = () => alive.current && generation.current === attempt && allowed.current.active && !allowed.current.disabled;
    pending.current = true; setRequesting(true);
    let stream: MediaStream | undefined, released = false;
    const release = () => {
      if (stream && !released) { released = true; stream.getTracks().forEach(track => track.stop()); }
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!current()) { release(); return; }
      releaseStream.current = release;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find(type => typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(type));
      const capture = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      const chunks: Blob[] = [];
      const startedAt = Date.now(); stoppedAt.current = null;
      const failed = () => {
        if (generation.current !== attempt) return;
        cancel(); if (alive.current) setError('Audio recording failed. Check your microphone and try again.');
      };
      let capturedBytes=0;
      capture.ondataavailable = event => { if (current() && event.data.size > 0) {
        capturedBytes+=event.data.size;
        if(allowed.current.maxBytes&&capturedBytes>allowed.current.maxBytes){failed();if(alive.current)setError('Voice recordings must be 20 MB or less.');return;}
        chunks.push(event.data);
      } };
      capture.onerror = failed;
      capture.onstop = () => {
        release(); clearTimer();
        if (recorder.current === capture) { recorder.current = null; releaseStream.current = null; }
        if (!current()) return;
        setRecording(false);
        const durationSeconds = Math.max(1, Math.round(((stoppedAt.current ?? Date.now()) - startedAt) / 1000));
        try {
          const blob = new Blob(chunks, { type: capture.mimeType || 'audio/webm' });
          if (!blob.size) { setError('No audio was captured. Check your microphone.'); return; }
          const audioUrl = createAttachmentUrl(blob);
          clearDraft(); draftRef.current = { audioUrl, durationSeconds,blob }; setDraft(draftRef.current);
        } catch { setError('The audio preview could not be created. Record your message again.'); }
      };
      recorder.current = capture;
      if(allowed.current.maxBytes)capture.start(1000);else capture.start();
      if (!current()) { release(); return; }
      clearDraft(); setSeconds(0); setRecording(true);
      timer.current = setInterval(() => {
        if(!current())return;const elapsed=(Date.now()-startedAt)/1000;setSeconds(Math.max(1,Math.round(elapsed)));
        if(allowed.current.maxSeconds&&elapsed>=allowed.current.maxSeconds-1){
          stoppedAt.current=Date.now();clearTimer();try{capture.stop();}catch{failed();}finally{release();}
        }
      },500);
    } catch (failure) {
      release();
      if (generation.current === attempt) {
        cancel();
        if (alive.current) setError(failure instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(failure.name)
          ? 'Microphone access was blocked. Allow the microphone and try again.'
          : 'Audio recording could not start. Check your microphone and try again.');
      }
    } finally {
      if (generation.current === attempt) { pending.current = false; if (alive.current) setRequesting(false); }
    }
  };
  const stop = () => {
    const capture = recorder.current;
    if (!capture || capture.state === 'inactive') return;
    stoppedAt.current = Date.now(); clearTimer();
    try { capture.stop(); }
    catch { cancel(); if (alive.current) setError('Audio recording failed. Record your message again.'); }
    finally { releaseStream.current?.(); }
  };
  return { draft, recording, requesting, seconds, error, start, stop, cancel, clearDraft };
}
