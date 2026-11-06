import type { Ref } from 'react';
import { ChevronDown, ChevronLeft, LockKeyhole } from 'lucide-react';
import { Avatar, Badge } from '@/components/ui';
import type { ConnectionStatus, PresenceStatus, TransportMode } from '@/messaging/messageModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';
import type { ConversationType } from '@/conversations/conversationModel';

export type { ConversationType } from '@/conversations/conversationModel';

export interface ConversationHeaderProps {
  name: string;
  avatarUrl?: string;
  type: ConversationType;
  presence?: PresenceStatus;
  securityStatus: ConversationSecurityStatus | null;
  connectionStatus: ConnectionStatus;
  transportMode: TransportMode;
  headingRef?: Ref<HTMLHeadingElement>;
  /** Only the identity group transitions; message history and disclosures remain mounted. */
  transitionKey?: string;
  onBackToConversations?: () => void;
}

const presenceLabel: Record<PresenceStatus, string> = {
  online: 'Online',
  offline: 'Offline',
  busy: 'Busy',
  away: 'Away',
};

const conversationTypeLabel: Record<ConversationType, string> = {
  bot: 'SecureBot chat',
  direct: 'Direct chat',
  group: 'Group conversation',
};

export function ConversationHeader({
  avatarUrl,
  connectionStatus,
  securityStatus,
  name,
  presence,
  transportMode,
  type,
  headingRef,
  transitionKey,
  onBackToConversations,
}: ConversationHeaderProps) {
  const localEncryptionLabel = !securityStatus
    ? 'Preparing local encryption'
    : securityStatus.localEncryptionAvailable
      ? 'Local AES-256-GCM available'
      : 'Browser encryption unavailable';
  const primarySecurityLabel = !securityStatus
    ? 'Preparing encryption'
    : securityStatus.localEncryptionAvailable
      ? 'Local encryption only'
      : 'Encryption unavailable';
  const transportLabel = transportMode === 'local-demo'
    ? 'Local demo'
    : connectionStatus === 'connected'
      ? 'Connected'
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : connectionStatus === 'failed'
          ? 'Connection failed'
          : 'Disconnected';

  return (
    <div className="chat-toolbar">
      <div className="contact-presence" key={transitionKey}>
        {onBackToConversations && (
          <button type="button" className="mobile-chat-back" onClick={onBackToConversations} aria-label="Back to conversations">
            <ChevronLeft size={21} aria-hidden="true" />
          </button>
        )}
        <Avatar name={name} {...(avatarUrl ? { src: avatarUrl } : {})} {...(presence ? { status: presence } : {})} size="md" />
        <div className="contact-copy">
          <p className="chat-contact-eyebrow">{conversationTypeLabel[type]}</p>
          <h1 ref={headingRef} tabIndex={-1} className="chat-title-heading contact-name display-heading display-heading--conversation"><span className="sr-only">Chat with </span>{name}</h1>
          <div className="contact-details">
            {presence && <Badge status={presence}>{presenceLabel[presence]}</Badge>}
            <span className={`conversation-connection ${connectionStatus === 'connected' ? 'is-connected' : ''}`}>
              <span className="conversation-connection-dot" aria-hidden="true" />{transportLabel}
            </span>
          </div>
        </div>
      </div>

      <div className="chat-header-actions">
        <details className="conversation-security-details">
          <summary className="conversation-security-summary">
            <LockKeyhole size={15} aria-hidden="true" />
            <span className="conversation-security-copy">
              <span className="conversation-security-primary">
                <span>{primarySecurityLabel}</span>
                <span className="conversation-security-toggle">Security details</span>
              </span>
              <span className="conversation-security-limitation">E2EE not established</span>
            </span>
            <ChevronDown className="conversation-security-chevron" size={15} aria-hidden="true" />
          </summary>
          <div className="conversation-security-panel" role="region" aria-label="Conversation security details" tabIndex={0}>
            <div className="conversation-security-facts" aria-label="Encryption status">
              <Badge status={securityStatus?.localEncryptionAvailable ? 'success' : 'warning'}>
                {localEncryptionLabel}
              </Badge>
              <Badge status="warning">Recipient key unavailable</Badge>
              <Badge status="warning">Authenticated key exchange unavailable</Badge>
            </div>
            <p className="conversation-security-note">
              Messages use a non-extractable key held in this page&apos;s memory. Recipient key exchange is unavailable, so remote end-to-end encryption is not established.
            </p>
            {transportMode === 'local-demo' && (
              <p className="conversation-security-note">
                Local demo replies are mock text. No other user receives messages in these demo conversations.
              </p>
            )}
          </div>
        </details>
      </div>
    </div>
  );
}
