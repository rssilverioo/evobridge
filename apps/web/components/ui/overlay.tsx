'use client';

import { X } from 'lucide-react';
import { AlertDialog as RAlert, Dialog as RDialog, DropdownMenu as RMenu, Select as RSelect } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import * as React from 'react';
import { cn } from '@/lib/utils';
import { Button } from './button';

const overlay = 'fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px]';
const content =
  'fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-border bg-surface shadow-2xl outline-none';

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: string;
}) {
  return (
    <RDialog.Root open={open} onOpenChange={onOpenChange}>
      <RDialog.Portal>
        <RDialog.Overlay className={overlay} />
        <RDialog.Content className={cn(content, width)}>
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div>
              <RDialog.Title className="text-[15px] font-semibold">{title}</RDialog.Title>
              {description ? (
                <RDialog.Description className="mt-0.5 text-[13px] text-muted">{description}</RDialog.Description>
              ) : (
                <RDialog.Description className="sr-only">{title}</RDialog.Description>
              )}
            </div>
            <RDialog.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </RDialog.Close>
          </div>
          {children && <div className="max-h-[65vh] overflow-y-auto px-5 py-4">{children}</div>}
          {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}

/** Confirmation for destructive operations. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  onConfirm,
  loading,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  loading?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <RAlert.Root open={open} onOpenChange={onOpenChange}>
      <RAlert.Portal>
        <RAlert.Overlay className={overlay} />
        <RAlert.Content className={cn(content, 'max-w-md p-5')}>
          <RAlert.Title className="text-[15px] font-semibold">{title}</RAlert.Title>
          <RAlert.Description className="mt-1.5 text-[13px] text-muted">{description}</RAlert.Description>
          {children && <div className="mt-4">{children}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <RAlert.Cancel asChild>
              <Button variant="secondary">Cancel</Button>
            </RAlert.Cancel>
            <Button variant="danger" loading={loading} onClick={onConfirm}>
              {confirmLabel}
            </Button>
          </div>
        </RAlert.Content>
      </RAlert.Portal>
    </RAlert.Root>
  );
}

export const Menu = RMenu.Root;
export const MenuTrigger = RMenu.Trigger;

export function MenuContent({ children, align = 'end' }: { children: React.ReactNode; align?: 'start' | 'end' }) {
  return (
    <RMenu.Portal>
      <RMenu.Content align={align} sideOffset={4} className="z-50 min-w-44 rounded-md border border-border bg-surface p-1 shadow-xl">
        {children}
      </RMenu.Content>
    </RMenu.Portal>
  );
}

export function MenuItem({ children, onSelect, danger, disabled }: { children: React.ReactNode; onSelect?: () => void; danger?: boolean; disabled?: boolean }) {
  return (
    <RMenu.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-raised data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:text-muted',
        danger && 'text-bad [&_svg]:text-bad',
      )}
    >
      {children}
    </RMenu.Item>
  );
}

export function MenuSeparator() {
  return <RMenu.Separator className="my-1 h-px bg-border" />;
}

export function Select({
  value,
  onValueChange,
  placeholder,
  items,
  id,
  disabled,
  invalid,
}: {
  value: string | undefined;
  onValueChange: (v: string) => void;
  placeholder: string;
  items: Array<{ value: string; label: React.ReactNode; disabled?: boolean; hint?: string }>;
  id?: string;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <RSelect.Root value={value} onValueChange={onValueChange} disabled={disabled}>
      <RSelect.Trigger
        id={id}
        aria-invalid={invalid || undefined}
        className="flex h-8 w-full items-center justify-between gap-2 rounded-md border border-border-strong bg-bg px-2.5 text-left text-[13px] outline-none focus:border-accent focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-60 aria-invalid:border-bad data-[placeholder]:text-faint"
      >
        <RSelect.Value placeholder={placeholder} />
        <RSelect.Icon>
          <ChevronDown className="size-3.5 text-muted" />
        </RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content position="popper" sideOffset={4} className="z-50 max-h-72 w-[var(--radix-select-trigger-width)] overflow-hidden rounded-md border border-border bg-surface shadow-xl">
          <RSelect.Viewport className="p-1">
            {items.map((item) => (
              <RSelect.Item
                key={item.value}
                value={item.value}
                disabled={item.disabled}
                className="relative flex cursor-pointer select-none items-center rounded-sm py-1.5 pl-7 pr-2 text-[13px] outline-none data-[disabled]:cursor-not-allowed data-[highlighted]:bg-raised data-[disabled]:opacity-50"
              >
                <RSelect.ItemIndicator className="absolute left-2">
                  <Check className="size-3.5" />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{item.label}</RSelect.ItemText>
                {item.hint && <span className="ml-auto pl-3 text-xs text-faint">{item.hint}</span>}
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}
