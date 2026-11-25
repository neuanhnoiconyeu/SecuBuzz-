import {createContext} from 'react';
import type {MessageAttachment} from './messageModel';
export const EncryptedAttachmentContext=createContext<((attachment:MessageAttachment,signal:AbortSignal)=>Promise<Blob>)|null>(null);
