'use client';

import type { ProviderDto, ProviderKind } from '@evobridge/shared';
import { Check } from 'lucide-react';
import { BRAND } from '@/lib/brand';
import { useProviders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { LogoMark } from './logo';
import { ProviderForm } from './provider-form';
import { Skeleton } from './ui/primitives';

const STEPS: Array<{ kind: ProviderKind; title: string; description: string }> = [
  {
    kind: 'evolution_go',
    title: 'Connect your Evolution Go',
    description: 'The server that runs your WhatsApp numbers. EvoBridge uses its global API key to list, create and pair instances.',
  },
  {
    kind: 'chatwoot',
    title: 'Connect your Chatwoot',
    description: 'Where your team answers. Use an administrator access token: EvoBridge creates inboxes and sets their webhooks.',
  },
];

/** First run, before the dashboard: one Evolution Go and one Chatwoot. More can be added later in Providers. */
export function OnboardingGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading } = useProviders();
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Skeleton className="h-72 w-full max-w-md" />
      </div>
    );
  }
  const has = (kind: ProviderKind) => (data ?? []).some((p: ProviderDto) => p.kind === kind);
  const current = STEPS.findIndex((s) => !has(s.kind));
  if (current === -1) return <>{children}</>;
  const step = STEPS[current]!;

  return (
    <main className="flex min-h-screen items-start justify-center px-4 py-12 sm:items-center">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-2">
          <LogoMark />
          <span className="text-[15px] font-semibold">{BRAND.name}</span>
        </div>
        <ol className="mb-6 flex items-center gap-2 text-[13px]">
          {STEPS.map((s, i) => (
            <li key={s.kind} className="flex items-center gap-2">
              <span
                className={cn(
                  'flex size-5 items-center justify-center rounded-full border text-[11px] font-medium',
                  i < current ? 'border-ok bg-ok text-bg' : i === current ? 'border-fg' : 'border-border-strong text-faint',
                )}
              >
                {i < current ? <Check className="size-3" strokeWidth={3} /> : i + 1}
              </span>
              <span className={i === current ? 'font-medium' : 'text-muted'}>{s.kind === 'evolution_go' ? 'Evolution Go' : 'Chatwoot'}</span>
              {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-border-strong" aria-hidden="true" />}
            </li>
          ))}
        </ol>
        <h1 className="text-xl font-semibold tracking-tight">{step.title}</h1>
        <p className="mt-1 text-[13px] text-muted">{step.description}</p>
        <div className="mt-6">
          <ProviderForm key={step.kind} kind={step.kind} submitLabel={current === STEPS.length - 1 ? 'Save and finish' : 'Save and continue'} onSaved={() => undefined} />
        </div>
      </div>
    </main>
  );
}
