'use client';

import type {
  AuthState,
  ChatwootAccountDto,
  ChatwootInboxDto,
  ConnectionDto,
  EventPage,
  EvolutionInstanceDto,
  OverviewDto,
  ProviderDto,
  SettingsDto,
  SystemInfoDto,
} from '@evobridge/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export const keys = {
  auth: ['auth'] as const,
  overview: ['overview'] as const,
  providers: ['providers'] as const,
  connections: ['connections'] as const,
  connection: (id: string) => ['connections', id] as const,
  instances: (providerId: string) => ['providers', providerId, 'instances'] as const,
  accounts: (providerId: string) => ['providers', providerId, 'accounts'] as const,
  inboxes: (providerId: string, accountId: number) => ['providers', providerId, 'accounts', accountId, 'inboxes'] as const,
  events: (q: string) => ['events', q] as const,
  settings: ['settings'] as const,
  system: ['system'] as const,
};

export type AuthStateResponse = AuthState & { csrfToken: string | null };

export const useAuthState = () => useQuery({ queryKey: keys.auth, queryFn: () => api.get<AuthStateResponse>('/api/auth/state'), staleTime: Infinity });
export const useOverview = () => useQuery({ queryKey: keys.overview, queryFn: () => api.get<OverviewDto>('/api/overview'), refetchInterval: 10_000 });
export const useProviders = () => useQuery({ queryKey: keys.providers, queryFn: () => api.get<ProviderDto[]>('/api/providers'), refetchInterval: 30_000 });
export const useConnections = () => useQuery({ queryKey: keys.connections, queryFn: () => api.get<ConnectionDto[]>('/api/connections'), refetchInterval: 10_000 });
export const useConnection = (id: string | null) =>
  useQuery({ queryKey: keys.connection(id ?? ''), queryFn: () => api.get<ConnectionDto>(`/api/connections/${id}`), enabled: Boolean(id), refetchInterval: 10_000 });
export const useInstances = (providerId: string | undefined) =>
  useQuery({ queryKey: keys.instances(providerId ?? ''), queryFn: () => api.get<EvolutionInstanceDto[]>(`/api/providers/${providerId}/instances`), enabled: Boolean(providerId) });
export const useAccounts = (providerId: string | undefined) =>
  useQuery({ queryKey: keys.accounts(providerId ?? ''), queryFn: () => api.get<ChatwootAccountDto[]>(`/api/providers/${providerId}/accounts`), enabled: Boolean(providerId) });
export const useInboxes = (providerId: string | undefined, accountId: number | undefined) =>
  useQuery({
    queryKey: keys.inboxes(providerId ?? '', accountId ?? 0),
    queryFn: () => api.get<ChatwootInboxDto[]>(`/api/providers/${providerId}/accounts/${accountId}/inboxes`),
    enabled: Boolean(providerId && accountId),
  });
export const useEvents = (params: URLSearchParams, live: boolean) => {
  const q = params.toString();
  return useQuery({ queryKey: keys.events(q), queryFn: () => api.get<EventPage>(`/api/events?${q}`), refetchInterval: live ? 5_000 : false });
};
export const useSettings = () => useQuery({ queryKey: keys.settings, queryFn: () => api.get<SettingsDto>('/api/settings') });
export const useSystem = () => useQuery({ queryKey: keys.system, queryFn: () => api.get<SystemInfoDto>('/api/system') });
