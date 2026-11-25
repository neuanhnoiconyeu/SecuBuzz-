import {act,renderHook} from '@testing-library/react';
import type {SessionApi} from '@/api/sessionApi';
import {useRoomCatalog} from '../useRoomCatalog';

afterEach(()=>jest.useRealTimers());
test('refresh after a mutation cannot be consumed by a stale in-flight poll; errors retain the last valid catalog',async()=>{
 jest.useFakeTimers();let finish!:(value:unknown)=>void;
 const room={id:'room-12345678-1234-1234-1234-123456789abc',name:'Room',description:'Shared',ownerId:'alice',ownerName:'Alice'};
 const request=jest.fn().mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;})).mockResolvedValue({items:[room]});
 const api={actor:{id:'alice',username:'alice'},request,dispose:jest.fn()} satisfies SessionApi;
 const view=renderHook(()=>useRoomCatalog(api));
 await act(async()=>{const fresh=view.result.current.refresh();finish({items:[]});await fresh;});
 expect(request).toHaveBeenCalledTimes(2);expect(view.result.current.rooms).toEqual([room]);
 request.mockRejectedValue(new Error('network'));
 await act(async()=>{jest.advanceTimersByTime(3000);await Promise.resolve();});
 expect(view.result.current.rooms).toEqual([room]);expect(view.result.current.error).toBeTruthy();
 view.unmount();const calls=request.mock.calls.length;
 act(()=>jest.advanceTimersByTime(9000));expect(request).toHaveBeenCalledTimes(calls);
});
