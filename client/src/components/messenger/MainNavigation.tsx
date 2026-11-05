import { MessageCircle, ShieldCheck } from 'lucide-react';

export type MessengerSection = 'chats' | 'security';

export interface MainNavigationProps {
  activeSection: MessengerSection;
  onSelect(section: MessengerSection): void;
}

export function MainNavigation({ activeSection, onSelect }: MainNavigationProps) {
  return (
    <nav className="messenger-navigation" aria-label="Main navigation">
      <a className="messenger-navigation-brand" href="#chats" aria-label="Yahoo Security Messenger home">
        Y!
      </a>
      <button
        type="button"
        className={`messenger-navigation-item ${activeSection === 'chats' ? 'is-active' : ''}`}
        aria-current={activeSection === 'chats' ? 'page' : undefined}
        onClick={() => onSelect('chats')}
      >
        <MessageCircle size={19} aria-hidden="true" />
        <span>Chats</span>
      </button>
      <button
        type="button"
        className={`messenger-navigation-item ${activeSection === 'security' ? 'is-active' : ''}`}
        aria-current={activeSection === 'security' ? 'page' : undefined}
        onClick={() => onSelect('security')}
      >
        <ShieldCheck size={19} aria-hidden="true" />
        <span>Security</span>
      </button>
      <p className="messenger-navigation-caption">LOCAL<br />DEMO</p>
    </nav>
  );
}
