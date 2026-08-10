"use client";

import { type ButtonHTMLAttributes, type InputHTMLAttributes, forwardRef } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "ghost" | "danger" | "outline";
    size?: "sm" | "md";
  }
>(function Button({ variant = "primary", size = "md", className, ...props }, ref) {
  return (
    <button
      ref={ref}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer",
        size === "sm" ? "px-2.5 py-1.5 text-xs" : "px-3.5 py-2 text-sm",
        variant === "primary" &&
          "bg-accent text-white dark:text-zinc-900 hover:bg-accent-hover",
        variant === "ghost" && "text-foreground hover:bg-surface-2",
        variant === "outline" &&
          "border border-border-app text-foreground hover:bg-surface-2",
        variant === "danger" && "text-danger hover:bg-danger/10",
        className
      )}
      {...props}
    />
  );
});

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cx(
        "w-full rounded-lg border border-border-app bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20",
        className
      )}
      {...props}
    />
  );
});

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block size-4 animate-spin rounded-full border-2 border-muted border-t-transparent align-middle",
        className
      )}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "success" | "warn" | "danger" | "accent";
}) {
  const tones = {
    neutral: "bg-surface-2 text-muted",
    success: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    warn: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    danger: "bg-red-500/15 text-red-600 dark:text-red-400",
    accent: "bg-accent-soft text-accent-hover dark:text-accent",
  } as const;
  return (
    <span
      className={cx(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tones[tone]
      )}
    >
      {children}
    </span>
  );
}

export function threadsChanged() {
  window.dispatchEvent(new Event("tesseract:threads-changed"));
}

// Determinate when total is known; indeterminate sweep otherwise.
export function ProgressBar({
  phase,
  done,
  total,
}: {
  phase: string;
  done?: number | null;
  total?: number | null;
}) {
  const pct =
    total && total > 0 ? Math.min(100, Math.round(((done ?? 0) / total) * 100)) : null;
  return (
    <div className="mt-1 w-full max-w-64">
      <div className="flex items-center justify-between text-[11px] text-muted">
        <span className="truncate">{phase}</span>
        {pct !== null && (
          <span className="tabular-nums">
            {done}/{total}
          </span>
        )}
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        {pct !== null ? (
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${Math.max(pct, 3)}%` }}
          />
        ) : (
          <div className="h-full w-1/3 animate-[sweep_1.2s_ease-in-out_infinite] rounded-full bg-accent" />
        )}
      </div>
    </div>
  );
}
