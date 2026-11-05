'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import YahooChatWindow from '@/components/YahooChatWindow';
import { ConversationSidebar } from '@/components/messenger/ConversationSidebar';
import { MainNavigation } from '@/components/messenger/MainNavigation';
import type { MessengerSection } from '@/components/messenger/MainNavigation';
import { Surface } from '@/components/ui';
import { useMessengerConversations } from '@/hooks/useMessengerConversations';
import type { ConversationMessageActivity } from '@/conversations/conversationModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';

export default function Home() {
  const {
    activeConversation,
    activeConversationId,
    conversations,
    drafts,
    isEmpty,
    recordMessageActivity,
    selectConversation,
    setDraft,
  } = useMessengerConversations();
  const [activeSection, setActiveSection] = useState<MessengerSection>('chats');
  const [mobileListOpen, setMobileListOpen] = useState(false);
  const [securityStatus, setSecurityStatus] = useState<ConversationSecurityStatus | null>(null);
  const [lastBuzz, setLastBuzz] = useState<string>('');
  const [messageLog, setMessageLog] = useState<string[]>([]);
  const conversationIds = useMemo(() => conversations.map((conversation) => conversation.id), [conversations]);

  useEffect(() => {
    if (mobileListOpen && window.innerWidth <= 680) {
      document.querySelector<HTMLButtonElement>('.conversation-sidebar .conversation-list-item')?.focus();
    }
  }, [mobileListOpen]);

  const handleBuzz = useCallback(() => {
    setLastBuzz(`BUZZ triggered at ${new Date().toLocaleTimeString()}`);
  }, []);

  const handleSendMessage = useCallback(() => {
    setMessageLog((previous) => [
      ...previous,
      `[${new Date().toLocaleTimeString()}] Encrypted message accepted by local demo`,
    ]);
  }, []);

  const handleActivity = useCallback((activity: ConversationMessageActivity) => {
    recordMessageActivity(activity);
  }, [recordMessageActivity]);

  const handleSecurityStatusChange = useCallback((status: ConversationSecurityStatus | null) => {
    setSecurityStatus(status);
  }, []);

  const handleSelectConversation = (conversationId: string) => {
    setActiveSection('chats');
    selectConversation(conversationId);
    setMobileListOpen(false);
  };

  const showConversationsOnMobile = () => setMobileListOpen(true);

  return (
    <main className="app-shell">
      <div className="messenger-app">
        <MainNavigation
          activeSection={activeSection}
          onSelect={setActiveSection}
        />

        <section id="chats" className="messenger-chat-section" hidden={activeSection !== 'chats'} aria-label="Chats">
          <ConversationSidebar
            conversations={conversations}
            activeConversationId={activeConversationId}
            mobileListOpen={mobileListOpen}
            onSelect={handleSelectConversation}
          />

          <div className="messenger-main-column">
            {isEmpty ? (
              <section className="messenger-empty-state" role="status">
                <span className="messenger-empty-mark" aria-hidden="true">Y!</span>
                <h1>No conversations available</h1>
                <p>Local demo conversations will appear here when available.</p>
              </section>
            ) : activeConversation ? (
              <>
                <YahooChatWindow
                  conversationId={activeConversation.id}
                  contactName={activeConversation.displayName}
                  conversationType={activeConversation.type}
                  {...(activeConversation.avatarUrl ? { avatarUrl: activeConversation.avatarUrl } : {})}
                  {...(activeConversation.presence ? { presenceStatus: activeConversation.presence } : {})}
                  showPresence={Boolean(activeConversation.presence)}
                  conversationIds={conversationIds}
                  draftValue={drafts[activeConversation.id] ?? ''}
                  onDraftChange={(draft) => setDraft(activeConversation.id, draft)}
                  onMessageActivity={handleActivity}
                  onSecurityStatusChange={handleSecurityStatusChange}
                  onBackToConversations={showConversationsOnMobile}
                  onBuzz={handleBuzz}
                  onSendMessage={handleSendMessage}
                />

                <Surface
                  variant="retro"
                  className="debug-console"
                  role="region"
                  aria-label="System log"
                  aria-live="polite"
                >
                  <p className="retro-label">SYSTEM LOG</p>
                  <div className="debug-log">
                    <div>&gt; LOCAL DEMO TRANSPORT READY</div>
                    {lastBuzz && <div className="debug-alert">&gt; {lastBuzz}</div>}
                    {messageLog.slice(-3).map((log, index) => (
                      <div key={`${log}-${index}`} className="debug-entry">&gt; {log}</div>
                    ))}
                  </div>
                </Surface>
              </>
            ) : (
              <section className="messenger-empty-state" role="status">
                <span className="messenger-empty-mark" aria-hidden="true">Y!</span>
                <h1>Choose a conversation</h1>
                <p>Select one of the local demo conversations to open its chat.</p>
              </section>
            )}
          </div>
        </section>

        <section className="messenger-security-section" hidden={activeSection !== 'security'} aria-labelledby="security-page-title">
          <div className="security-page-heading">
            <p className="conversation-sidebar-eyebrow">LOCAL CLIENT STATUS</p>
            <h1 id="security-page-title">Security</h1>
            <p>Security details for the current browser demo.</p>
          </div>
          <Surface className="security-status-panel">
            <h2>{activeConversation?.displayName ?? 'No active conversation'}</h2>
            <dl>
              <div><dt>Browser cryptography</dt><dd>{securityStatus?.browserCryptoAvailable ? 'Available' : securityStatus ? 'Unavailable' : 'Preparing'}</dd></div>
              <div><dt>Local conversation encryption</dt><dd>{securityStatus?.localEncryptionAvailable ? 'Available' : securityStatus ? 'Unavailable' : 'Preparing'}</dd></div>
              <div><dt>Recipient key</dt><dd>{securityStatus?.recipientKeyAvailable ? 'Available' : 'Unavailable'}</dd></div>
              <div><dt>Authenticated key exchange</dt><dd>{securityStatus?.authenticatedKeyExchangeEstablished ? 'Established' : 'Not established'}</dd></div>
              <div><dt>Multi-user E2EE</dt><dd>Not established</dd></div>
            </dl>
            <p className="security-demo-limitation">
              Demo conversations are local UI examples. Their keys are held in this page&apos;s memory and are not shared with another user.
            </p>
          </Surface>
        </section>
      </div>
    </main>
  );
}
