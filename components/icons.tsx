// Tiny inline icons that inherit currentColor — used in places where the ⚡
// emoji's color glyph clashes with a yellow background (e.g., .btn-bolt).
// Keep these path-only and dependency-free; lucide etc. is overkill here.

export function BoltIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className={`fill-current flex-shrink-0 ${className}`}
    >
      <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}
