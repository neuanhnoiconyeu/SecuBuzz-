import { Info, LockKeyhole } from 'lucide-react';
import { Avatar, Badge, Tooltip } from '@/components/ui';
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
}: ConversationHeaderProps) {
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
      <div className="contact-presence">
          <Avatar name={name} {...(avatarUrl ? { src: avatarUrl } : {})} {...(presence ? { status: presence } : {})} size="md" />
        <div className="contact-copy">
          <span className="contact-name">{name}</span>
          <div className="contact-details">
            {presence && <Badge status={presence}>{presenceLabel[presence]}</Badge>}
            <span className="conversation-type">{conversationTypeLabel[type]}</span>
          </div>
        </div>
      </div>

      <div className="chat-header-actions">
        <div className="chat-security-status" aria-label="Encryption status">
          <LockKeyhole size={15} aria-hidden="true" />
          <Badge status={securityStatus?.localEncryptionAvailable ? 'success' : 'warning'}>
            {!securityStatus
              ? 'Preparing local encryption'
              : securityStatus.localEncryptionAvailable
                ? 'Local AES-256-GCM available'
                : 'Browser encryption unavailable'}
          </Badge>
          <Badge status="warning">Recipient key unavailable</Badge>
          <Badge status="warning">E2EE not established</Badge>
        </div>
        <Badge status={transportMode === 'local-demo' ? 'info' : connectionStatus === 'connected' ? 'success' : 'warning'}>
          {transportLabel}
        </Badge>
        <Tooltip
          label="Conversation information"
          content="Messages use a non-extractable key held in this page's memory. Recipient key exchange is unavailable, so remote end-to-end encryption is not established. Local demo replies are mock text."
        >
          <Info size={16} aria-hidden="true" />
        </Tooltip>
      </div>
    </div>
  );
}
