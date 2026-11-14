import { useCallback, useEffect, useRef, useState } from 'react';
import { AIError, validateAIRequest, type AIProvider, type AIRequest, type AIResponse, type AISelection } from './aiModel';
import { executeAIRequest } from './executeAIRequest';

export interface AIChatMessage { id: number; role: 'user' | 'assistant'; text: string; status?: 'pending' | 'completed' | 'cancelled' | 'failed'; kind?: AIResponse['kind'] }
export interface AIResult { id: number; request: AIRequest; response: AIResponse; selection?: AISelection }
export interface AIRecentTask { id: number; request: AIRequest; status: 'completed' | 'cancelled' | 'failed'; result?: AIResult }
interface Job { id: number; request: AIRequest; selection?: AISelection; userId?: number; attempts: number }

/** Memory only; its owner is keyed to the authenticated Messenger/conversation lifetime. */
export function useAIWorkspace(provider: AIProvider) {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [recent, setRecent] = useState<AIRecentTask[]>([]);
  const [result, setResult] = useState<AIResult | null>(null);
  const [pending, setPending] = useState<AIRequest | null>(null);
  const [failure, setFailure] = useState<{ error: AIError; task: AIRequest['task']; canRetry: boolean } | null>(null);
  const sequence = useRef(0);
  const generation = useRef(0);
  const current = useRef<{ controller: AbortController; job: Job } | null>(null);
  const failedJob = useRef<Job | null>(null);
  const updateUser = useCallback((job: Job, status: NonNullable<AIChatMessage['status']>) => {
    if (job.userId !== undefined) setMessages(items => items.map(item => item.id === job.userId ? { ...item, status } : item));
  }, []);
  const remember = useCallback((item: AIRecentTask) => setRecent(items => [item, ...items.filter(previous => previous.id !== item.id)].slice(0, 20)), []);

  useEffect(() => {
    setMessages([]); setRecent([]); setResult(null); setPending(null); setFailure(null);
    failedJob.current = null;
    return () => { generation.current += 1; current.current?.controller.abort(); current.current = null; failedJob.current = null; };
  }, [provider]);

  const perform = async (job: Job, remoteConsent: boolean) => {
    if (current.current) return;
    const controller = new AbortController();
    const token = ++generation.current;
    current.current = { controller, job };
    setPending(job.request); setResult(null); setFailure(null); failedJob.current = null;
    updateUser(job, 'pending');
    try {
      const response = await executeAIRequest(provider, job.request, { signal: controller.signal, remoteConsent });
      if (token !== generation.current) return;
      const completed: AIResult = { id: job.id, request: job.request, response, ...(job.selection ? { selection: job.selection } : {}) };
      setResult(completed); updateUser(job, 'completed');
      if (job.request.task === 'chat') {
        const assistantId = ++sequence.current;
        setMessages(items => [...items, {
          id: assistantId, role: 'assistant' as const, text: response.output, kind: response.kind,
        }].slice(-60));
      }
      remember({ id: job.id, request: job.request, status: 'completed', result: completed });
    } catch (error) {
      if (token !== generation.current) return;
      const safe = error instanceof AIError ? error : new AIError('request_failed');
      updateUser(job, safe.code === 'cancelled' ? 'cancelled' : 'failed');
      if (safe.code !== 'cancelled') {
        failedJob.current = job;
        setFailure({ error: safe, task: job.request.task, canRetry: safe.retryable && job.attempts < 3 });
      }
      remember({ id: job.id, request: job.request, status: safe.code === 'cancelled' ? 'cancelled' : 'failed' });
    } finally {
      if (token === generation.current) { current.current = null; setPending(null); }
    }
  };

  const run = async (untrusted: AIRequest, selection?: AISelection, remoteConsent = false) => {
    if (current.current) return;
    let request: AIRequest;
    try { request = validateAIRequest(untrusted); }
    catch { setFailure({ error: new AIError('invalid_input'), task: untrusted.task, canRetry: false }); return; }
    const id = ++sequence.current;
    const source = selection && selection.conversationId === request.conversationId && selection.input === request.input
      ? { task: selection.task, input: selection.input, conversationId: selection.conversationId, kind: selection.kind,
        ...(selection.messageId ? { messageId: selection.messageId } : {}) } : undefined;
    const job: Job = { id, request, attempts: 1, ...(source ? { selection: source } : {}) };
    if (request.task === 'chat') {
      job.userId = id;
      setMessages(items => [...items, { id, role: 'user' as const, text: request.input, status: 'pending' as const }].slice(-60));
    }
    await perform(job, remoteConsent);
  };

  const cancel = useCallback(() => {
    const active = current.current;
    if (!active) return;
    generation.current += 1; current.current = null; active.controller.abort();
    updateUser(active.job, 'cancelled'); setPending(null);
    remember({ id: active.job.id, request: active.job.request, status: 'cancelled' });
  }, [remember, updateUser]);

  const retry = async (remoteConsent = false) => {
    const job = failedJob.current;
    if (!job || current.current || job.attempts >= 3 || !failure?.error.retryable) return;
    await perform({ ...job, attempts: job.attempts + 1 }, remoteConsent);
  };
  const clearFailure = () => { failedJob.current = null; setFailure(null); };
  const resetChat = () => {
    if (current.current?.job.request.task === 'chat') cancel();
    setMessages([]); setRecent(items => items.filter(item => item.request.task !== 'chat'));
    if (result?.request.task === 'chat') setResult(null);
    if (failure?.task === 'chat') clearFailure();
  };
  const viewResult = (id: number) => {
    const record = recent.find(item => item.id === id);
    if (record?.result && !current.current) { setResult(record.result); clearFailure(); return record.result; }
    return null;
  };
  return { messages, recent, result, pending, failure, run, cancel, retry, clearFailure, resetChat, viewResult };
}
