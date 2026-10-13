'use client';

import type { SessionUser } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { BookOpen, Cable, ChevronsUpDown, LayoutGrid, LogOut, Menu as MenuIcon, Moon, ScrollText, Server, Settings, Sun, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { api, setCsrfToken } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { keys } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { GithubIcon } from './github-icon';
import { LogoMark } from './logo';
import { Button } from './ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui/overlay';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutGrid },
  { href: '/connections', label: 'Connections', icon: Cable },
  { href: '/providers', label: 'Providers', icon: Server },
  { href: '/events', label: 'Events & Logs', icon: ScrollText },
  { href: '/settings', label: 'Settings', icon: Settings },
];

export function AppShell({ user, version, children }: { user: SessionUser; version: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);

  return (
    <div className="flex min-h-screen">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-30 flex w-56 flex-col border-r border-border bg-bg transition-transform md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-12 items-center gap-2 px-4">
          <LogoMark />
          <span className="text-[14px] font-semibold tracking-tight">{BRAND.name}</span>
          <Button variant="ghost" size="icon-sm" className="ml-auto md:hidden" onClick={() => setOpen(false)} aria-label="Close menu">
            <X />
          </Button>
        </div>
        <nav className="mt-2 flex-1 space-y-0.5 px-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? pathname === '/' : pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={cn(
                  'flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors',
                  active ? 'bg-raised font-medium text-fg' : 'text-muted hover:bg-raised/60 hover:text-fg',
                )}
              >
                <Icon className="size-4" strokeWidth={1.75} />
                {label}
              </Link>
            );
          })}
        </nav>
        <div className="space-y-0.5 px-2 pb-2">
          <a href={BRAND.docsUrl} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-raised/60 hover:text-fg">
            <BookOpen className="size-4" strokeWidth={1.75} />
            Documentation
          </a>
          <a href={BRAND.repoUrl} target="_blank" rel="noreferrer" className="flex h-8 items-center gap-2.5 rounded-md px-2.5 text-[13px] text-muted hover:bg-raised/60 hover:text-fg">
            <GithubIcon className="size-4" />
            GitHub
          </a>
        </div>
        <div className="border-t border-border p-2">
          <UserMenu user={user} />
          <p className="px-2.5 pt-1.5 text-[11px] text-faint">v{version}</p>
        </div>
      </aside>
      {open && <button type="button" aria-label="Close menu" className="fixed inset-0 z-20 bg-black/40 md:hidden" onClick={() => setOpen(false)} />}
      <div className="flex min-w-0 flex-1 flex-col md:pl-56">
        <header className="flex h-12 items-center gap-2 border-b border-border px-4 md:hidden">
          <Button variant="ghost" size="icon-sm" onClick={() => setOpen(true)} aria-label="Open menu">
            <MenuIcon />
          </Button>
          <LogoMark className="size-4" />
          <span className="text-[13px] font-semibold">{BRAND.name}</span>
        </header>
        <main className="w-full max-w-[1120px] flex-1 px-4 py-6 md:px-8 md:py-8">{children}</main>
      </div>
    </div>
  );
}

function UserMenu({ user }: { user: SessionUser }) {
  const qc = useQueryClient();
  const { resolvedTheme, setTheme } = useTheme();
  const initials = user.name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-raised/60">
          <span className="flex size-6 items-center justify-center rounded-full bg-raised text-[10px] font-semibold text-muted">{initials}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium">{user.name}</span>
            <span className="block truncate text-[11px] text-faint">{user.email}</span>
          </span>
          <ChevronsUpDown className="size-3.5 text-faint" />
        </button>
      </MenuTrigger>
      <MenuContent align="start">
        <MenuItem onSelect={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}>
          {resolvedTheme === 'dark' ? <Sun /> : <Moon />}
          {resolvedTheme === 'dark' ? 'Light theme' : 'Dark theme'}
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          onSelect={async () => {
            await api.post('/api/auth/logout').catch(() => undefined);
            setCsrfToken(null);
            qc.clear();
            await qc.invalidateQueries({ queryKey: keys.auth });
          }}
        >
          <LogOut />
          Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-[13px] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}
