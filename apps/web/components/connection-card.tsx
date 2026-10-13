'use client';

import type { ConnectionDto } from '@evobridge/shared';
import { Inbox, ScrollText, Settings2, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { cn, formatNumber, timeAgo } from '@/lib/utils';
import { CONNECTION_TONE, ConnectionStatus, toneClass } from './status';
import { Button } from './ui/button';
import { Panel } from './ui/primitives';

/** Instance ── route ── inbox. The dashed line moves only while messages can actually flow. */
export function Route({ connection, compact }: { connection: Pick<ConnectionDto, 'state' | 'evolution' | 'chatwoot'>; compact?: boolean }) {
  const tone = CONNECTION_TONE[connection.state];
  const live = connection.state === 'connected';
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <Endpoint icon={<Smartphone />} title={connection.evolution.instanceName} subtitle={compact ? undefined : connection.evolution.providerName} />
      <div className={cn('route-line min-w-6 flex-1', toneClass(tone))} data-live={live} aria-hidden="true" />
      <Endpoint
        icon={<Inbox />}
        title={connection.chatwoot.inboxName ?? 'New inbox'}
        subtitle={compact ? undefined : connection.chatwoot.providerName}
        align="right"
      />
    </div>
  );
}

function Endpoint({ icon, title, subtitle, align }: { icon: React.ReactNode; title: string; subtitle?: string; align?: 'right' }) {
  return (
    <div className={cn('flex min-w-0 max-w-[45%] items-center gap-2', align === 'right' && 'flex-row-reverse text-right')}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-border bg-raised text-muted [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] font-medium">{title}</span>
        {subtitle && <span className="block truncate text-[11px] text-faint">{subtitle}</span>}
      </span>
    </div>
  );
}

export function ConnectionCard({ connection }: { connection: ConnectionDto }) {
  return (
    <Panel className="flex min-w-0 flex-col">
      <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
        <Link href={`/connections/view?id=${connection.id}`} className="min-w-0 truncate text-[14px] font-semibold hover:underline">
          {connection.name}
        </Link>
        <ConnectionStatus state={connection.state} />
      </div>
      <div className="px-4 py-4">
        <Route connection={connection} />
      </div>
      {connection.stateReason && connection.state !== 'connected' && (
        <p className="mx-4 mb-3 rounded-md bg-raised px-2.5 py-1.5 text-xs text-muted">{connection.stateReason}</p>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 border-t border-border px-4 py-2">
        <span className="truncate text-xs text-faint">
          {connection.lastActivityAt ? `Last message ${timeAgo(connection.lastActivityAt)}` : 'No messages yet'}
          {connection.stats.processed24h > 0 && ` · ${formatNumber(connection.stats.processed24h)} today`}
        </span>
        <div className="flex shrink-0 gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/events?connectionId=${connection.id}`}>
              <ScrollText />
              Logs
            </Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/connections/view?id=${connection.id}`}>
              <Settings2 />
              Configure
            </Link>
          </Button>
        </div>
      </div>
    </Panel>
  );
}
