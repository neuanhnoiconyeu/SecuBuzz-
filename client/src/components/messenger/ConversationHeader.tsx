import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type Ref } from 'react';
import { ChevronLeft, Palette, Shield, ShieldAlert, ShieldCheck, ShieldX, X } from 'lucide-react';
import { Avatar, Badge, Button } from '@/components/ui';
import { useAnchoredMessagePopover } from '@/hooks/useAnchoredMessagePopover';
import type { ConnectionStatus, PresenceStatus, TransportMode } from '@/messaging/messageModel';
import type { ConversationSecurityStatus } from '@/security/keyManagement';
import type { ConversationType } from '@/conversations/conversationModel';
import type { DirectCallKind } from '@/calls/directCallMachine';
import type { DirectCallPeer } from '@/calls/directCallMachine';
import { DirectCallActions } from '@/components/calls/DirectCallActions';
import { CONVERSATION_THEMES, type ConversationThemeId } from '../../../../shared/conversationThemes';

export type { ConversationType } from '@/conversations/conversationModel';

export interface ConversationCustomizationProps {
  themeId: ConversationThemeId;
  participants: readonly { id: string; displayName: string; username: string; nickname?: string }[];
  canEdit: boolean;
  saving?: boolean;
  error?: string | null;
  onChangeTheme(themeId: ConversationThemeId): void;
  onSaveNicknames(nicknames: Record<string, string | null>): Promise<boolean>;
}

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
  onStartCall?(kind: DirectCallKind): void;
  callDisabled?: boolean;
  callTarget?: { conversationId: string; peer: DirectCallPeer };
  showCalls?: boolean;
  active?: boolean;
  securePresentation?: { ready: boolean; label: string; details: ReactNode; state?: 'verified' | 'unverified' | 'warning' | 'error' };
  customization?: ConversationCustomizationProps;
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
  onStartCall,
  callDisabled = false,
  callTarget,
  showCalls = true,
  active = true,
  securePresentation,
  customization,
}: ConversationHeaderProps) {
  const [securityOpen, setSecurityOpen] = useState(false);
  const securityTrigger = useRef<HTMLButtonElement>(null);
  const securityPanel = useRef<HTMLDivElement>(null);
  const securityId = useId();
  const closeSecurity = useCallback((restoreFocus = false) => {
    setSecurityOpen(false);
    if (restoreFocus) securityTrigger.current?.focus({ preventScroll: true });
  }, []);
  useAnchoredMessagePopover(securityPanel, securityTrigger, securityOpen && active ? 'conversation-security' : null, closeSecurity, true);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsTrigger = useRef<HTMLButtonElement>(null);
  const settingsPanel = useRef<HTMLDivElement>(null);
  const settingsId = useId();
  const [nicknameDrafts, setNicknameDrafts] = useState<Record<string, string>>({});
  const closeSettings = useCallback((restoreFocus = false) => {
    setSettingsOpen(false);
    if (restoreFocus) settingsTrigger.current?.focus({ preventScroll: true });
  }, []);
  useAnchoredMessagePopover(settingsPanel, settingsTrigger, settingsOpen && active ? 'conversation-settings' : null, closeSettings, true);
  useEffect(() => {
    if (!active) { closeSecurity(); closeSettings(); }
    else if (securityOpen) securityPanel.current?.focus({ preventScroll: true });
    else if (settingsOpen) settingsPanel.current?.focus({ preventScroll: true });
  }, [active, securityOpen, settingsOpen, closeSecurity, closeSettings]);
  useEffect(() => {
    if (!settingsOpen || !customization) return;
    setNicknameDrafts(Object.fromEntries(customization.participants.map(p => [p.id, p.nickname ?? ''])));
  }, [settingsOpen, customization]);
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
  // The caller supplies security warnings explicitly; labels never establish verification.
  const localEncryptionUnavailable = securityStatus && (!securityStatus.browserCryptoAvailable || !securityStatus.localEncryptionAvailable);
  const securityState = localEncryptionUnavailable || securePresentation?.state === 'error' ? 'error'
    : securePresentation?.state === 'warning' ? 'warning'
      : transportMode === 'realtime' && securePresentation?.ready && securePresentation.state === 'verified'
        && (!securityStatus || (securityStatus.recipientKeyAvailable && securityStatus.authenticatedKeyExchangeEstablished)) ? 'verified' : 'unverified';
  const SecurityIcon = securityState === 'verified' ? ShieldCheck : securityState === 'warning' ? ShieldAlert : securityState === 'error' ? ShieldX : Shield;
  const securityLabel = localEncryptionUnavailable ? primarySecurityLabel : securePresentation?.label ?? primarySecurityLabel;
  const securityLimitation = securePresentation ? securePresentation.ready && !localEncryptionUnavailable ? 'Conversation keys checked' : 'Sending is locked' : 'E2EE not established';
  const securityActionLabel = `Security details: ${securityState === 'verified' ? 'Conversation keys checked' : securityState === 'warning' ? 'Security warning' : securityState === 'error' ? 'Security error' : 'Verification incomplete'}. ${securityLabel}`;
  const transportLabel = connectionStatus === 'connected'
      ? 'Connected'
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : connectionStatus === 'reconnecting'
          ? 'Reconnecting…'
          : 'Offline';
  const showConnectionLabel = type !== 'direct' || connectionStatus !== 'connected';

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
          <p className={`chat-contact-eyebrow${type === 'direct' ? ' sr-only' : ''}`}>{conversationTypeLabel[type]}</p>
          <h1 ref={headingRef} tabIndex={-1} title={name} className="chat-title-heading contact-name display-heading display-heading--conversation"><span className="sr-only">Chat with </span>{name}</h1>
          <div className="contact-details">
            {presence && <Badge status={presence} announce={Boolean(securePresentation)} aria-label={securePresentation ? 'Contact presence' : undefined}>{presenceLabel[presence]}</Badge>}
            {(showConnectionLabel || transportMode === 'local-demo') && <span className={`conversation-connection ${connectionStatus === 'connected' ? 'is-connected' : ''}`}>
              <span className="conversation-connection-dot" aria-hidden="true" />
              {transportMode === 'local-demo' && <><span>Local demo</span>{showConnectionLabel && <span aria-hidden="true"> · </span>}</>}
              {showConnectionLabel && <span>{transportLabel}</span>}
            </span>}
          </div>
        </div>
      </div>

      <div className="chat-header-actions">
        {showCalls && type === 'direct' && <DirectCallActions name={name} disabled={callDisabled}
          {...(callTarget ? { target: callTarget } : {})} {...(onStartCall ? { onPreviewCall: onStartCall } : {})} />}
        {customization && (
          <div className="conversation-security-details conversation-settings-wrap">
            <Button ref={settingsTrigger} variant="ghost" className="conversation-security-summary conversation-settings-trigger"
              aria-label="Conversation settings" title="Customize chat theme and nicknames" aria-haspopup="dialog"
              aria-expanded={settingsOpen && active} aria-controls={settingsId}
              onClick={() => settingsOpen ? closeSettings(true) : setSettingsOpen(true)}>
              <Palette size={20} aria-hidden="true" />
            </Button>
            <div ref={settingsPanel} id={settingsId} hidden={!settingsOpen || !active}
              className="conversation-security-panel conversation-settings-panel"
              role="dialog" aria-modal="false" aria-labelledby={`${settingsId}-title`} tabIndex={-1}>
              <div className="conversation-security-panel-heading">
                <h2 id={`${settingsId}-title`}>Conversation settings</h2>
                <Button variant="ghost" aria-label="Close conversation settings" onClick={() => closeSettings(true)}><X size={18} aria-hidden="true" /></Button>
              </div>
              {!customization.canEdit && <p className="conversation-security-note">Renew friendship to customize this conversation&apos;s theme or nicknames.</p>}
              {customization.error && <p role="alert" className="conversation-settings-error">{customization.error}</p>}
              <div className="conversation-theme-section" role="group" aria-label="Chat theme">
                <p className="conversation-settings-heading">Chat theme &amp; quick emoji</p>
                <div className="conversation-theme-grid">
                  {CONVERSATION_THEMES.map(theme => (
                    <button key={theme.id} type="button"
                      className={`conversation-theme-option ${customization.themeId === theme.id ? 'is-selected' : ''}`}
                      data-theme-choice={theme.id}
                      aria-pressed={customization.themeId === theme.id}
                      disabled={!customization.canEdit || Boolean(customization.saving)}
                      onClick={() => customization.onChangeTheme(theme.id)}>
                      <span className={`conversation-theme-swatch conversation-theme-swatch--${theme.id}`} aria-hidden="true" />
                      <span>{theme.label}</span>
                      <span aria-hidden="true">{theme.quickEmoji}</span>
                    </button>
                  ))}
                </div>
              </div>
              <form className="conversation-nicknames-form" aria-label="Conversation nicknames" onSubmit={event => {
                event.preventDefault();
                const next: Record<string, string | null> = {};
                for (const participant of customization.participants) {
                  const trimmed = (nicknameDrafts[participant.id] ?? '').trim();
                  next[participant.id] = trimmed ? trimmed : null;
                }
                void customization.onSaveNicknames(next);
              }}>
                <p className="conversation-settings-heading">Nicknames</p>
                {customization.participants.map(participant => (
                  <div key={participant.id} className="conversation-nickname-row">
                    <label htmlFor={`${settingsId}-nick-${participant.id}`}>
                      {participant.displayName} <small>(@{participant.username})</small>
                    </label>
                    <div className="conversation-nickname-input-row">
                      <input id={`${settingsId}-nick-${participant.id}`} type="text" maxLength={40}
                        placeholder={participant.displayName}
                        value={nicknameDrafts[participant.id] ?? ''}
                        disabled={!customization.canEdit || Boolean(customization.saving)}
                        onChange={event => setNicknameDrafts(prev => ({ ...prev, [participant.id]: event.target.value }))} />
                      {(nicknameDrafts[participant.id] ?? '').trim() && (
                        <Button type="button" size="sm" variant="ghost"
                          aria-label={`Clear nickname for ${participant.displayName}`}
                          disabled={!customization.canEdit || Boolean(customization.saving)}
                          onClick={() => setNicknameDrafts(prev => ({ ...prev, [participant.id]: '' }))}>
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                ))}
                <Button type="submit" size="sm" disabled={!customization.canEdit || Boolean(customization.saving)} loading={Boolean(customization.saving)}>
                  Save nicknames
                </Button>
              </form>
            </div>
          </div>
        )}
        <div className="conversation-security-details">
          <Button ref={securityTrigger} variant="ghost" className="conversation-security-summary"
            aria-label={securityActionLabel} title={securityActionLabel} aria-haspopup="dialog" data-security-state={securityState}
            aria-expanded={securityOpen && active} aria-controls={securityId} aria-describedby={`${securityId}-status`}
            onClick={() => securityOpen ? closeSecurity(true) : setSecurityOpen(true)}>
            <SecurityIcon size={20} aria-hidden="true" />
          </Button>
          <div ref={securityPanel} id={securityId} hidden={!securityOpen || !active} className="conversation-security-panel"
            role="dialog" aria-modal="false" aria-labelledby={`${securityId}-title`} tabIndex={-1}>
            <div className="conversation-security-panel-heading">
              <h2 id={`${securityId}-title`}>Conversation security details</h2>
              <Button variant="ghost" aria-label="Close security details" onClick={() => closeSecurity(true)}><X size={18} aria-hidden="true" /></Button>
            </div>
            <div id={`${securityId}-status`} className="conversation-security-copy">
              <strong className="conversation-security-primary">{securityLabel}</strong>
              <span className="conversation-security-limitation">{securityLimitation}</span>
            </div>
            {securePresentation ? securePresentation.details : <><div className="conversation-security-facts" aria-label="Encryption status">
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
            </>}
          </div>
        </div>
      </div>
    </div>
  );
}
