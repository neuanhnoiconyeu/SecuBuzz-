import {render,screen} from '@testing-library/react';
import {DirectCallsRuntime,useDirectCalls} from '@/components/calls/DirectCallsRuntime';
import {useLiveKitConnection} from '@/voice/useLiveKitConnection';
import {CallTestBroker,alice} from '@/test-support/directCallFixture';
import type {SessionApi} from '@/api/sessionApi';

jest.mock('@/voice/useLiveKitConnection',()=>({useLiveKitConnection:jest.fn(()=>({service:null}))}));
function Controls(){const calls=useDirectCalls();return <button disabled={!calls?.canStart}>Place call</button>;}
test('the workspace capability gate prevents signaling, incoming subscriptions and device access',()=>{
  const client=new CallTestBroker().client(alice),api={actor:alice,request:jest.fn(),dispose:jest.fn()} as unknown as SessionApi;
  const {unmount}=render(<DirectCallsRuntime client={client} user={alice} sessionApi={api} enabled={false}><Controls/></DirectCallsRuntime>);
  expect(screen.getByRole('button',{name:'Place call'})).toBeDisabled();expect(client.calls.request).not.toHaveBeenCalled();
  expect(client.callListeners.size).toBe(0);expect(client.listeners.size).toBe(0);
  expect(useLiveKitConnection).toHaveBeenCalledWith('direct-call',expect.any(Function),api,false);
  unmount();expect(api.request).not.toHaveBeenCalled();
});
