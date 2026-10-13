import { CONNECTION_STATE_LABELS, type ConnectionState, type EventStatus, type ProviderStatus } from '@evobridge/shared';
import { cn } from '@/lib/utils';

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'idle';

const TONE_TEXT: Record<Tone, string> = { ok: 'text-ok', warn: 'text-warn', bad: 'text-bad', info: 'text-info', idle: 'text-idle' };
const TONE_BG: Record<Tone, string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', info: 'bg-info', idle: 'bg-idle' };

export const CONNECTION_TONE: Record<ConnectionState, Tone> = {
  connected: 'ok',
  degraded: 'warn',
  error: 'bad',
  disconnected: 'warn',
  configuring: 'info',
  paused: 'idle',
};

const PROVIDER: Record<ProviderStatus, { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Reachable' },
  unreachable: { tone: 'bad', label: 'Unreachable' },
  unauthorized: { tone: 'bad', label: 'Key rejected' },
  not_activated: { tone: 'warn', label: 'Not activated' },
  error: { tone: 'bad', label: 'Error' },
  unknown: { tone: 'idle', label: 'Not checked' },
};

const EVENT: Record<EventStatus, { tone: Tone; label: string }> = {
  received: { tone: 'info', label: 'Queued' },
  processed: { tone: 'ok', label: 'Processed' },
  ignored: { tone: 'idle', label: 'Ignored' },
  retrying: { tone: 'warn', label: 'Retrying' },
  failed: { tone: 'bad', label: 'Failed' },
  dead: { tone: 'bad', label: 'Failed' },
};

export function Dot({ tone, pulse, className }: { tone: Tone; pulse?: boolean; className?: string }) {
  return (
    <span className={cn('relative inline-flex size-2 shrink-0', className)}>
      {pulse && <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-40 motion-reduce:hidden', TONE_BG[tone])} />}
      <span className={cn('relative inline-flex size-2 rounded-full', TONE_BG[tone])} />
    </span>
  );
}

export function StatusText({ tone, label, pulse }: { tone: Tone; label: string; pulse?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs font-medium', TONE_TEXT[tone])}>
      <Dot tone={tone} pulse={pulse} />
      {label}
    </span>
  );
}

export function ConnectionStatus({ state }: { state: ConnectionState }) {
  return <StatusText tone={CONNECTION_TONE[state]} label={CONNECTION_STATE_LABELS[state]} pulse={state === 'configuring'} />;
}

export function ProviderStatusText({ status }: { status: ProviderStatus }) {
  const s = PROVIDER[status] ?? PROVIDER.unknown;
  return <StatusText tone={s.tone} label={s.label} />;
}

export function EventStatusText({ status }: { status: EventStatus }) {
  const s = EVENT[status];
  return <StatusText tone={s.tone} label={s.label} />;
}

export function toneClass(tone: Tone) {
  return TONE_TEXT[tone];
}
