import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode } from "react";

const base =
  "inline-flex items-center gap-2 rounded-lg text-[13.5px] font-medium transition-colors disabled:cursor-default disabled:opacity-40";

const variants = {
  outline: "h-[34px] border border-line-strong bg-surface px-3 text-fg shadow-card hover:bg-hover",
  ghost: "h-8 px-2 text-faint hover:bg-hover hover:text-fg",
  primary: "h-[34px] bg-primary px-3 text-primary-fg hover:opacity-90",
} as const;

type Variant = keyof typeof variants;

export function Button({ variant = "outline", className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return <button {...p} className={`${base} ${variants[variant]} ${className}`} />;
}

export function LinkButton({ variant = "outline", className = "", ...p }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...p} className={`${base} no-underline ${variants[variant]} ${className}`} />;
}

export function IconButton({ label, children, className = "", ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={`inline-grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg ${className}`}
    >
      {children}
    </button>
  );
}
