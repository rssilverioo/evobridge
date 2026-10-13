import { Panel } from './ui/primitives';

export function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description: string; action?: React.ReactNode }) {
  return (
    <Panel className="flex flex-col items-center px-6 py-14 text-center">
      <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-raised text-muted [&_svg]:size-4.5">{icon}</span>
      <h2 className="mt-4 text-[15px] font-semibold">{title}</h2>
      <p className="mt-1 max-w-sm text-[13px] text-muted">{description}</p>
      {action && <div className="mt-5">{action}</div>}
    </Panel>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Panel className="flex items-center justify-between gap-4 border-bad/40 px-4 py-3">
      <p className="text-[13px] text-bad">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="text-[13px] font-medium text-fg hover:underline">
          Retry
        </button>
      )}
    </Panel>
  );
}
