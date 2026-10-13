'use client';

import type { ConnectionDto, ProviderDto, ProviderKind } from '@evobridge/shared';
import { PROVIDER_LABELS } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { Route } from '@/components/connection-card';
import { ProviderForm } from '@/components/provider-form';
import { ProvisionSteps } from '@/components/provision-steps';
import { ProviderStatusText } from '@/components/status';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/overlay';
import { Checkbox, Field, Input, Panel, Skeleton, Switch } from '@/components/ui/primitives';
import { api, errorText } from '@/lib/api';
import { keys, useAccounts, useInboxes, useInstances, useProviders, useSystem } from '@/lib/queries';
import { cn } from '@/lib/utils';

const STEPS = ['Evolution Go', 'Chatwoot', 'Link', 'Connect'] as const;

export default function NewConnectionPage() {
  const [step, setStep] = useState(0);
  const [evoId, setEvoId] = useState<string>();
  const [cwId, setCwId] = useState<string>();
  const [created, setCreated] = useState<ConnectionDto | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <>
      <Link href="/connections" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3" />
        Connections
      </Link>
      <PageHeader title="Create connection" description="Pick a WhatsApp instance and the Chatwoot inbox it should appear in. EvoBridge sets up both webhooks for you." />
      <ol className="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-[13px]">
        {STEPS.map((label, i) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={cn(
                'flex size-5 items-center justify-center rounded-full border text-[11px] font-medium',
                i < step ? 'border-ok bg-ok text-bg' : i === step ? 'border-fg text-fg' : 'border-border-strong text-faint',
              )}
            >
              {i < step ? <Check className="size-3" strokeWidth={3} /> : i + 1}
            </span>
            <span className={i === step ? 'font-medium' : 'text-muted'}>{label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border-strong" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <div className="max-w-2xl">
        {step === 0 && <ProviderStep kind="evolution_go" selected={evoId} onDone={(id) => (setEvoId(id), setStep(1))} />}
        {step === 1 && <ProviderStep kind="chatwoot" selected={cwId} onDone={(id) => (setCwId(id), setStep(2))} onBack={() => setStep(0)} />}
        {step === 2 && evoId && cwId && (
          <LinkStep
            evoId={evoId}
            cwId={cwId}
            onBack={() => setStep(1)}
            onCreate={async (body) => {
              setStep(3);
              setRunning(true);
              try {
                setCreated(await api.post<ConnectionDto>('/api/connections', body));
              } catch (err) {
                setCreated(null);
                setStep(2);
                throw err;
              } finally {
                setRunning(false);
              }
            }}
          />
        )}
        {step === 3 && <ConnectStep connection={created} running={running} onUpdate={setCreated} setRunning={setRunning} />}
      </div>
    </>
  );
}

function ProviderStep({ kind, selected, onDone, onBack }: { kind: ProviderKind; selected?: string; onDone: (id: string) => void; onBack?: () => void }) {
  const providers = useProviders();
  const mine = (providers.data ?? []).filter((p) => p.kind === kind);
  const [adding, setAdding] = useState(false);
  const [choice, setChoice] = useState<string | undefined>(selected);
  useEffect(() => {
    if (!choice && mine[0]) setChoice(mine[0].id);
  }, [choice, mine]);
  const label = PROVIDER_LABELS[kind];
  const showForm = adding || (!providers.isLoading && mine.length === 0);

  return (
    <Panel className="p-5">
      <h2 className="text-[15px] font-semibold">{kind === 'evolution_go' ? 'Where is your Evolution Go?' : 'Where is your Chatwoot?'}</h2>
      <p className="mt-1 text-[13px] text-muted">
        {kind === 'evolution_go'
          ? 'EvoBridge talks to Evolution Go with the global API key. Evolution API (Node) is a different product and is not supported.'
          : 'Use an administrator access token: EvoBridge creates the inbox and sets its webhook.'}
      </p>
      <div className="mt-5">
        {providers.isLoading ? (
          <Skeleton className="h-24" />
        ) : showForm ? (
          <>
            <ProviderForm kind={kind} submitLabel="Save and continue" onSaved={(p) => onDone(p.id)} />
            {mine.length > 0 && (
              <button type="button" className="mt-3 text-xs text-muted hover:text-fg" onClick={() => setAdding(false)}>
                Use a saved {label} instead
              </button>
            )}
          </>
        ) : (
          <div className="space-y-2">
            {mine.map((p) => (
              <ProviderOption key={p.id} provider={p} selected={choice === p.id} onSelect={() => setChoice(p.id)} />
            ))}
            <button type="button" onClick={() => setAdding(true)} className="flex w-full items-center gap-2 rounded-md border border-dashed border-border-strong px-3 py-2.5 text-[13px] text-muted hover:text-fg">
              <Plus className="size-3.5" />
              Add another {label}
            </button>
          </div>
        )}
      </div>
      {!showForm && (
        <div className="mt-5 flex justify-between">
          {onBack ? (
            <Button variant="ghost" onClick={onBack}>
              Back
            </Button>
          ) : (
            <span />
          )}
          <Button variant="primary" disabled={!choice} onClick={() => choice && onDone(choice)}>
            Continue
          </Button>
        </div>
      )}
      {showForm && onBack && (
        <Button variant="ghost" className="mt-3" onClick={onBack}>
          Back
        </Button>
      )}
    </Panel>
  );
}

function ProviderOption({ provider, selected, onSelect }: { provider: ProviderDto; selected: boolean; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn('flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left', selected ? 'border-accent bg-accent/5' : 'border-border hover:border-border-strong')}
    >
      <span className={cn('flex size-4 items-center justify-center rounded-full border', selected ? 'border-accent' : 'border-border-strong')}>
        {selected && <span className="size-2 rounded-full bg-accent" />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{provider.name}</span>
        <span className="block truncate text-xs text-faint">{provider.baseUrl}</span>
      </span>
      <ProviderStatusText status={provider.status} />
    </button>
  );
}

interface CreateBody {
  evolutionProviderId: string;
  instanceName: string;
  chatwootProviderId: string;
  accountId: number;
  inbox: { mode: 'existing'; inboxId: number } | { mode: 'create'; inboxName: string };
  replaceExistingWebhooks: boolean;
  options: { signAgentName: boolean; reopenConversation: boolean; syncPhoneMessages: boolean; includeGroups: boolean };
}

function LinkStep({ evoId, cwId, onBack, onCreate }: { evoId: string; cwId: string; onBack: () => void; onCreate: (body: CreateBody) => Promise<void> }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const instances = useInstances(evoId);
  const accounts = useAccounts(cwId);
  const system = useSystem();
  const [instanceName, setInstanceName] = useState<string>();
  const [accountId, setAccountId] = useState<number>();
  const inboxes = useInboxes(cwId, accountId);
  const [inboxChoice, setInboxChoice] = useState<string>('create');
  const [inboxName, setInboxName] = useState('');
  const [consent, setConsent] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [options, setOptions] = useState({ signAgentName: true, reopenConversation: true, syncPhoneMessages: true, includeGroups: false });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.data?.length) setAccountId((accounts.data.find((a) => a.role === 'administrator') ?? accounts.data[0])!.id);
  }, [accounts.data, accountId]);
  useEffect(() => {
    if (instanceName && !inboxName) setInboxName(`WhatsApp ${instanceName}`);
  }, [instanceName, inboxName]);
  useEffect(() => {
    if (system.data && !system.data.publicUrl && !publicUrl) setPublicUrl(window.location.origin);
  }, [system.data, publicUrl]);

  const instance = instances.data?.find((i) => i.name === instanceName);
  const inbox = inboxChoice === 'create' ? null : inboxes.data?.find((i) => String(i.id) === inboxChoice);
  const takenWebhooks = [instance?.webhookUrl, inbox?.webhookUrl].filter((u): u is string => Boolean(u && !u.includes('/hooks/')));
  const needsPublicUrl = system.data && !system.data.publicUrl;
  const evo = providers.data?.find((p) => p.id === evoId);
  const cw = providers.data?.find((p) => p.id === cwId);
  const account = accounts.data?.find((a) => a.id === accountId);

  const ready = instanceName && accountId && (inboxChoice === 'create' ? inboxName.trim() : inbox) && (!takenWebhooks.length || consent) && (!needsPublicUrl || publicUrl.trim());

  const summary = useMemo(
    () => ({
      state: 'configuring' as const,
      evolution: { providerId: evoId, providerName: evo?.name ?? 'Evolution Go', instanceName: instanceName ?? 'Instance' },
      chatwoot: { providerId: cwId, providerName: cw?.name ?? 'Chatwoot', accountId: accountId ?? 0, inboxId: inbox?.id ?? null, inboxName: inboxChoice === 'create' ? inboxName || 'New inbox' : (inbox?.name ?? 'Inbox') },
    }),
    [evoId, cwId, evo, cw, instanceName, accountId, inbox, inboxChoice, inboxName],
  );

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      if (needsPublicUrl) {
        await api.put('/api/settings', { publicUrl: publicUrl.trim() });
        await qc.invalidateQueries({ queryKey: keys.system });
      }
      await onCreate({
        evolutionProviderId: evoId,
        instanceName: instanceName!,
        chatwootProviderId: cwId,
        accountId: accountId!,
        inbox: inboxChoice === 'create' ? { mode: 'create', inboxName: inboxName.trim() } : { mode: 'existing', inboxId: inbox!.id },
        replaceExistingWebhooks: consent,
        options,
      });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-[15px] font-semibold">Link a WhatsApp number to an inbox</h2>
      <div className="mt-5 space-y-5">
        <Field
          label="WhatsApp instance"
          htmlFor="instance"
          hint={instance && !instance.connected ? 'This instance is not logged in to WhatsApp. You can connect it now and scan the QR code in Evolution Go later.' : undefined}
          error={instances.error ? errorText(instances.error) : undefined}
        >
          {instances.isLoading ? (
            <Skeleton className="h-8" />
          ) : (
            <Select
              id="instance"
              value={instanceName}
              onValueChange={setInstanceName}
              placeholder={instances.data?.length ? 'Choose an instance' : 'No instances on this server'}
              disabled={!instances.data?.length}
              items={(instances.data ?? []).map((i) => ({ value: i.name, label: i.name, hint: i.phone ? `+${i.phone}` : i.connected ? 'connected' : 'not logged in' }))}
            />
          )}
        </Field>

        <Field label="Chatwoot account" htmlFor="account" error={accounts.error ? errorText(accounts.error) : undefined}>
          {accounts.isLoading ? (
            <Skeleton className="h-8" />
          ) : (
            <Select
              id="account"
              value={accountId ? String(accountId) : undefined}
              onValueChange={(v) => {
                setAccountId(Number(v));
                setInboxChoice('create');
              }}
              placeholder="Choose an account"
              items={(accounts.data ?? []).map((a) => ({ value: String(a.id), label: a.name, hint: a.role === 'administrator' ? undefined : 'agent', disabled: a.role !== 'administrator' }))}
            />
          )}
        </Field>

        <Field label="Inbox" htmlFor="inbox" hint={inboxChoice === 'create' ? 'A new API inbox is created in Chatwoot.' : undefined}>
          {accountId && inboxes.isLoading ? (
            <Skeleton className="h-8" />
          ) : (
            <Select
              id="inbox"
              value={inboxChoice}
              onValueChange={setInboxChoice}
              placeholder="Choose an inbox"
              disabled={!accountId}
              items={[
                { value: 'create', label: 'Create a new API inbox' },
                ...(inboxes.data ?? []).map((i) => ({
                  value: String(i.id),
                  label: i.name,
                  disabled: !i.bridgeable,
                  hint: i.bridgeable ? 'API' : i.channelType.replace('Channel::', ''),
                })),
              ]}
            />
          )}
        </Field>
        {inboxChoice === 'create' && (
          <Field label="Inbox name" htmlFor="inbox-name">
            <Input id="inbox-name" value={inboxName} onChange={(e) => setInboxName(e.target.value)} maxLength={80} />
          </Field>
        )}

        {needsPublicUrl && (
          <Field label="EvoBridge public URL" htmlFor="public-url" hint="Evolution Go and Chatwoot call this address. It must be reachable from both servers.">
            <Input id="public-url" value={publicUrl} onChange={(e) => setPublicUrl(e.target.value)} spellCheck={false} />
          </Field>
        )}

        {takenWebhooks.length > 0 && (
          <label className="flex gap-2.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5 text-[13px]">
            <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
            <span>
              <span className="font-medium">Another service receives these events: </span>
              <span className="break-all font-mono text-xs">{takenWebhooks.join(', ')}</span>
              <span className="mt-1 block text-xs text-muted">
                Only one webhook fits. EvoBridge will take it over and forward every event to that address, so the other service keeps working.
              </span>
            </span>
          </label>
        )}

        <div className="space-y-3 rounded-md border border-border px-3 py-3">
          <Toggle label="Sign replies with the agent's name" checked={options.signAgentName} onChange={(v) => setOptions({ ...options, signAgentName: v })} />
          <Toggle label="Reopen the previous conversation" detail="Off: a resolved conversation stays closed and a new one starts." checked={options.reopenConversation} onChange={(v) => setOptions({ ...options, reopenConversation: v })} />
          <Toggle label="Show messages sent from the phone" checked={options.syncPhoneMessages} onChange={(v) => setOptions({ ...options, syncPhoneMessages: v })} />
          <Toggle label="Include group chats" checked={options.includeGroups} onChange={(v) => setOptions({ ...options, includeGroups: v })} />
        </div>

        {instanceName && account && (
          <div className="rounded-md border border-border bg-bg px-4 py-4">
            <Route connection={summary} />
            <p className="mt-3 text-center text-xs text-faint">
              {evo?.name} → {instanceName} → {account.name} / {summary.chatwoot.inboxName}
            </p>
          </div>
        )}
        {error && <p className="text-xs text-bad">{error}</p>}
      </div>
      <div className="mt-6 flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" disabled={!ready} loading={submitting} onClick={() => void submit()}>
          Create connection
        </Button>
      </div>
    </Panel>
  );
}

