'use client';

import type { ConnectionDto, EvolutionInstanceDto, ProviderDto } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/app-shell';
import { Route } from '@/components/connection-card';
import { PairingPanel } from '@/components/pairing-panel';
import { ProvisionSteps } from '@/components/provision-steps';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/overlay';
import { Checkbox, Field, Input, Panel, Skeleton, Switch } from '@/components/ui/primitives';
import { ApiRequestError, api, errorText } from '@/lib/api';
import { keys, useAccounts, useInboxes, useInstances, useProviders, useSystem } from '@/lib/queries';
import { cn } from '@/lib/utils';

const STEPS = ['WhatsApp', 'Chatwoot inbox', 'Connect'] as const;
const NEW_INSTANCE = '__new__';

interface WhatsAppChoice {
  evoId: string;
  instance: EvolutionInstanceDto;
}

export default function NewConnectionPage() {
  const [step, setStep] = useState(0);
  const [wa, setWa] = useState<WhatsAppChoice | null>(null);
  const [created, setCreated] = useState<ConnectionDto | null>(null);
  const [running, setRunning] = useState(false);

  return (
    <>
      <Link href="/connections" className="mb-3 inline-flex items-center gap-1 text-xs text-muted hover:text-fg">
        <ArrowLeft className="size-3" />
        Connections
      </Link>
      <PageHeader title="Create connection" description="Pick a WhatsApp number and the Chatwoot inbox it should appear in. EvoBridge sets up both webhooks for you." />
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
        {step === 0 && <WhatsAppStep initial={wa} onDone={(choice) => (setWa(choice), setStep(1))} />}
        {step === 1 && wa && (
          <InboxStep
            wa={wa}
            onBack={() => setStep(0)}
            onCreate={async (body) => {
              setStep(2);
              setRunning(true);
              try {
                setCreated(await api.post<ConnectionDto>('/api/connections', body));
              } catch (err) {
                setStep(1);
                throw err;
              } finally {
                setRunning(false);
              }
            }}
          />
        )}
        {step === 2 && <ConnectStep connection={created} running={running} onUpdate={setCreated} setRunning={setRunning} />}
      </div>
    </>
  );
}

