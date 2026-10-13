'use client';

import type { EventDto } from '@evobridge/shared';
import { ArrowDownLeft, ArrowUpRight, Cog } from 'lucide-react';
import { cn, formatTime } from '@/lib/utils';
import { EventStatusText } from './status';

const SOURCE_LABEL: Record<string, string> = { evolution_go: 'Evolution Go', chatwoot: 'Chatwoot', evobridge: 'EvoBridge' };

/** Human label for internal event types like "message.image.from_phone". */
export function eventLabel(type: string): string {
  const map: Record<string, string> = {
    message: 'Message',
    'message.text': 'Text message',
    'message.image': 'Image',
    'message.video': 'Video',
    'message.audio': 'Audio',
    'message.document': 'Document',
    'message.sticker': 'Sticker',
    'message.location': 'Location',
    'message.contact': 'Contact card',
    'message.unsupported': 'Unsupported message',
    'message.outgoing': 'Agent reply',
    'message.outgoing.media': 'Agent reply with attachment',
    'message.deleted': 'Agent deleted message',
    'message.revoke': 'Customer deleted message',
    'message.edit': 'Message edited',
    'message.reaction': 'Reaction',
    revoke: 'Message deleted',
    edit: 'Message edited',
    reaction: 'Reaction',
    receipt: 'Read receipt',
    'receipt.delivered': 'Delivered',
    'receipt.read': 'Read',
    connection: 'WhatsApp connection',
    'webhook.forward': 'Forwarded to previous webhook',
    'provision.completed': 'Connection set up',
    'auth.setup': 'Administrator created',
  };
  if (map[type]) return map[type];
  if (type.endsWith('.from_phone')) return `${eventLabel(type.replace(/\.from_phone$/, ''))} sent from phone`;
  if (type.startsWith('provision.')) return `Setup: ${type.slice(10).replace(/_/g, ' ')}`;
  if (type.startsWith('instance.')) return `WhatsApp ${type.slice(9)}`;
  return type;
}

export function DirectionIcon({ direction }: { direction: EventDto['direction'] }) {
  const Icon = direction === 'inbound' ? ArrowDownLeft : direction === 'outbound' ? ArrowUpRight : Cog;
  return <Icon className="size-3.5 text-faint" aria-label={direction} />;
}

/** Compact list used on the overview and connection pages. */
export function EventList({ items, onSelect }: { items: EventDto[]; onSelect?: (e: EventDto) => void }) {
  return (
    <ul className="divide-y divide-border">
      {items.map((e) => (
        <li key={e.id}>
          <button
            type="button"
            onClick={() => onSelect?.(e)}
            disabled={!onSelect}
            className={cn('grid w-full grid-cols-[16px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left', onSelect && 'hover:bg-raised/50')}
          >
            <DirectionIcon direction={e.direction} />
            <span className="min-w-0">
              <span className="block truncate text-[13px]">{eventLabel(e.type)}</span>
              <span className="block truncate text-[11px] text-faint">
                {formatTime(e.createdAt)} · {e.connectionName ?? SOURCE_LABEL[e.source]}
                {e.error ? ` · ${e.error}` : ''}
              </span>
            </span>
            <EventStatusText status={e.status} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export { SOURCE_LABEL };
