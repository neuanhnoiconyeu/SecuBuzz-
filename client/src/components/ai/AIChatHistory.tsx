import { useEffect, useRef, useState } from 'react';
import { ArrowDown, Bot } from 'lucide-react';
import { Button } from '@/components/ui';
import type { AIChatMessage } from '@/ai/useAIWorkspace';
import type { AIProvider } from '@/ai/aiModel';

export function AIChatHistory({ messages, loading, mode = 'demo' }: { messages: AIChatMessage[]; loading: boolean; mode?: AIProvider['mode'] }) {
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const [unseen, setUnseen] = useState(false);
  useEffect(() => {
    if (!messages.length) { nearBottom.current = true; setUnseen(false); if (viewport.current) viewport.current.scrollTop = 0; return; }
    if (nearBottom.current && viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    else if (messages.length) setUnseen(true);
  }, [messages.length, loading]);
  return <div className="ai-history-wrap">
    <div className="ai-chat-history" ref={viewport} role="log" aria-label="@Secu messages" aria-live="polite" tabIndex={0}
      onScroll={() => {
        const node = viewport.current;
        if (!node) return;
        nearBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64;
        if (nearBottom.current) setUnseen(false);
      }}>
      {!messages.length && <div className="ai-chat-welcome">
        <span className="ai-assistant-mark"><Bot size={32} aria-hidden="true" /></span>
        <h3 className="display-heading display-heading--section">Hi, I’m @Secu.</h3>
        <p>{mode === 'demo' ? 'This is a prepared demo, not a live AI model. Try a starter question or explore a tool.' : mode === 'unavailable' ? '@Secu is not connected yet. Text processing is unavailable in this session.' : 'Only text you submit with permission will be shared with the connected AI service.'}</p>
      </div>}
      {messages.map(message => <article key={message.id} className={`ai-message ai-message--${message.role}`}>
        <span className="ai-message-author">{message.role === 'user' ? 'You' : '@Secu'}
          {message.role === 'assistant' && <span className="ai-mini-label">{mode === 'demo' ? `Demo ${message.kind === 'limitation' ? 'limitation' : 'example'}` : message.kind === 'limitation' ? 'Service notice' : 'AI response'}</span>}</span>
        <p>{message.text}</p>
        {message.role === 'user' && message.status !== 'completed' && <small>{message.status === 'pending' ? mode === 'demo' ? 'Waiting for demo' : 'Waiting for response' : message.status === 'cancelled' ? 'Cancelled' : 'Not completed'}</small>}
      </article>)}
      {loading && <p className="ai-progress" role="status">{mode === 'demo' ? 'Preparing a demo response…' : 'Waiting for a response…'}</p>}
    </div>
    {unseen && <Button className="ai-jump" size="sm" variant="secondary" leadingIcon={<ArrowDown size={14} aria-hidden="true" />}
      onClick={() => { if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight; nearBottom.current = true; setUnseen(false); }}>
      Jump to latest
    </Button>}
  </div>;
}
