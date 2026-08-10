"use client";

import { Box } from "lucide-react";

export function AuthCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-app bg-surface p-8 shadow-sm">
        <div className="mb-6 flex flex-col items-center gap-2">
          <Box className="size-8 text-accent" strokeWidth={1.8} />
          <h1 className="text-lg font-semibold">{title}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
