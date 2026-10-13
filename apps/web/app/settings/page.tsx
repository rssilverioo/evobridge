'use client';

import { PASSWORD_RULES } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Field, Input, Panel, Skeleton, Switch } from '@/components/ui/primitives';
import { ApiRequestError, api, errorText } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { keys, useSettings, useSystem } from '@/lib/queries';
import { formatBytes, formatNumber } from '@/lib/utils';

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" />
      <div className="max-w-2xl space-y-8">
        <GeneralSettings />
        <PasswordSettings />
        <About />
      </div>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-[14px] font-semibold">{title}</h2>
      {description && <p className="mt-0.5 text-[13px] text-muted">{description}</p>}
      <Panel className="mt-3 p-5">{children}</Panel>
    </section>
  );
}

function GeneralSettings() {
  const qc = useQueryClient();
  const settings = useSettings();
  const system = useSystem();
  const [publicUrl, setPublicUrl] = useState('');
  const [retention, setRetention] = useState('14');
  const [logContent, setLogContent] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data) {
      setPublicUrl(settings.data.publicUrl || (system.data?.publicUrlSource === 'env' ? '' : window.location.origin));
      setRetention(String(settings.data.retentionDays));
      setLogContent(settings.data.logMessageContent);
    }
  }, [settings.data, system.data]);

  if (settings.isLoading || system.isLoading) return <Skeleton className="h-56" />;
  const fromEnv = system.data?.publicUrlSource === 'env';

  async function save() {
    setSaving(true);
    try {
      await api.put('/api/settings', {
        ...(fromEnv ? {} : { publicUrl: publicUrl.trim() }),
        retentionDays: Math.min(365, Math.max(1, Number(retention) || 14)),
        logMessageContent: logContent,
      });
      await qc.invalidateQueries({ queryKey: keys.settings });
      await qc.invalidateQueries({ queryKey: keys.system });
      toast.success('Settings saved');
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section title="General">
      <div className="space-y-5">
        <Field
          label="Public URL"
          htmlFor="public-url"
          hint={
            fromEnv
              ? `Set by PUBLIC_URL in the container: ${system.data?.publicUrl}`
              : 'The address Evolution Go and Chatwoot use to reach EvoBridge. After changing it, reconfigure the webhooks of each connection.'
          }
        >
          <Input id="public-url" value={fromEnv ? (system.data?.publicUrl ?? '') : publicUrl} onChange={(e) => setPublicUrl(e.target.value)} disabled={fromEnv} spellCheck={false} />
        </Field>
        <Field label="Keep events for" htmlFor="retention" hint="Older events, and stored payloads of failed messages, are deleted after this many days.">
          <div className="flex items-center gap-2">
            <Input id="retention" type="number" min={1} max={365} value={retention} onChange={(e) => setRetention(e.target.value)} className="w-24" />
            <span className="text-[13px] text-muted">days</span>
          </div>
        </Field>
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span>
            <span className="block text-[13px] font-medium">Store message text in logs</span>
            <span className="block text-xs text-muted">Off by default. Helps debugging, but keeps customer messages in the EvoBridge database.</span>
          </span>
          <Switch checked={logContent} onCheckedChange={setLogContent} className="mt-0.5" />
        </label>
        <div className="flex justify-end">
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save settings
          </Button>
        </div>
      </div>
    </Section>
  );
}

function PasswordSettings() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const valid = PASSWORD_RULES.every((r) => r.test(next));
  return (
    <Section title="Password" description="Changing it signs out every other session.">
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setSaving(true);
          setError(null);
          try {
            await api.post('/api/auth/password', { currentPassword: current, newPassword: next });
            setCurrent('');
            setNext('');
            toast.success('Password changed');
          } catch (err) {
            setError(err instanceof ApiRequestError && err.fields ? Object.values(err.fields)[0]! : errorText(err));
          } finally {
            setSaving(false);
          }
        }}
      >
        <Field label="Current password" htmlFor="current">
          <Input id="current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password" htmlFor="next" hint={PASSWORD_RULES.map((r) => r.label).join(', ')} error={error ?? undefined}>
          <Input id="next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" loading={saving} disabled={!current || !valid}>
            Change password
          </Button>
        </div>
      </form>
    </Section>
  );
}

function About() {
  const system = useSystem();
  const s = system.data;
  return (
    <Section title="About">
      {s ? (
        <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-[13px]">
          <dt className="text-muted">Version</dt>
          <dd>{s.version}</dd>
          <dt className="text-muted">Data directory</dt>
          <dd className="break-all font-mono text-xs">{s.dataDir}</dd>
          <dt className="text-muted">Database</dt>
          <dd>
            {formatBytes(s.database.sizeBytes)} · {formatNumber(s.database.events)} events
          </dd>
          <dt className="text-muted">Private networks</dt>
          <dd>{s.allowPrivateNetworks ? 'Allowed (ALLOW_PRIVATE_NETWORKS=true)' : 'Blocked'}</dd>
          <dt className="text-muted">Integrations</dt>
          <dd className="text-muted">
            {BRAND.name} works with Evolution Go and Chatwoot. It is an independent project, not affiliated with Evolution Foundation or Chatwoot.
          </dd>
        </dl>
      ) : (
        <Skeleton className="h-24" />
      )}
    </Section>
  );
}
