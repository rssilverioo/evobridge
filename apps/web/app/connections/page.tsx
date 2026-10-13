'use client';

import { Cable, Plus } from 'lucide-react';
import Link from 'next/link';
import { PageHeader } from '@/components/app-shell';
import { ConnectionCard } from '@/components/connection-card';
import { EmptyState, ErrorState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/primitives';
import { errorText } from '@/lib/api';
import { useConnections } from '@/lib/queries';

export default function ConnectionsPage() {
  const { data, isLoading, error, refetch } = useConnections();
  const create = (
    <Button asChild variant="primary">
      <Link href="/connections/new">
        <Plus />
        Create connection
      </Link>
    </Button>
  );
  return (
    <>
      <PageHeader title="Connections" description="Each connection links one WhatsApp instance to one Chatwoot inbox." actions={data?.length ? create : undefined} />
      {error && <ErrorState message={errorText(error)} onRetry={() => void refetch()} />}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      ) : !data?.length ? (
        <EmptyState icon={<Cable />} title="No connections yet" description="Connect Evolution Go to Chatwoot in just a few steps." action={create} />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.map((c) => (
            <ConnectionCard key={c.id} connection={c} />
          ))}
        </div>
      )}
    </>
  );
}