function Toggle({ label, detail, checked, onChange }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span className="block text-[13px]">{label}</span>
        {detail && <span className="block text-xs text-faint">{detail}</span>}
      </span>
      <Switch checked={checked} onCheckedChange={onChange} className="mt-0.5" />
    </label>
  );
}

function ConnectStep({ connection, running, onUpdate, setRunning }: { connection: ConnectionDto | null; running: boolean; onUpdate: (c: ConnectionDto) => void; setRunning: (v: boolean) => void }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = connection?.provision.find((s) => s.status === 'failed' || s.status === 'action_required');
  const done = connection && !blocked && connection.provision.every((s) => s.status === 'done' || s.status === 'skipped');
  const asksTakeover = blocked?.status === 'action_required' && /already sends events/.test(blocked.message ?? '');

  useEffect(() => {
    if (done) void qc.invalidateQueries({ queryKey: keys.connections });
  }, [done, qc]);

  async function retry() {
    if (!connection) return;
    setRunning(true);
    setError(null);
    try {
      onUpdate(await api.post<ConnectionDto>(`/api/connections/${connection.id}/provision`, { replaceExistingWebhooks: consent }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <Panel className="p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold">{running ? 'Setting up the connection' : done ? 'Connected' : 'Setup needs your attention'}</h2>
          <p className="mt-1 text-[13px] text-muted">
            {running
              ? 'Configuring Evolution Go and Chatwoot. This takes a few seconds.'
              : done
                ? 'New WhatsApp messages now appear in Chatwoot, and agent replies go back to WhatsApp.'
                : 'Nothing was marked as done unless EvoBridge could verify it. Fix the item below and try again.'}
          </p>
        </div>
        {done && (
          <span className="flex size-8 items-center justify-center rounded-full bg-ok/15 text-ok">
            <Check className="size-4" strokeWidth={2.5} />
          </span>
        )}
      </div>
      {connection && !running && (
        <div className="mt-4 rounded-md border border-border bg-bg px-4 py-4">
          <Route connection={connection} />
        </div>
      )}
      <div className="mt-4">
        <ProvisionSteps steps={connection?.provision ?? null} running={running} />
      </div>
      {asksTakeover && (
        <label className="mt-3 flex gap-2.5 rounded-md border border-warn/40 bg-warn/5 px-3 py-2.5 text-[13px]">
          <Checkbox checked={consent} onCheckedChange={(v) => setConsent(v === true)} className="mt-0.5" />
          Replace it and forward events to the current address
        </label>
      )}
      {error && <p className="mt-3 text-xs text-bad">{error}</p>}
      {!running && connection && (
        <div className="mt-5 flex justify-end gap-2">
          {done ? (
            <>
              <Button variant="secondary" onClick={() => router.push('/')}>
                Go to overview
              </Button>
              <Button variant="primary" onClick={() => router.push(`/connections/view?id=${connection.id}`)}>
                Open connection
              </Button>
            </>
          ) : (
            <>
              <Button variant="secondary" onClick={() => router.push(`/connections/view?id=${connection.id}`)}>
                Finish later
              </Button>
              <Button variant="primary" disabled={asksTakeover && !consent} onClick={() => void retry()}>
                Try again
              </Button>
            </>
          )}
        </div>
      )}
    </Panel>
  );
}
