import { cn } from '@/lib/utils';

/** Two endpoints joined by a span: the bridge. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={cn('size-5', className)} aria-hidden="true">
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" className="fill-fg" />
      <circle cx="7" cy="14.5" r="2.25" className="fill-bg" />
      <circle cx="17" cy="14.5" r="2.25" className="fill-bg" />
      <path d="M7 14.5C7 9.5 17 9.5 17 14.5" className="stroke-bg" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}
