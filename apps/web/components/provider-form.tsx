'use client';

import { type ProviderCheck, type ProviderDto, type ProviderKind, PROVIDER_LABELS } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck } from 'lucide-react';
import { useState } from 'react';
import { ApiRequestError, api, errorText } from '@/lib/api';
import { keys } from '@/lib/queries';
import { Button } from './ui/button';
import { Field, Input } from './ui/primitives';

const COPY: Record<ProviderKind, { urlPlaceholder: string; secretLabel: string; secretHint: string }> = {
  evolution_go: {
    urlPlaceholder: 'https://evo.example.com',
    secretLabel: 'Global API key',
    secretHint: 'The GLOBAL_API_KEY of your Evolution Go server. EvoBridge reads the instance tokens with it.',
  },
  chatwoot: {
    urlPlaceholder: 'https://chat.example.com',
    secretLabel: 'Access token',
    secretHint: 'Profile settings → Access Token, from a user with the Administrator role.',
  },
};

/**
 * Test-then-save form for a provider. Saving re-runs the check server side, so a broken
 * credential is never stored. Edits keep the stored secret when the field is left empty.
 */
export function ProviderForm({ kind, existing, onSaved, submitLabel = 'Save' }: { kind: ProviderKind; existing?: ProviderDto; onSaved: (p: ProviderDto, check: ProviderCheck | null) => void; submitLabel?: string }) {
  const qc = useQueryClient();
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? '');
  const [secret, setSecret] = useState('');
  const [name, setName] = useState(existing?.name ?? '');
  const [check, setCheck] = useState<ProviderCheck | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const copy = COPY[kind];

  const canTest = baseUrl.trim() && (secret.trim() || existing);

  async function test() {
    setTesting(true);
    setError(null);
    setFields({});
    try {
      const result = existing && !secret.trim()
        ? await api.post<ProviderCheck>(`/api/providers/${existing.id}/check`)
        : await api.post<ProviderCheck>('/api/providers/test', { kind, baseUrl, secret });
      setCheck(result);
    } catch (err) {
      if (err instanceof ApiRequestError && err.fields) setFields(err.fields);
      setCheck(null);
      setError(errorText(err));
    } finally {
      setTesting(false);
    }
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      let provider: ProviderDto;
      if (existing) provider = await api.patch<ProviderDto>(`/api/providers/${existing.id}`, { name: name || undefined, baseUrl, ...(secret.trim() ? { secret } : {}) });
      else provider = (await api.post<{ provider: ProviderDto; check: ProviderCheck }>('/api/providers', { kind, baseUrl, secret, name: name || undefined })).provider;
      await qc.invalidateQueries({ queryKey: keys.providers });
      onSaved(provider, check);
    } catch (err) {
      setError(err instanceof ApiRequestError && err.hint ? `${err.message}. ${err.hint}` : errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (check?.ok) void save();
        else if (canTest) void test();
      }}
    >
      <Field label="Server URL" htmlFor={`${kind}-url`} error={fields.baseUrl}>
        <Input
          id={`${kind}-url`}
          value={baseUrl}
          onChange={(e) => {
            setBaseUrl(e.target.value);
            setCheck(null);
          }}
          placeholder={copy.urlPlaceholder}
          autoComplete="url"
          spellCheck={false}
        />
      </Field>
      <Field label={copy.secretLabel} htmlFor={`${kind}-secret`} hint={existing ? `Stored as ${existing.secretPreview}. Leave empty to keep it.` : copy.secretHint} error={fields.secret}>
        <Input
          id={`${kind}-secret`}
          type="password"
          value={secret}
          onChange={(e) => {
            setSecret(e.target.value);
            setCheck(null);
          }}
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <Field label="Name" htmlFor={`${kind}-name`} optional hint="Shown in the dashboard. Defaults to the server host.">
        <Input id={`${kind}-name`} value={name} onChange={(e) => setName(e.target.value)} placeholder={PROVIDER_LABELS[kind]} />
      </Field>

      {check && <CheckResult check={check} />}
      {error && <p className="text-xs text-bad">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={() => void test()} loading={testing} disabled={!canTest}>
          Test connection
        </Button>
        <Button type="button" variant="primary" onClick={() => void save()} loading={saving} disabled={!check?.ok}>
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}

export function CheckResult({ check }: { check: ProviderCheck }) {
  return (
    <div className={`flex gap-2.5 rounded-md border px-3 py-2.5 ${check.ok ? 'border-ok/30 bg-ok/5' : 'border-bad/30 bg-bad/5'}`} role="status">
      {check.ok ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-ok" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-bad" />}
      <div className="min-w-0 text-[13px]">
        <p className={check.ok ? 'text-fg' : 'text-bad'}>{check.message}</p>
        {check.hint && <p className="mt-0.5 text-xs text-muted">{check.hint}</p>}
      </div>
    </div>
  );
}