/** Server picker, shown only when more than one server of that kind is registered. */
function ProviderPicker({ label, value, onChange, providers }: { label: string; value?: string; onChange: (id: string) => void; providers: ProviderDto[] }) {
  if (providers.length < 2) return null;
  return (
    <Field label={label} htmlFor={`${label}-server`}>
      <Select id={`${label}-server`} value={value} onValueChange={onChange} placeholder="Choose a server" items={providers.map((p) => ({ value: p.id, label: p.name, hint: p.baseUrl.replace(/^https?:\/\//, '') }))} />
    </Field>
  );
}

function WhatsAppStep({ initial, onDone }: { initial: WhatsAppChoice | null; onDone: (c: WhatsAppChoice) => void }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const evoProviders = (providers.data ?? []).filter((p) => p.kind === 'evolution_go');
  const [evoId, setEvoId] = useState<string | undefined>(initial?.evoId);
  useEffect(() => {
    if (!evoId && evoProviders[0]) setEvoId(evoProviders[0].id);
  }, [evoId, evoProviders]);
  const instances = useInstances(evoId);
  const [choice, setChoice] = useState<string | undefined>(initial?.instance.id);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paired, setPaired] = useState<string | null>(null);

  const instance = instances.data?.find((i) => i.id === choice);
  const needsPairing = Boolean(instance && !instance.connected && paired !== instance.id);

  const onConnected = useCallback(() => {
    if (!instance) return;
    setPaired(instance.id);
    void qc.invalidateQueries({ queryKey: keys.instances(evoId ?? '') });
  }, [instance, evoId, qc]);

  async function create() {
    if (!evoId) return;
    setCreating(true);
    setError(null);
    try {
      const inst = await api.post<EvolutionInstanceDto>(`/api/providers/${evoId}/instances`, { name: newName.trim() });
      await qc.invalidateQueries({ queryKey: keys.instances(evoId) });
      setChoice(inst.id);
      setNewName('');
    } catch (err) {
      setError(err instanceof ApiRequestError && err.fields ? Object.values(err.fields)[0]! : errorText(err));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Panel className="p-5">
      <h2 className="text-[15px] font-semibold">Which WhatsApp number?</h2>
      <p className="mt-1 text-[13px] text-muted">Use an instance you already have, or create one and link the phone right here.</p>
      <div className="mt-5 space-y-5">
        <ProviderPicker label="Evolution Go" value={evoId} onChange={(v) => (setEvoId(v), setChoice(undefined))} providers={evoProviders} />
        <Field label="Instance" htmlFor="instance" error={instances.error ? errorText(instances.error) : undefined}>
          {instances.isLoading || providers.isLoading ? (
            <Skeleton className="h-8" />
          ) : (
            <Select
              id="instance"
              value={choice}
              onValueChange={setChoice}
              placeholder="Choose an instance"
              items={[
                ...(instances.data ?? []).map((i) => ({ value: i.id, label: i.name, hint: i.phone ? `+${i.phone}` : i.connected ? 'connected' : 'not linked' })),
                { value: NEW_INSTANCE, label: 'Create a new instance' },
              ]}
            />
          )}
        </Field>

        {choice === NEW_INSTANCE && (
          <form
            className="flex items-start gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div className="flex-1">
              <Field label="Instance name" htmlFor="new-instance" hint="Letters, numbers, - and _. For example: sales or support." error={error ?? undefined}>
                <Input id="new-instance" value={newName} onChange={(e) => setNewName(e.target.value)} autoFocus />
              </Field>
            </div>
            <Button type="submit" variant="primary" loading={creating} disabled={!newName.trim()} className="mt-[26px]">
              Create
            </Button>
          </form>
        )}

        {instance && needsPairing && evoId && (
          <div>
            <p className="mb-2 text-[13px] font-medium">Link the phone</p>
            <PairingPanel providerId={evoId} instanceId={instance.id} onConnected={onConnected} />
          </div>
        )}
        {instance && !needsPairing && (
          <p className="flex items-center gap-2 text-[13px] text-ok">
            <Check className="size-4" />
            {instance.name} is linked to WhatsApp{instance.phone ? ` (+${instance.phone})` : ''}.
          </p>
        )}
      </div>
      <div className="mt-6 flex items-center justify-end gap-3">
        {needsPairing && <span className="text-xs text-faint">You can also link the phone later.</span>}
        <Button variant="primary" disabled={!instance || !evoId} onClick={() => instance && evoId && onDone({ evoId, instance })}>
          Continue
        </Button>
      </div>
    </Panel>
  );
}

interface CreateBody {
  evolutionProviderId: string;
  instanceName: string;
  chatwootProviderId: string;
  accountId: number;
  inbox: { mode: 'existing'; inboxId: number } | { mode: 'create'; inboxName: string };
  replaceExistingWebhooks: boolean;
  options: Record<string, boolean>;
}

function InboxStep({ wa, onBack, onCreate }: { wa: WhatsAppChoice; onBack: () => void; onCreate: (body: CreateBody) => Promise<void> }) {
  const qc = useQueryClient();
  const providers = useProviders();
  const cwProviders = (providers.data ?? []).filter((p) => p.kind === 'chatwoot');
  const [cwId, setCwId] = useState<string | undefined>();
  useEffect(() => {
    if (!cwId && cwProviders[0]) setCwId(cwProviders[0].id);
  }, [cwId, cwProviders]);
  const accounts = useAccounts(cwId);
  const system = useSystem();
  const [accountId, setAccountId] = useState<number>();
  const inboxes = useInboxes(cwId, accountId);
  const [inboxChoice, setInboxChoice] = useState<string>('create');
  const [inboxName, setInboxName] = useState(`WhatsApp ${wa.instance.name}`);
  const [consent, setConsent] = useState(false);
  const [publicUrl, setPublicUrl] = useState('');
  const [options, setOptions] = useState({ signAgentName: true, reopenConversation: true, syncPhoneMessages: true, includeGroups: false, connectionNotices: true });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!accountId && accounts.data?.length) setAccountId((accounts.data.find((a) => a.role === 'administrator') ?? accounts.data[0])!.id);
  }, [accounts.data, accountId]);
  useEffect(() => {
    if (system.data && !system.data.publicUrl && !publicUrl) setPublicUrl(window.location.origin);
  }, [system.data, publicUrl]);

  const inbox = inboxChoice === 'create' ? null : inboxes.data?.find((i) => String(i.id) === inboxChoice);
  const takenWebhooks = [wa.instance.webhookUrl, inbox?.webhookUrl].filter((u): u is string => Boolean(u && !u.includes('/hooks/')));
  const needsPublicUrl = system.data && !system.data.publicUrl;
  const evo = providers.data?.find((p) => p.id === wa.evoId);
  const cw = providers.data?.find((p) => p.id === cwId);
  const ready = cwId && accountId && (inboxChoice === 'create' ? inboxName.trim() : inbox) && (!takenWebhooks.length || consent) && (!needsPublicUrl || publicUrl.trim());

  const summary = useMemo(
    () => ({
      state: 'configuring' as const,
      evolution: { providerId: wa.evoId, providerName: evo?.name ?? 'Evolution Go', instanceName: wa.instance.name, instanceId: wa.instance.id },
      chatwoot: { providerId: cwId ?? '', providerName: cw?.name ?? 'Chatwoot', accountId: accountId ?? 0, inboxId: inbox?.id ?? null, inboxName: inboxChoice === 'create' ? inboxName || 'New inbox' : (inbox?.name ?? 'Inbox') },
    }),
    [wa, evo, cw, cwId, accountId, inbox, inboxChoice, inboxName],
  );

  async function submit() {
    if (!cwId || !accountId) return;
    setSubmitting(true);
    setError(null);
    try {
      if (needsPublicUrl) {
        await api.put('/api/settings', { publicUrl: publicUrl.trim() });
        await qc.invalidateQueries({ queryKey: keys.system });
      }
      await onCreate({
        evolutionProviderId: wa.evoId,
        instanceName: wa.instance.name,
        chatwootProviderId: cwId,
        accountId,
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
      <h2 className="text-[15px] font-semibold">Which Chatwoot inbox?</h2>
      <p className="mt-1 text-[13px] text-muted">Messages to {wa.instance.name} appear in this inbox, and agent replies go back to WhatsApp.</p>
      <div className="mt-5 space-y-5">
        <ProviderPicker label="Chatwoot" value={cwId} onChange={(v) => (setCwId(v), setAccountId(undefined), setInboxChoice('create'))} providers={cwProviders} />
        <Field label="Account" htmlFor="account" error={accounts.error ? errorText(accounts.error) : undefined}>
          {accounts.isLoading || !cwId ? (
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
                ...(inboxes.data ?? []).map((i) => ({ value: String(i.id), label: i.name, disabled: !i.bridgeable, hint: i.bridgeable ? 'API' : i.channelType.replace('Channel::', '') })),
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
              <span className="mt-1 block text-xs text-muted">Only one webhook fits. EvoBridge will take it over and forward every event to that address, so the other service keeps working.</span>
            </span>
          </label>
        )}
        <div className="space-y-3 rounded-md border border-border px-3 py-3">
          <Toggle label="Sign replies with the agent's name" checked={options.signAgentName} onChange={(v) => setOptions({ ...options, signAgentName: v })} />
          <Toggle label="Reopen the previous conversation" detail="Off: a resolved conversation stays closed and a new one starts." checked={options.reopenConversation} onChange={(v) => setOptions({ ...options, reopenConversation: v })} />
          <Toggle label="Show messages sent from the phone" checked={options.syncPhoneMessages} onChange={(v) => setOptions({ ...options, syncPhoneMessages: v })} />
          <Toggle label="Include group chats" checked={options.includeGroups} onChange={(v) => setOptions({ ...options, includeGroups: v })} />
          <Toggle
            label="Post connection notices in Chatwoot"
            detail="Private notes in an EvoBridge conversation when WhatsApp connects, disconnects or logs out."
            checked={options.connectionNotices}
            onChange={(v) => setOptions({ ...options, connectionNotices: v })}
          />
        </div>
        {accountId && (
          <div className="rounded-md border border-border bg-bg px-4 py-4">
            <Route connection={summary} />
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
          Take over this webhook, as described above
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
