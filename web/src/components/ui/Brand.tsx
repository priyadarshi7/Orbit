export function Brand({ className = "" }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-display text-[19px] font-extrabold leading-none tracking-tight ${className}`}>
      <svg viewBox="0 0 24 24" aria-hidden className="size-5">
        <circle cx="12" cy="12" r="3.2" fill="currentColor" />
        <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeOpacity=".45" strokeWidth="1.5" />
      </svg>
      Orbit
    </span>
  );
}
