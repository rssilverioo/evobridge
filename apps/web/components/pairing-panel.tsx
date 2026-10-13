'use client';

import type { PairingState } from '@evobridge/shared';
import { useQuery } from '@tanstack/react-query';
import { CircleCheck, ExternalLink, Loader2, QrCode, Smartphone } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiRequestError, api, errorText } from '@/lib/api';
import { Button } from './ui/button';
import { Field, Input } from './ui/primitives';

/**
 * Links a WhatsApp number to an Evolution Go instance: QR code (refreshed while waiting) or a
 * pairing code typed on the phone. Calls `onConnected` once the instance reports a login.
 */
export function PairingPanel({ providerId, instanceId, onConnected }: { providerId: string; instanceId: string; onConnected: (phone: string | null) => void }) {
  const [mode, setMode] = useState<'qr' | 'code'>('qr');
  const state = useQuery({
    queryKey: ['pairing', providerId, instanceId],
    queryFn: () => api.get<PairingState>(`/api/providers/${providerId}/instances/${instanceId}/pairing`),
    refetchInterval: (q) => (q.state.data?.status === 'logged_in' ? false : 4000),
    refetchIntervalInBackground: false,
  });

  const fired = useRef(false);
  useEffect(() => {
    if (state.data?.status === 'logged_in' && !fired.current) {
      fired.current = true;
      onConnected(state.data.phone);
    }
  }, [state.data, onConnected]);

  const s = state.data;
  if (s?.status === 'logged_in') {
    return (
      <div className="flex items-center gap-2.5 rounded-md border border-ok/30 bg-ok/5 px-3 py-3 text-[13px]">
        <CircleCheck className="size-4 text-ok" />
        WhatsApp connected{s.phone ? ` (+${s.phone})` : ''}.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg p-4">
      <div className="mb-4 inline-flex rounded-md border border-border p-0.5 text-[13px]">
        <button type="button" onClick={() => setMode('qr')} className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${mode === 'qr' ? 'bg-raised font-medium' : 'text-muted'}`}>
          <QrCode className="size-3.5" />
          QR code
        </button>
        <button type="button" onClick={() => setMode('code')} className={`flex items-center gap-1.5 rounded px-2.5 py-1 ${mode === 'code' ? 'bg-raised font-medium' : 'text-muted'}`}>
          <Smartphone className="size-3.5" />
          Pairing code
        </button>
      </div>

      {mode === 'qr' ? (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <div className="flex size-56 shrink-0 items-center justify-center rounded-md bg-white p-2">
            {s?.status === 'qr' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.qr} alt="WhatsApp QR code" className="size-full [image-rendering:pixelated]" />
            ) : state.error ? (
              <p className="px-4 text-center text-xs text-bad">{errorText(state.error)}</p>
            ) : (
              <Loader2 className="size-5 animate-spin text-neutral-400" />
            )}
          </div>
          <ol className="list-decimal space-y-1.5 pl-4 text-[13px] text-muted">
            <li>Open WhatsApp on the phone with this number.</li>
            <li>Tap Settings, then Linked devices, then Link a device.</li>
            <li>Point the phone at this QR code.</li>
            {s?.status === 'passkey' && (
              <li className="list-none pt-2">
                <Button asChild size="sm">
                  <a href={s.openUrl} target="_blank" rel="noreferrer">
                    <ExternalLink />
                    Confirm with passkey on WhatsApp Web
                  </a>
                </Button>
              </li>
            )}
            <li className="list-none pt-2 text-xs text-faint">The code refreshes on its own. This screen closes when the phone connects.</li>
          </ol>
        </div>
      ) : (
        <PairingCodeForm providerId={providerId} instanceId={instanceId} />
      )}
    </div>
  );
}

function PairingCodeForm({ providerId, instanceId }: { providerId: string; instanceId: string }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  if (code) {
    return (
      <div className="text-center">
        <p className="font-mono text-3xl font-semibold tracking-[0.2em]">{code}</p>
        <p className="mt-3 text-[13px] text-muted">On the phone: Linked devices, Link a device, Link with phone number instead. Then type this code.</p>
      </div>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setLoading(true);
        setError(null);
        try {
          setCode((await api.post<{ code: string }>(`/api/providers/${providerId}/instances/${instanceId}/pair`, { phone })).code);
        } catch (err) {
          setError(err instanceof ApiRequestError && err.fields ? Object.values(err.fields)[0]! : errorText(err));
        } finally {
          setLoading(false);
        }
      }}
    >
      <Field label="Phone number" htmlFor="pair-phone" hint="With country and area code, like 5511987654321." error={error ?? undefined}>
        <Input id="pair-phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="5511987654321" />
      </Field>
      <Button type="submit" variant="primary" loading={loading} disabled={phone.replace(/\D/g, '').length < 10}>
        Get pairing code
      </Button>
    </form>
  );
}
