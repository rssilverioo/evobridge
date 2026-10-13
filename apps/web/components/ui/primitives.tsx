'use client';

import { Check, Copy } from 'lucide-react';
import { Checkbox as RCheckbox, Label as RLabel, Switch as RSwitch, Tooltip as RTooltip } from 'radix-ui';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }>(
  ({ className, invalid, ...props }, ref) => (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(
        'h-8 w-full rounded-md border border-border-strong bg-bg px-2.5 text-[13px] text-fg placeholder:text-faint outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60 aria-invalid:border-bad',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

export function Label({ className, ...props }: React.ComponentProps<typeof RLabel.Root>) {
  return <RLabel.Root className={cn('text-[13px] font-medium text-fg', className)} {...props} />;
}

export function Field({ label, htmlFor, hint, error, children, optional }: { label: string; htmlFor: string; hint?: React.ReactNode; error?: string; children: React.ReactNode; optional?: boolean }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>
        {label}
        {optional && <span className="ml-1 font-normal text-faint">optional</span>}
      </Label>
      {children}
      {error ? <p className="text-xs text-bad">{error}</p> : hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Switch({ className, ...props }: React.ComponentProps<typeof RSwitch.Root>) {
  return (
    <RSwitch.Root
      className={cn(
        'inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-raised transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RSwitch.Thumb className="block size-3 translate-x-0.5 rounded-full bg-fg shadow transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-accent-fg" />
    </RSwitch.Root>
  );
}

export function Checkbox({ className, ...props }: React.ComponentProps<typeof RCheckbox.Root>) {
  return (
    <RCheckbox.Root
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-bg data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg',
        className,
      )}
      {...props}
    >
      <RCheckbox.Indicator>
        <Check className="size-3" strokeWidth={3} />
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-raised', className)} />;
}

export function Tooltip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <RTooltip.Provider delayDuration={300}>
      <RTooltip.Root>
        <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
        <RTooltip.Portal>
          <RTooltip.Content sideOffset={6} className="z-50 max-w-xs rounded-md border border-border bg-raised px-2 py-1 text-xs text-fg shadow-lg">
            {content}
          </RTooltip.Content>
        </RTooltip.Portal>
      </RTooltip.Root>
    </RTooltip.Provider>
  );
}

/** Technical id with a copy button. */
export function CopyValue({ value, display, className }: { value: string; display?: string; className?: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={cn('group inline-flex max-w-full items-center gap-1 rounded px-1 font-mono text-xs text-muted hover:bg-raised hover:text-fg', className)}
      title="Copy"
    >
      <span className="truncate">{display ?? value}</span>
      {copied ? <Check className="size-3 shrink-0 text-ok" /> : <Copy className="size-3 shrink-0 opacity-0 group-hover:opacity-100" />}
    </button>
  );
}

export function Panel({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-lg border border-border bg-surface', className)} {...props}>
      {children}
    </div>
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-border-strong bg-raised px-1 font-mono text-[11px] text-muted">{children}</kbd>;
}
