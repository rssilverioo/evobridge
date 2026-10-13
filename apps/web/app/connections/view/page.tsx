'use client';

import type { ConnectionDto, ConnectionOptions } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Ellipsis, Pause, Play, RefreshCw, RotateCcw, Stethoscope, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Route } from '@/components/connection-card';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { EventList } from '@/components/event-list';
import { ProvisionSteps } from '@/components/provision-steps';
import { ConnectionStatus } from '@/components/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlay';
import { Checkbox, CopyValue, Input, Panel, Skeleton, Switch } from '@/components/ui/primitives';
import { api, errorText } from '@/lib/api';
import { keys, useConnection, useEvents } from '@/lib/queries';
import { formatNumber, timeAgo } from '@/lib/utils';

export default function ConnectionPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <ConnectionView />
    </Suspense>
  );
}

function ConnectionView() {
  const id = useSearchParams().get('id');
  const { data: c, isLoading, error, refetch } = useConnection(id);
  if (!id) return <EmptyState icon={<RotateCcw />} title="No connection selected" description="Open a connection from the Connections page." />;
  return (
    <>
      <Link href="/connections" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3" />
        Connections
      </Link>
      {error && <ErrorState message={errorText(error)} onRetry={() => void refetch()} />}
      {isLoading || !c ? <Skeleton className="h-64" /> : <ConnectionDetail c={c} />}
    </>
  );
}

