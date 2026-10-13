'use client';

import { PROVIDER_LABELS, type ProviderDto, type ProviderKind } from '@evobridge/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Ellipsis, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/app-shell';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { ProviderForm } from '@/components/provider-form';
import { ProviderStatusText } from '@/components/status';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/overlay';
import { Panel, Skeleton } from '@/components/ui/primitives';
import { api, errorText } from '@/lib/api';
import { keys, useProviders } from '@/lib/queries';
import { timeAgo } from '@/lib/utils';

export default function ProvidersPage() {
  const { data, isLoading, error, refetch } = useProviders();
  const [adding, setAdding] = useState<ProviderKind | null>(null);
  const [editing, setEditing] = useState<ProviderDto | null>(null);
  const [removing, setRemoving] = useState<ProviderDto | null>(null);
  const qc = useQueryClient();

  const groups: ProviderKind[] = ['evolution_go', 'chatwoot'];
  return (
    <>
      <PageHeader title="Providers" description="The Evolution Go and Chatwoot servers EvoBridge talks to. Keys are encrypted and never shown again." />
      {error && <ErrorState message={errorText(error)} onRetry={() => void refetch()} />}
      <div className="space-y-8">
        {groups.map((kind) => {
          const items = (data ?? []).filter((p) => p.kind === kind);
          return (
            <section key={kind}>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold text-muted">{PROVIDER_LABELS[kind]}</h2>
                <Button size="sm" onClick={() => setAdding(kind)}>
                  <Plus />
                  Add {PROVIDER_LABELS[kind]}
                </Button>
              </div>
              {isLoading ? (
                <Skeleton className="h-16" />
              ) : items.length === 0 ? (
                <EmptyState icon={<Server />} title={`No ${PROVIDER_LABELS[kind]} yet`} description="Add one here, or while creating a connection." />
              ) : (
                <Panel className="divide-y divide-border">
                  {items.map((p) => (
                    <ProviderRow key={p.id} p={p} onEdit={() => setEditing(p)} onRemove={() => setRemoving(p)} />
                  ))}
                </Panel>
              )}
            </section>
          );
        })}
      </div>

      <Dialog open={Boolean(adding)} onOpenChange={(o) => !o && setAdding(null)} title={adding ? `Add ${PROVIDER_LABELS[adding]}` : ''}>
        {adding && (
          <ProviderForm
            kind={adding}
            onSaved={() => {
              setAdding(null);
              toast.success('Provider saved');
            }}
          />
        )}
      </Dialog>
      <Dialog open={Boolean(editing)} onOpenChange={(o) => !o && setEditing(null)} title={editing ? `Edit ${editing.name}` : ''}>
        {editing && (
          <ProviderForm
            kind={editing.kind}
            existing={editing}
            onSaved={() => {
              setEditing(null);
              toast.success('Provider updated');
            }}
          />
        )}
      </Dialog>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name ?? ''}?`}
        description="EvoBridge forgets this server and its key. Nothing changes on the server itself."
        confirmLabel="Remove provider"
        onConfirm={async () => {
          if (!removing) return;
          try {
            await api.del(`/api/providers/${removing.id}`);
            await qc.invalidateQueries({ queryKey: keys.providers });
            toast.success('Provider removed');
          } catch (err) {
            toast.error(errorText(err));
          }
          setRemoving(null);
        }}
      />
    </>
  );
}

function ProviderRow({ p, onEdit, onRemove }: { p: ProviderDto; onEdit: () => void; onRemove: () => void }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{p.name}</p>
        <p className="truncate text-xs text-faint">
          {p.baseUrl} · key {p.secretPreview} · {p.connectionCount} connection{p.connectionCount === 1 ? '' : 's'}
        </p>
        {p.status !== 'ok' && p.statusMessage && <p className="mt-0.5 text-xs text-muted">{p.statusMessage}</p>}
      </div>
      <div className="text-right">
        <ProviderStatusText status={p.status} />
        <p className="text-[11px] text-faint">checked {timeAgo(p.lastCheckedAt)}</p>
      </div>
      <Menu>
        <MenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Provider actions" loading={checking}>
            {!checking && <Ellipsis />}
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem
            onSelect={async () => {
              setChecking(true);
              try {
                const res = await api.post<{ ok: boolean; message: string }>(`/api/providers/${p.id}/check`);
                if (res.ok) toast.success(res.message);
                else toast.error(res.message);
              } catch (err) {
                toast.error(errorText(err));
              }
              await qc.invalidateQueries({ queryKey: keys.providers });
              setChecking(false);
            }}
          >
            <RefreshCw />
            Test connection
          </MenuItem>
          <MenuItem onSelect={onEdit}>
            <Pencil />
            Edit
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger disabled={p.connectionCount > 0} onSelect={onRemove}>
            <Trash2 />
            {p.connectionCount > 0 ? 'In use by connections' : 'Remove'}
          </MenuItem>
        </MenuContent>
      </Menu>
    </div>
  );
}
