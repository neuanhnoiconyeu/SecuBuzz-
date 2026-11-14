import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bot, Check, Copy, FileText, Languages, ListTodo, LockKeyhole, MessageCircle, RotateCcw, Sparkles, WandSparkles, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { AI_LANGUAGES, AI_MAX_INPUT, AI_TONES, AI_TOOLS, aiTaskTitle, validAIInput,
  type AIEntry, type AIProvider, type AIRequest, type AISelection, type AITask } from '@/ai/aiModel';
import { useAIWorkspace, type AIResult } from '@/ai/useAIWorkspace';
import { AIChatHistory } from './AIChatHistory';

const toolIcons = { summarize: FileText, rewrite: WandSparkles, translate: Languages, action_items: ListTodo, explain: MessageCircle };
interface AIHubProps {
  active: boolean;
  provider: AIProvider;
  conversationId: string;
  entry: AIEntry | null;
  onReviewDraft(result: AIResult): void;
}

function OutputPanel({ result, onReviewDraft }: { result: AIResult; onReviewDraft(result: AIResult): void }) {
  const [copied, setCopied] = useState('');
  const life = useRef(0);
  useEffect(() => { const token = ++life.current; setCopied(''); return () => { if (life.current === token) life.current += 1; }; }, [result.id]);
  const limitation = result.response.kind === 'limitation';
  const canReview = result.request.task === 'rewrite' && result.selection?.kind === 'draft' &&
    result.request.input === result.selection.input && !limitation;
  return <section className="ai-output" aria-label="Tool output">
    <header><h3 className="display-heading display-heading--section">{limitation ? 'A quick heads-up' : 'Your result'}</h3>
      <span className="ai-mini-label">{result.response.provider === 'demo' ? limitation ? 'Demo limitation' : 'Prepared demo example' : 'AI result'}</span></header>
    <p className="ai-output-text">{result.response.output}</p>
    {!limitation && <div className="ai-output-actions">
      <Button size="sm" variant="outline" leadingIcon={copied === 'Copied.' ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
        onClick={async () => {
          const token = life.current;
          try {
            if (!navigator.clipboard?.writeText) throw new Error();
            await navigator.clipboard.writeText(result.response.output);
            if (token === life.current) setCopied('Copied.');
          } catch { if (token === life.current) setCopied('Copy is unavailable. Select the result text to copy it.'); }
        }}>Copy output</Button>
      {canReview && <Button size="sm" onClick={() => onReviewDraft(result)}>Review for draft</Button>}
      <span role="status">{copied}</span>
    </div>}
  </section>;
}

/** Kept mounted during navigation; the Messenger owner keys this to its conversation/session. */
export function AIHub({ active, provider, conversationId, entry, onReviewDraft }: AIHubProps) {
  const workspace = useAIWorkspace(provider);
  const { cancel } = workspace;
  const [pane, setPane] = useState<AITask | 'home'>('home');
  const [input, setInput] = useState('');
  const [tone, setTone] = useState<typeof AI_TONES[number]>('Friendly');
  const [language, setLanguage] = useState<typeof AI_LANGUAGES[number]>('Spanish');
  const [selection, setSelection] = useState<AISelection | null>(null);
  const [consent, setConsent] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const consumedEntry = useRef<number | null>(null);
  useEffect(() => {
    if (!active) cancel();
    else headingRef.current?.focus({ preventScroll: true });
  }, [active, cancel]);
  useEffect(() => {
    if (!entry || entry.id === consumedEntry.current || entry.conversationId !== conversationId) return;
    consumedEntry.current = entry.id;
    cancel(); setPane(entry.task); setInput(entry.input); setSelection({ ...entry }); setConsent(false);
  }, [entry, conversationId, cancel]);
  useEffect(() => { if (active && pane !== 'home') inputRef.current?.focus(); }, [active, pane, entry]);

  const busy = workspace.pending !== null;
  const available = provider.available && provider.mode !== 'unavailable';
  const canSubmit = available && !busy && validAIInput(input) && (provider.mode !== 'remote' || consent);
  const currentTool = AI_TOOLS.find(tool => tool.task === pane);
  const choose = (next: AITask | 'home') => {
    cancel(); workspace.clearFailure(); setPane(next); setInput(''); setSelection(null); setConsent(false);
  };
  const submit = () => {
    if (!canSubmit || pane === 'home') return;
    const supplied = selection?.input === input && selection.conversationId === conversationId ? selection : undefined;
    const request: AIRequest = { task: pane, input,
      ...(supplied ? { conversationId: supplied.conversationId } : {}),
      ...(pane === 'rewrite' ? { tone } : {}), ...(pane === 'translate' ? { targetLanguage: language } : {}),
    };
    void workspace.run(request, supplied, consent);
    setConsent(false);
    if (pane === 'chat') { setInput(''); setSelection(null); }
  };
  const modeLabel = provider.mode === 'demo' ? 'Demo · offline' : provider.mode === 'remote' ? 'Connected AI service' : 'Not connected';

  // Keep session state while away without retaining a second, hidden workspace DOM.
  if (!active) return <section id="ai-hub" className="ai-hub" hidden aria-label="AI Hub" />;

  return <section id="ai-hub" className="ai-hub" hidden={!active} aria-labelledby="ai-hub-title">
    <header className="ai-hub-header">
      <div><p className="ai-eyebrow">A LITTLE HELP, A LITTLE POSSIBILITY</p><h1 id="ai-hub-title" ref={headingRef} tabIndex={-1} className="display-heading display-heading--page">AI Hub</h1></div>
      <span className={`ai-provider-badge ${available ? '' : 'is-unavailable'}`}><span aria-hidden="true" />{modeLabel}</span>
    </header>
    <p className="ai-privacy"><LockKeyhole size={14} aria-hidden="true" />Only text you choose to share appears here. AI work stays in this session.</p>
    {!available && <p className="ai-unavailable" role="status">@Secu isn’t connected yet. These tools need an approved AI service before they can process text in this session.</p>}

    {pane === 'home' ? <div className="ai-home">
      <section className="ai-hero" aria-labelledby="secu-intro">
        <div><span className="ai-eyebrow">YOUR WORDS. YOUR PACE.</span><h2 id="secu-intro" className="display-heading">Meet @Secu.</h2>
          <p>A space to shape your next thought.<br />Start a conversation, polish a message, or make room for the main points.</p>
          <Button onClick={() => choose('chat')} leadingIcon={<Sparkles size={18} aria-hidden="true" />} trailingIcon={<ArrowRight size={17} aria-hidden="true" />}>Open @Secu</Button>
          <small>{provider.mode === 'demo' ? 'Prepared examples only. No AI model or remote processing.' : 'You stay in control of what you share.'}</small>
        </div>
        <div className="ai-hero-art" aria-hidden="true"><span className="ai-orbit ai-orbit--one" /><span className="ai-orbit ai-orbit--two" /><span className="ai-hero-bot"><Bot size={64} strokeWidth={1.4} /></span><span className="ai-hero-spark"><Sparkles size={22} /></span><span className="ai-hero-note">a little clarity ✦</span></div>
      </section>
      <section aria-labelledby="ai-tools-title" className="ai-tools-section"><div className="ai-section-title"><h2 id="ai-tools-title" className="display-heading display-heading--section">Make it a little easier</h2><span>Five ways to get started</span></div>
        <div className="ai-tool-grid">{AI_TOOLS.map(tool => { const Icon = toolIcons[tool.task]; return <button className="ai-tool-card" key={tool.task} onClick={() => choose(tool.task)} type="button">
          <span className="ai-tool-icon"><Icon size={22} aria-hidden="true" /></span><h3>{tool.title}</h3><p>{tool.description}</p><ArrowRight className="ai-card-arrow" size={16} aria-hidden="true" />
        </button>; })}</div>
      </section>
      <section className="ai-recents" aria-labelledby="ai-recents-title"><div className="ai-section-title"><h2 id="ai-recents-title" className="display-heading display-heading--section">Recent AI tasks</h2><span>Just this session · current conversation</span></div>
        {!workspace.recent.length ? <div className="ai-recents-empty"><RotateCcw size={20} aria-hidden="true" /><div><strong>A fresh start.</strong><p>Your tasks will appear here after you try @Secu or a tool.</p></div></div> :
          <ul>{workspace.recent.slice(0, 6).map(item => <li key={item.id}><span>{aiTaskTitle(item.request.task)}</span><span className="ai-recent-state">{item.status}</span><Button size="sm" variant="ghost" disabled={!item.result}
            onClick={() => { const selected = workspace.viewResult(item.id); if (!selected) return; setPane(selected.request.task); setInput(selected.request.task === 'chat' ? '' : selected.request.input); setSelection(selected.selection ?? null); if (selected.request.tone) setTone(selected.request.tone); if (selected.request.targetLanguage) setLanguage(selected.request.targetLanguage); }}>View {aiTaskTitle(item.request.task)}</Button></li>)}</ul>}
      </section>
    </div> : <div className={`ai-workspace ${pane === 'chat' ? 'ai-workspace--chat' : ''}`}>
      <div className="ai-workspace-heading"><Button size="sm" variant="ghost" leadingIcon={<ArrowLeft size={15} aria-hidden="true" />} onClick={() => choose('home')}>AI Hub</Button>
        <h2 className="display-heading display-heading--section">{pane === 'chat' ? '@Secu assistant' : aiTaskTitle(pane)}</h2>
        {pane === 'chat' && <Button size="sm" variant="ghost" leadingIcon={<RotateCcw size={14} aria-hidden="true" />} onClick={() => { workspace.resetChat(); setInput(''); setSelection(null); }}>Reset chat</Button>}
      </div>
      {pane === 'chat' && <AIChatHistory messages={workspace.messages} loading={busy} mode={provider.mode} />}
      {pane === 'chat' && !workspace.messages.length && <div className="ai-starters">{['What can @Secu do?', 'How is my text used?'].map(prompt => <Button key={prompt} variant="outline" size="sm" disabled={!available} onClick={() => { setInput(prompt); setSelection(null); inputRef.current?.focus(); }}>{prompt}</Button>)}</div>}
      <form className="ai-form" onSubmit={event => { event.preventDefault(); submit(); }}>
        {selection && <div className="ai-source"><LockKeyhole size={14} aria-hidden="true" /><span>{selection.kind === 'draft' ? 'Your chosen draft' : 'Your selected message'} · review the text below before continuing</span><Button size="sm" variant="ghost" aria-label="Clear shared text" disabled={busy} onClick={() => { setSelection(null); setInput(''); }}><X size={14} aria-hidden="true" /></Button></div>}
        <div className="ai-form-label"><label htmlFor="ai-input">{pane === 'chat' ? 'Message @Secu' : 'Text to work with'}</label><span>{input.length.toLocaleString('en-US')} / {AI_MAX_INPUT.toLocaleString('en-US')}</span></div>
        <textarea ref={inputRef} id="ai-input" className="ai-input" rows={pane === 'chat' ? 2 : 5} value={input} disabled={!available || busy} maxLength={AI_MAX_INPUT}
          placeholder={pane === 'chat' ? 'What would you like to explore?' : 'Paste or type only the text you want to share…'} aria-describedby="ai-demo-note"
          onChange={event => { setInput(event.target.value); setConsent(false); workspace.clearFailure(); }}
          onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} />
        {pane === 'rewrite' && <label className="ai-option">Tone<select aria-label="Rewrite tone" value={tone} disabled={busy || !available} onChange={event => { setTone(event.target.value as typeof tone); workspace.clearFailure(); }}>{AI_TONES.map(value => <option key={value}>{value}</option>)}</select></label>}
        {pane === 'translate' && <label className="ai-option">Target language<select aria-label="Target language" value={language} disabled={busy || !available} onChange={event => { setLanguage(event.target.value as typeof language); workspace.clearFailure(); }}>{AI_LANGUAGES.map(value => <option key={value}>{value}</option>)}</select></label>}
        <p id="ai-demo-note" className="ai-demo-note">{provider.mode === 'demo' ? 'Demo: prepared examples, not model-generated answers. Other text gets an honest limitation notice.' : 'Review your text before submitting. AI results need your review.'}</p>
        {provider.mode === 'remote' && provider.disclosure && <p id="ai-remote-disclosure" className="ai-demo-note">{provider.disclosure}</p>}
        {provider.mode === 'remote' && <label className="ai-consent"><input type="checkbox" checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)}
          {...(provider.disclosure ? { 'aria-describedby': 'ai-remote-disclosure' } : {})} />Allow this text to be processed by the connected AI service for this request.</label>}
        <div className="ai-form-actions">
          {currentTool && <Button variant="outline" disabled={busy || !available} onClick={() => { setInput(currentTool.example); setSelection(null); setConsent(false); workspace.clearFailure(); inputRef.current?.focus(); }}>Try an example</Button>}
          {busy ? <Button variant="outline" onClick={cancel}>Cancel request</Button> : <Button type="submit" disabled={!canSubmit} leadingIcon={<Sparkles size={16} aria-hidden="true" />} aria-label={pane === 'chat' ? 'Send to @Secu' : `Run ${aiTaskTitle(pane)}`}>{pane === 'chat' ? 'Send' : aiTaskTitle(pane)}</Button>}
        </div>
      </form>
      {workspace.failure?.task === pane && <div className="ai-error" role="alert"><p>{workspace.failure.error.message}</p>{workspace.failure.canRetry && <Button variant="outline" size="sm" disabled={provider.mode === 'remote' && !consent} onClick={() => { void workspace.retry(consent); setConsent(false); }}>Retry request</Button>}</div>}
      {busy && pane !== 'chat' && <p className="ai-progress" role="status">{provider.mode === 'demo' ? 'Preparing your demo example…' : 'Waiting for the AI service…'}</p>}
      {!busy && pane !== 'chat' && !workspace.result && !workspace.failure && <p className="ai-progress" role="status">{workspace.recent[0]?.status === 'cancelled' && workspace.recent[0]?.request.task === pane ? 'Request cancelled. Your text is still here.' : 'Your result will appear here. Review your text or try a prepared example.'}</p>}
      {pane !== 'chat' && workspace.result?.request.task === pane && <OutputPanel result={workspace.result} onReviewDraft={onReviewDraft} />}
    </div>}
  </section>;
}
