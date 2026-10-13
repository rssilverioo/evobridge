'use client';

import { EVENT_STATUSES, type EventDto, type EventStatus } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw, ScrollText, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { DirectionIcon, SOURCE_LABEL, eventLabel } from '@/components/event-list';
import { EventStatusText } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Dialog, Select } from '@/components/ui/overlay';
import { CopyValue, Input, Panel, Skeleton, Switch } from '@/components/ui/primitives';
import { api, errorText } from '@/lib/api';
import { useConnections, useEvents, useOverview } from '@/lib/queries';
import { formatNumber, formatTime } from '@/lib/utils';

export default function EventsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <EventsView />
    </Suspense>
  );
}

const STATUS_LABEL: Record<EventStatus, string> = { received: 'Queued', processed: 'Processed', ignored: 'Ignored', retrying: 'Retrying', failed: 'Failed', dead: 'Failed (final)' };
const REF_LABEL: Record<string, string> = {
  waMessageId: 'WhatsApp message',
  cwMessageId: 'Chatwoot message',
  cwConversationId: 'Chatwoot conversation',
  chat: 'WhatsApp chat',
  target: 'Forwarded to',
};

function EventsView() {
  const search = useSearchParams();
  const router = useRouter();
  const qc = useQueryClient();
  const connections = useConnections();
  const overview = useOverview();
  const [q, setQ] = useState(search.get('q') ?? '');
  const [live, setLive] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<EventDto | null>(null);
  const [replaying, setReplaying] = useState(false);

  const filters = {
    connectionId: search.get('connectionId') ?? '',
    status: search.get('status') ?? '',
    direction: search.get('direction') ?? '',
  };
  const params = useMemo(() => {
    const p = new URLSearchParams({ limit: '50' });
    for (const [k, v] of Object.entries(filters)) if (v) p.set(k, v);
    const term = search.get('q');
    if (term) p.set('q', term);
    if (cursor) p.set('before', cursor);
    return p;
  }, [search, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const events = useEvents(params, live && !cursor);

  // Deep link from a connection page: open that event's details.
  const wanted = search.get('event');
  useEffect(() => {
    if (wanted && events.data) {
      const hit = events.data.items.find((e) => e.id === wanted);
      if (hit) setSelected(hit);
    }
  }, [wanted, events.data]);

  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(search.toString());
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete('event');
    setCursor(null);
    router.replace(`/events?${next.toString()}`);
  }

  async function replay(e: EventDto) {
    setReplaying(true);
    try {
      await api.post(`/api/events/${e.id}/replay`);
      toast.success('Event queued again');
      setSelected(null);
      await qc.invalidateQueries({ queryKey: ['events'] });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setReplaying(false);
    }
  }

  const m = overview.data?.messages;
  return (
    <>
      <PageHeader
        title="Events & Logs"
        description="Every message and webhook EvoBridge handled. Message text is not stored unless you turn it on in Settings."
        actions={
          <label className="flex items-center gap-2 text-[13px] text-muted">
            <Switch checked={live} onCheckedChange={setLive} />
            Live
          </label>
        }
      />

      <div className="mb-4 flex flex-wrap gap-x-6 gap-y-1 text-[13px] text-muted">
        <span>
          <span className="font-medium tabular-nums text-fg">{m ? formatNumber(m.processed24h) : '·'}</span> processed today
        </span>
        <span>
          <span className={`font-medium tabular-nums ${m?.failed24h ? 'text-bad' : 'text-fg'}`}>{m ? formatNumber(m.failed24h) : '·'}</span> failed today
        </span>
        <span>
          <span className="font-medium tabular-nums text-fg">{m ? formatNumber(m.queued) : '·'}</span> in queue
        </span>
      </div>

      <div className="mb-3 grid gap-2 sm:grid-cols-[1fr_180px_150px_150px]">
        <form
          className="relative"
          onSubmit={(e) => {
            e.preventDefault();
            setFilter('q', q.trim());
          }}
        >
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
          <Input className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by type, id or error" />
        </form>
        <Select
          value={filters.connectionId || 'all'}
          onValueChange={(v) => setFilter('connectionId', v === 'all' ? '' : v)}
          placeholder="All connections"
          items={[{ value: 'all', label: 'All connections' }, ...(connections.data ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
        <Select
          value={filters.direction || 'all'}
          onValueChange={(v) => setFilter('direction', v === 'all' ? '' : v)}
          placeholder="Any direction"
          items={[
            { value: 'all', label: 'Any direction' },
            { value: 'inbound', label: 'WhatsApp → Chatwoot' },
            { value: 'outbound', label: 'Chatwoot → WhatsApp' },
            { value: 'system', label: 'System' },
          ]}
        />
        <Select
          value={filters.status || 'all'}
          onValueChange={(v) => setFilter('status', v === 'all' ? '' : v)}
          placeholder="Any status"
          items={[{ value: 'all', label: 'Any status' }, ...EVENT_STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] }))]}
        />
      </div>

      {events.error && <ErrorState message={errorText(events.error)} onRetry={() => void events.refetch()} />}
      {events.isLoading ? (
        <Skeleton className="h-80" />
      ) : !events.data?.items.length ? (
        <EmptyState icon={<ScrollText />} title="No events" description="Nothing matches these filters yet. Events show up as soon as a message arrives or an agent replies." />
      ) : (
        <Panel className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left text-[13px]">
            <thead className="border-b border-border text-xs text-muted">
              <tr>
                <th className="px-4 py-2 font-medium">Time</th>
                <th className="py-2 font-medium">Event</th>
                <th className="py-2 font-medium">Connection</th>
                <th className="py-2 font-medium">Source</th>
                <th className="py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {events.data.items.map((e) => (
                <tr key={e.id} className="cursor-pointer hover:bg-raised/50" onClick={() => setSelected(e)}>
                  <td className="whitespace-nowrap px-4 py-2 tabular-nums text-muted">{formatTime(e.createdAt)}</td>
                  <td className="max-w-[280px] py-2">
                    <span className="flex items-center gap-2">
                      <DirectionIcon direction={e.direction} />
                      <span className="truncate">{eventLabel(e.type)}</span>
                    </span>
                    {e.error && <span className="block truncate pl-5.5 text-xs text-bad">{e.error}</span>}
                  </td>
                  <td className="max-w-[180px] truncate py-2 text-muted">{e.connectionName ?? '·'}</td>
                  <td className="whitespace-nowrap py-2 text-muted">{SOURCE_LABEL[e.source]}</td>
                  <td className="whitespace-nowrap py-2">
                    <EventStatusText status={e.status} />
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right tabular-nums text-muted">{e.durationMs !== null ? `${e.durationMs} ms` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
      <div className="mt-3 flex justify-end gap-2">
        {cursor && (
          <Button size="sm" variant="ghost" onClick={() => setCursor(null)}>
            Back to latest
          </Button>
        )}
        {events.data?.nextCursor && (
          <Button size="sm" onClick={() => setCursor(events.data!.nextCursor)}>
            Older events
          </Button>
        )}
      </div>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(o) => !o && setSelected(null)}
        title={selected ? eventLabel(selected.type) : ''}
        description={selected ? `${formatTime(selected.createdAt)} · ${SOURCE_LABEL[selected.source]}${selected.connectionName ? ` · ${selected.connectionName}` : ''}` : undefined}
        footer={
          selected?.replayable ? (
            <Button variant="primary" loading={replaying} onClick={() => void replay(selected)}>
              <RotateCcw />
              Replay event
            </Button>
          ) : undefined
        }
      >
        {selected && (
          <dl className="space-y-3 text-[13px]">
            <Row label="Status" value={<EventStatusText status={selected.status} />} />
            <Row label="Attempts" value={String(selected.attempts)} />
            {selected.durationMs !== null && <Row label="Processing time" value={`${selected.durationMs} ms`} />}
            {selected.error && <Row label="Error" value={<span className="text-bad">{selected.error}</span>} />}
            {typeof selected.detail?.reason === 'string' && <Row label="Why" value={selected.detail.reason} />}
            {typeof selected.detail?.text === 'string' && <Row label="Message" value={<span className="whitespace-pre-wrap">{selected.detail.text}</span>} />}
            {typeof selected.detail?.mediaFallback === 'string' && <Row label="Media" value={`Posted a placeholder: ${selected.detail.mediaFallback}`} />}
            <Row label="Event ID" value={<CopyValue value={selected.id} />} />
            {Object.entries(selected.refs).map(([k, v]) => (
              <Row key={k} label={REF_LABEL[k] ?? k} value={<CopyValue value={v} />} />
            ))}
          </dl>
        )}
      </Dialog>
    </>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[140px_1fr] items-start gap-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}
