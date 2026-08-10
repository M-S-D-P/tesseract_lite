"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import {
  Activity,
  Layers,
  LogOut,
  MessageSquare,
  Moon,
  Shield,
  SlidersHorizontal,
  SunMedium,
} from "lucide-react";
import { cx } from "./ui";

// The single app header: brand, nav, theme, session. Chat passes its thread
// switcher through `center`; other pages show their title there.
export default function TopBar({ center }: { center?: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const [me, setMe] = useState<{ email: string; role: string } | null>(null);
  const [orgName, setOrgName] = useState("");
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    fetch("/api/auth/me").then(async (r) => {
      if (!r.ok) return router.push("/login");
      const d = await r.json();
      setMe(d.user);
      setOrgName(d.org?.name ?? "");
    });
  }, [router]);

  const navItem = (href: string, icon: React.ReactNode, label: string) => (
    <Link
      href={href}
      className={cx(
        "rounded-lg p-2 hover:bg-surface-2",
        pathname === href || (href !== "/" && pathname.startsWith(href))
          ? "text-accent"
          : "text-muted hover:text-foreground"
      )}
      title={label}
    >
      {icon}
    </Link>
  );

  return (
    <header className="glass z-20 flex h-12 shrink-0 items-center gap-3 border-b border-border-app px-4">
      <Link href="/" className="flex items-center gap-2.5">
        <span className="tesseract-mark size-4 shrink-0" aria-hidden />
        <span className="brand-text text-[15px] font-bold tracking-tight">Tesseract</span>
      </Link>
      {orgName && <span className="hidden text-xs text-muted sm:inline">/ {orgName}</span>}

      <div className="mx-auto min-w-0">{center}</div>

      <nav className="flex items-center gap-0.5">
        {navItem("/", <MessageSquare className="size-4" />, "Chat")}
        {navItem("/facets", <Layers className="size-4" />, "Facets")}
        {/* Pipeline, tuning and admin are operator surfaces — members get
            chat and facets only. */}
        {me?.role === "admin" && (
          <>
            {navItem("/pipeline", <Activity className="size-4" />, "Pipeline")}
            {navItem("/tuning", <SlidersHorizontal className="size-4" />, "Tuning & evaluation")}
            {navItem("/admin", <Shield className="size-4" />, "Admin")}
          </>
        )}
        {mounted && (
          <button
            onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
            className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
            title="Toggle theme"
          >
            {resolvedTheme === "dark" ? <SunMedium className="size-4" /> : <Moon className="size-4" />}
          </button>
        )}
        <button
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.push("/login");
          }}
          className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-danger cursor-pointer"
          title={me?.email ?? "Log out"}
        >
          <LogOut className="size-4" />
        </button>
      </nav>
    </header>
  );
}

// Standard page wrapper for non-chat pages: top bar + scrollable content.
export function PageShell({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <TopBar
        center={
          title ? <span className="truncate text-sm text-muted">{title}</span> : undefined
        }
      />
      <main className="z-10 min-h-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
