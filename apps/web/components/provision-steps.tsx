'use client';

import { PROVISION_STEPS, PROVISION_STEP_LABELS, type ProvisionStep } from '@evobridge/shared';
import { CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleX, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

/** Ordered setup checklist. While a request runs, `running` animates the next unfinished step. */
export function ProvisionSteps({ steps, running }: { steps: ProvisionStep[] | null; running?: boolean }) {
  const byId = new Map((steps ?? []).map((s) => [s.id, s]));
  const firstOpen = PROVISION_STEPS.findIndex((id) => {
    const s = byId.get(id);
    return !s || s.status === 'pending' || s.status === 'running';
  });
  return (
    <ol className="space-y-0.5">
      {PROVISION_STEPS.map((id, i) => {
        const step = byId.get(id);
        const status = running && i === firstOpen ? 'running' : (step?.status ?? 'pending');
        return (
          <li key={id} className="flex gap-3 rounded-md px-2 py-2">
            <StepIcon status={status} />
            <div className="min-w-0 flex-1">
              <p className={cn('text-[13px]', status === 'pending' ? 'text-faint' : 'text-fg', status === 'running' && 'font-medium')}>{PROVISION_STEP_LABELS[id]}</p>
              {step?.message && status !== 'pending' && status !== 'running' && (
                <p className={cn('mt-0.5 text-xs', status === 'failed' ? 'text-bad' : status === 'action_required' ? 'text-warn' : 'text-muted')}>{step.message}</p>
              )}
              {step?.instructions?.length ? (
                <ul className="mt-1.5 space-y-1 rounded-md border border-border bg-raised px-3 py-2 text-xs text-muted">
                  {step.instructions.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function StepIcon({ status }: { status: ProvisionStep['status'] }) {
  const cls = 'mt-0.5 size-4 shrink-0';
  switch (status) {
    case 'done':
      return <CircleCheck className={cn(cls, 'text-ok')} />;
    case 'running':
      return <Loader2 className={cn(cls, 'animate-spin text-info')} />;
    case 'failed':
      return <CircleX className={cn(cls, 'text-bad')} />;
    case 'action_required':
      return <CircleAlert className={cn(cls, 'text-warn')} />;
    case 'skipped':
      return <CircleMinus className={cn(cls, 'text-faint')} />;
    default:
      return <CircleDashed className={cn(cls, 'text-faint')} />;
  }
}
