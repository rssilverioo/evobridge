'use client';

import { PROVIDER_LABELS } from '@evobridge/shared';
import { Cable, Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { ConnectionCard } from '@/components/connection-card';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { EventList } from '@/components/event-list';
import { ProviderStatusText } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Panel, Skeleton } from '@/components/ui/primitives';
import { errorText } from '@/lib/api';
import { useConnections, useOverview } from '@/lib/queries';
import { cn, formatNumber, timeAgo } from '@/lib/utils';

export default function OverviewPage() {
  const overview = useOverview();
  const connections = useConnections();
  const o = overview.data;
  const list = connections.data ?? [];

  const createButton = (
    <Button asChild variant="primary">
      <Link href="/connections/new">
        <Plus />
        Create connection
      </Link>
    </Button>
  );

  return (
    <>
      <PageHeader title="Overview" actions={list.length > 0 ? createButton : undefined} />

      {overview.error && <ErrorState message={errorText(overview.error)} onRetry={() => void overview.refetch()} />}

      <Panel className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x">
        <Metric label="Connections" value={o?.connections.total} detail={o ? `${o.connections.active} active` : undefined} />
        <Metric
          label="Need attention"
          value={o?.connections.error}
          tone={o && o.connections.error > 0 ? 'warn' : undefined}
          detail={o ? (o.connections.error ? 'see below' : 'all healthy') : undefined}
        />
        <Metric label="Messages today" value={o?.messages.processed24h} detail={o ? `${formatNumber(o.messages.processedTotal)} all time` : undefined} />
        <Metric
          label="Failed today"
          value={o?.messages.failed24h}
          tone={o && o.messages.failed24h > 0 ? 'bad' : undefined}
          detail={o ? (o.messages.dead ? `${o.messages.dead} waiting for replay` : `${o.messages.queued} in queue`) : undefined}
        />
      </Panel>

      <section className="mt-8">
        <h2 className="mb-3 text-[13px] font-semibold text-muted">Connections</h2>
        {connections.isLoading ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <Skeleton className="h-40" />
            <Skeleton className="h-40" />
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Cable />} title="No connections yet" description="Connect Evolution Go to Chatwoot in just a few steps." action={createButton} />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {list.map((c) => (
              <ConnectionCard key={c.id} connection={c} />
            ))}
          </div>
        )}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_320px]">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-muted">Latest events</h2>
            <Link href="/events" className="text-xs text-muted hover:text-fg">
              View all
            </Link>
          </div>
          <Panel>
            {overview.isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-8" />
                ))}
              </div>
            ) : o?.recentEvents.length ? (
              <EventList items={o.recentEvents} />
            ) : (
              <p className="px-4 py-6 text-center text-[13px] text-muted">Events appear here as messages flow.</p>
            )}
          </Panel>
        </section>
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-muted">Providers</h2>
            <Link href="/providers" className="text-xs text-muted hover:text-fg">
              Manage
            </Link>
          </div>
          <Panel>
            {overview.isLoading ? (
              <div className="space-y-2 p-4">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : o?.providers.length ? (
              <ul className="divide-y divide-border">
                {o.providers.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">{p.name}</span>
                      <span className="block text-[11px] text-faint">
                        {PROVIDER_LABELS[p.kind]} · checked {timeAgo(p.lastCheckedAt)}
                      </span>
                    </span>
                    <ProviderStatusText status={p.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-center text-[13px] text-muted">Added when you create a connection.</p>
            )}
          </Panel>
        </section>
      </div>
    </>
  );
}

function Metric({ label, value, detail, tone }: { label: string; value: number | undefined; detail?: string; tone?: 'warn' | 'bad' }) {
  return (
    <div className="border-border px-4 py-3.5 [&:nth-child(-n+2)]:border-b sm:[&:nth-child(-n+2)]:border-b-0">
      <p className="text-xs text-muted">{label}</p>
      {value === undefined ? (
        <Skeleton className="mt-1.5 h-6 w-12" />
      ) : (
        <p className={cn('mt-0.5 text-2xl font-semibold tabular-nums tracking-tight', tone === 'warn' && 'text-warn', tone === 'bad' && 'text-bad')}>{formatNumber(value)}</p>
      )}
      {detail && <p className="mt-0.5 text-[11px] text-faint">{detail}</p>}
    </div>
  );
}