function ConnectionDetail({ c }: { c: ConnectionDto }) {
  const qc = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [removeWebhooks, setRemoveWebhooks] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const params = new URLSearchParams({ connectionId: c.id, limit: '15' });
  const events = useEvents(params, true);
  const provisioned = c.provision.every((s) => s.status === 'done' || s.status === 'skipped');
  const asksTakeover = c.provision.some((s) => s.status === 'action_required' && /already sends events/.test(s.message ?? ''));

  async function run(label: string, fn: () => Promise<unknown>, success: string) {
    setBusy(label);
    try {
      await fn();
      toast.success(success);
      await qc.invalidateQueries({ queryKey: keys.connections });
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const reprovision = (replace: boolean) =>
    run(
      'provision',
      async () => {
        const res = await api.post<ConnectionDto>(`/api/connections/${c.id}/provision`, { replaceExistingWebhooks: replace });
        const blocked = res.provision.find((s) => s.status === 'failed' || s.status === 'action_required');
        if (blocked) throw new Error(blocked.message ?? 'Setup could not finish');
      },
      'Webhooks reconfigured',
    );

  return (
    <>
      <PageHeader
        title={c.name}
        description={<ConnectionStatus state={c.state} />}
        actions={
          <>
            {c.paused ? (
              <Button variant="secondary" loading={busy === 'resume'} onClick={() => void run('resume', () => api.post(`/api/connections/${c.id}/resume`), 'Connection resumed')}>
                <Play />
                Resume
              </Button>
            ) : (
              <Button variant="secondary" loading={busy === 'pause'} disabled={!provisioned} onClick={() => void run('pause', () => api.post(`/api/connections/${c.id}/pause`), 'Connection paused')}>
                <Pause />
                Pause
              </Button>
            )}
            <Button variant="secondary" loading={busy === 'test'} onClick={() => void run('test', () => api.post(`/api/connections/${c.id}/test`), 'Health check finished')}>
              <Stethoscope />
              Test
            </Button>
            <Menu>
              <MenuTrigger asChild>
                <Button variant="secondary" size="icon" aria-label="More actions">
                  <Ellipsis />
                </Button>
              </MenuTrigger>
              <MenuContent>
                <MenuItem onSelect={() => void reprovision(false)}>
                  <RefreshCw />
                  Reconfigure webhooks
                </MenuItem>
                <MenuItem
                  onSelect={() =>
                    void run('replay', () => api.post<{ replayed: number }>('/api/events/replay-failed', { connectionId: c.id }).then((r) => toast.message(`${r.replayed} failed events queued again`)), 'Replay started')
                  }
                >
                  <RotateCcw />
                  Retry failed events
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => setConfirmDelete(true)}>
                  <Trash2 />
                  Remove connection
                </MenuItem>
              </MenuContent>
            </Menu>
          </>
        }
      />

      {c.stateReason && c.state !== 'connected' && <p className="-mt-3 mb-5 text-[13px] text-muted">{c.stateReason}</p>}

      <Panel className="px-5 py-5">
        <Route connection={c} />
        <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border pt-4 text-[13px] sm:grid-cols-4">
          <Stat label="Messages today" value={formatNumber(c.stats.processed24h)} />
          <Stat label="Failed today" value={formatNumber(c.stats.failed24h)} />
          <Stat label="Last message" value={timeAgo(c.lastActivityAt)} />
          <Stat label="Last check" value={timeAgo(c.lastCheckedAt)} />
        </dl>
      </Panel>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        <div className="space-y-6">
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[13px] font-semibold text-muted">Latest messages</h2>
              <Link href={`/events?connectionId=${c.id}`} className="text-xs text-muted hover:text-fg">
                All events
              </Link>
            </div>
            <Panel>
              {events.isLoading ? (
                <div className="space-y-2 p-4">
                  <Skeleton className="h-8" />
                  <Skeleton className="h-8" />
                </div>
              ) : events.data?.items.length ? (
                <EventList items={events.data.items} onSelect={(e) => router.push(`/events?connectionId=${c.id}&event=${e.id}`)} />
              ) : (
                <p className="px-4 py-6 text-center text-[13px] text-muted">Send a WhatsApp message to the number to see it here.</p>
              )}
            </Panel>
          </section>
          <OptionsPanel c={c} />
        </div>
        <section className="space-y-6">
          <div>
            <h2 className="mb-3 text-[13px] font-semibold text-muted">Setup</h2>
            <Panel className="p-2">
              <ProvisionSteps steps={c.provision} running={busy === 'provision'} />
              {!provisioned && busy !== 'provision' && (
                <div className="flex justify-end gap-2 border-t border-border px-2 pb-1 pt-3">
                  <Button variant="primary" size="sm" onClick={() => (asksTakeover ? setConfirmTakeover(true) : void reprovision(false))}>
                    Continue setup
                  </Button>
                </div>
              )}
            </Panel>
          </div>
          <div>
            <h2 className="mb-3 text-[13px] font-semibold text-muted">Details</h2>
            <Panel className="divide-y divide-border text-[13px]">
              <Detail label="Connection ID" value={<CopyValue value={c.id} />} />
              <Detail label="Evolution Go" value={c.evolution.providerName} />
              <Detail label="Instance" value={c.evolution.instanceName} />
              <Detail label="Chatwoot account" value={`#${c.chatwoot.accountId}`} />
              <Detail label="Inbox" value={c.chatwoot.inboxId ? `${c.chatwoot.inboxName} (#${c.chatwoot.inboxId})` : 'Not created yet'} />
              <Detail label="Evolution Go webhook" value={<span className="break-all font-mono text-xs text-muted">{c.webhookUrls.evolution}</span>} />
              <Detail label="Chatwoot webhook" value={<span className="break-all font-mono text-xs text-muted">{c.webhookUrls.chatwoot}</span>} />
            </Panel>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Remove ${c.name}?`}
        description="Messages stop syncing. Contacts, conversations and the inbox in Chatwoot are kept."
        confirmLabel="Remove connection"
        loading={busy === 'delete'}
        onConfirm={() =>
          void run(
            'delete',
            async () => {
              const res = await api.del<{ warnings: string[] }>(`/api/connections/${c.id}`, { removeRemoteWebhooks: removeWebhooks });
              for (const w of res.warnings) toast.warning(w);
              router.push('/connections');
            },
            'Connection removed',
          )
        }
      >
        <label className="flex gap-2.5 text-[13px]">
          <Checkbox checked={removeWebhooks} onCheckedChange={(v) => setRemoveWebhooks(v === true)} className="mt-0.5" />
          <span>
            Also restore the webhooks in Evolution Go and Chatwoot
            <span className="block text-xs text-muted">They go back to what they were before EvoBridge, or are cleared. Only changed if they still point to EvoBridge.</span>
          </span>
        </label>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirmTakeover}
        onOpenChange={setConfirmTakeover}
        title="Take over the existing webhook?"
        description="Another service receives these events. EvoBridge will replace the webhook and forward every event to that service, so it keeps working."
        confirmLabel="Replace and forward"
        onConfirm={() => {
          setConfirmTakeover(false);
          void reprovision(true);
        }}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] items-start gap-3 px-4 py-2.5">
      <span className="text-xs text-muted">{label}</span>
      <span className="min-w-0">{value}</span>
    </div>
  );
}

function OptionsPanel({ c }: { c: ConnectionDto }) {
  const qc = useQueryClient();
  const [name, setName] = useState(c.name);
  async function save(patch: { name?: string; options?: Partial<ConnectionOptions> }) {
    try {
      await api.patch(`/api/connections/${c.id}`, patch);
      await qc.invalidateQueries({ queryKey: keys.connections });
      toast.success('Saved');
    } catch (err) {
      toast.error(errorText(err));
    }
  }
  const rows: Array<{ key: keyof ConnectionOptions; label: string; detail?: string }> = [
    { key: 'signAgentName', label: "Sign replies with the agent's name" },
    { key: 'reopenConversation', label: 'Reopen the previous conversation', detail: 'Off: a resolved conversation stays closed and a new one starts.' },
    { key: 'pendingConversations', label: 'Start new conversations as pending' },
    { key: 'syncPhoneMessages', label: 'Show messages sent from the phone' },
    { key: 'includeGroups', label: 'Include group chats' },
  ];
  return (
    <section>
      <h2 className="mb-3 text-[13px] font-semibold text-muted">Behavior</h2>
      <Panel className="divide-y divide-border">
        <div className="flex items-center gap-3 px-4 py-3">
          <span className="w-28 shrink-0 text-[13px]">Name</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== c.name && void save({ name: name.trim() })} />
        </div>
        {rows.map((r) => (
          <label key={r.key} className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3">
            <span>
              <span className="block text-[13px]">{r.label}</span>
              {r.detail && <span className="block text-xs text-faint">{r.detail}</span>}
            </span>
            <Switch checked={c.options[r.key]} onCheckedChange={(v) => void save({ options: { [r.key]: v } })} />
          </label>
        ))}
      </Panel>
    </section>
  );
}
