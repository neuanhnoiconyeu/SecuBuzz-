import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MessageList} from '../MessageList';
import {REAL_ACCOUNT_MESSAGING_CAPABILITIES} from '@/messaging/messagingCapabilities';
import type {ChatMessage} from '@/messaging/messageModel';
const message:ChatMessage={id:'wire',conversationId:'chat',senderId:'alice',senderName:'Alice',timestamp:'2026-11-22T00:00:00.000Z',type:'text',content:'First line\n👩🏽‍💻 second line',deliveryStatus:'sent'};
test('per-message edit eligibility narrows a supported capability without exposing received/media actions',()=>{
 render(<MessageList messages={[message]} currentUserId="alice" capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES} onRetryMessage={jest.fn()} onEditMessage={jest.fn()} isEditEligible={()=>false}/>);
 fireEvent.contextMenu(screen.getByText(/First line/));expect(screen.queryByRole('menuitem',{name:'Edit'})).not.toBeInTheDocument();
});
test('the authenticated editor preserves multiline content and a failed draft with accurate uncertainty feedback',async()=>{
 const save=jest.fn().mockRejectedValue(new Error('Lost response'));
 render(<MessageList messages={[message]} currentUserId="alice" capabilities={REAL_ACCOUNT_MESSAGING_CAPABILITIES} onRetryMessage={jest.fn()} onEditMessage={save}
  isEditEligible={()=>true} editFailureMessage="Your edit could not be confirmed. Retry or refresh."/>);
 fireEvent.click(screen.getByRole('button',{name:'More actions'}));fireEvent.click(screen.getByRole('menuitem',{name:'Edit'}));
 const editor=screen.getByRole('textbox',{name:'Edit message'});expect(editor).toHaveValue(message.content);
 fireEvent.change(editor,{target:{value:'Changed\n🇻🇳'}});fireEvent.click(screen.getByRole('button',{name:'Save edit'}));
 await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('could not be confirmed'));
 expect(editor).toHaveValue('Changed\n🇻🇳');expect(save).toHaveBeenCalledWith(message.id,'Changed\n🇻🇳');
 fireEvent.click(screen.getByRole('button',{name:'Cancel edit'}));expect(screen.queryByRole('textbox',{name:'Edit message'})).not.toBeInTheDocument();
 expect(screen.getByText(/First line/)).toBeInTheDocument();
});
