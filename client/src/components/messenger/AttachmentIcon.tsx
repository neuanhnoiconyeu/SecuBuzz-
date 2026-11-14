import { FileArchive, FileImage, FileSpreadsheet, FileText, Film, Music, Presentation } from 'lucide-react';
import type { MessageAttachment } from '@/messaging/messageModel';

export function AttachmentIcon({ attachment, size = 20 }: { attachment: MessageAttachment; size?: number }) {
  const extension = attachment.name.split('.').pop()?.toLowerCase();
  const Icon = attachment.type === 'image' ? FileImage : attachment.type === 'video' ? Film : attachment.type === 'audio' ? Music
    : ['zip', 'rar', '7z'].includes(extension ?? '') ? FileArchive
      : ['xls', 'xlsx', 'csv'].includes(extension ?? '') ? FileSpreadsheet
        : ['ppt', 'pptx'].includes(extension ?? '') ? Presentation : FileText;
  return <Icon size={size} aria-hidden="true" />;
}
