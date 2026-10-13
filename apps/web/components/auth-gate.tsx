'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_RULES, loginSchema, setupSchema } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Circle } from 'lucide-react';
import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import type { z } from 'zod';
import { ApiRequestError, api, setCsrfToken, setUnauthorizedHandler } from '@/lib/api';
import { BRAND } from '@/lib/brand';
import { keys, useAuthState } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { AppShell } from './app-shell';
import { LogoMark } from './logo';
import { OnboardingGate } from './onboarding';
import { Button } from './ui/button';
import { Field, Input, Skeleton } from './ui/primitives';

export function AuthGate({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useAuthState();

  useEffect(() => {
    if (data) setCsrfToken(data.csrfToken);
  }, [data]);
  useEffect(() => {
    setUnauthorizedHandler(() => void qc.invalidateQueries({ queryKey: keys.auth }));
  }, [qc]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen">
        <div className="hidden w-56 border-r border-border p-4 md:block">
          <Skeleton className="h-6 w-28" />
          <div className="mt-8 space-y-2">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="mt-6 h-40 w-full max-w-4xl" />
        </div>
      </div>
    );
  }
  if (error || !data) {
    return (
      <AuthFrame title="Can't reach EvoBridge" subtitle="The dashboard loaded, but the server didn't answer.">
        <Button variant="primary" className="w-full" onClick={() => void refetch()}>
          Try again
        </Button>
      </AuthFrame>
    );
  }
  if (data.setupRequired) return <SetupScreen />;
  if (!data.user) return <LoginScreen />;
  return (
    <OnboardingGate>
      <AppShell user={data.user} version={data.version}>
        {children}
      </AppShell>
    </OnboardingGate>
  );
}

function AuthFrame({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-2">
          <LogoMark />
          <span className="text-[15px] font-semibold">{BRAND.name}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[13px] text-muted">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </main>
  );
}

function useAuthSubmit() {
  const qc = useQueryClient();
  return async (path: string, body: unknown, setError: (field: string, message: string) => void) => {
    try {
      const res = await api.post<{ csrfToken: string }>(path, body);
      setCsrfToken(res.csrfToken);
      await qc.invalidateQueries({ queryKey: keys.auth });
    } catch (err) {
      if (err instanceof ApiRequestError && err.fields) {
        for (const [k, v] of Object.entries(err.fields)) setError(k, v);
      } else setError('root', err instanceof Error ? err.message : String(err));
    }
  };
}

function SetupScreen() {
  type Values = z.input<typeof setupSchema>;
  const form = useForm<Values>({ resolver: zodResolver(setupSchema), mode: 'onTouched', defaultValues: { name: '', email: '', password: '' } });
  const submit = useAuthSubmit();
  const password = form.watch('password') ?? '';
  const { errors, isSubmitting } = form.formState;
  return (
    <AuthFrame title="Create the administrator" subtitle="This account manages connections and credentials. You can only create it once.">
      <form
        className="space-y-4"
        onSubmit={form.handleSubmit((v) => submit('/api/auth/setup', v, (f, m) => form.setError(f as keyof Values, { message: m })))}
      >
        <Field label="Name" htmlFor="name" error={errors.name?.message}>
          <Input id="name" autoComplete="name" autoFocus invalid={Boolean(errors.name)} {...form.register('name')} />
        </Field>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" invalid={Boolean(errors.email)} {...form.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password">
          <Input id="password" type="password" autoComplete="new-password" invalid={Boolean(errors.password)} {...form.register('password')} />
          <ul className="mt-2 space-y-1">
            {PASSWORD_RULES.map((rule) => {
              const ok = rule.test(password);
              return (
                <li key={rule.id} className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-ok' : 'text-muted')}>
                  {ok ? <Check className="size-3" strokeWidth={3} /> : <Circle className="size-3" />}
                  {rule.label}
                </li>
              );
            })}
          </ul>
        </Field>
        {errors.root && <p className="text-xs text-bad">{errors.root.message}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
          Create account
        </Button>
      </form>
    </AuthFrame>
  );
}

function LoginScreen() {
  type Values = z.input<typeof loginSchema>;
  const form = useForm<Values>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });
  const submit = useAuthSubmit();
  const { errors, isSubmitting } = form.formState;
  return (
    <AuthFrame title="Sign in" subtitle={BRAND.tagline}>
      <form className="space-y-4" onSubmit={form.handleSubmit((v) => submit('/api/auth/login', v, (f, m) => form.setError(f as keyof Values, { message: m })))}>
        <Field label="Email" htmlFor="email" error={errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" autoFocus invalid={Boolean(errors.email)} {...form.register('email')} />
        </Field>
        <Field label="Password" htmlFor="password" error={errors.password?.message}>
          <Input id="password" type="password" autoComplete="current-password" invalid={Boolean(errors.password)} {...form.register('password')} />
        </Field>
        {errors.root && <p className="text-xs text-bad">{errors.root.message}</p>}
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={isSubmitting}>
          Sign in
        </Button>
      </form>
    </AuthFrame>
  );
}
