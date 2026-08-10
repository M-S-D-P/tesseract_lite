"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button, Input } from "@/components/ui";
import { AuthCard } from "@/components/AuthCard";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(searchParams.get("error") ?? "");
  const [busy, setBusy] = useState(false);
  const [msSso, setMsSso] = useState(false);

  useEffect(() => {
    fetch("/api/auth/setup").then(async (r) => {
      const { needsSetup } = await r.json();
      if (needsSetup) router.replace("/setup");
    });
    // The /me endpoint reports whether Microsoft SSO env vars are present.
    fetch("/api/auth/me").then(async (r) => {
      if (r.ok) {
        router.replace("/");
      } else {
        try {
          const d = await r.json();
          if (typeof d.microsoftSso === "boolean") setMsSso(d.microsoftSso);
        } catch {
          /* ignore */
        }
      }
    });
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (res.ok) router.push("/");
    else setError((await res.json()).error ?? "Sign-in failed");
  };

  return (
    <AuthCard title="Sign in to Tesseract">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          required
        />
        <Input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <a
        href="/api/auth/microsoft"
        className="mt-3 flex items-center justify-center gap-2 rounded-lg border border-border-app px-3.5 py-2 text-sm font-medium hover:bg-surface-2"
      >
        <MicrosoftLogo /> Sign in with Microsoft
      </a>
      {!msSso && (
        <p className="mt-2 text-center text-xs text-muted">
          Microsoft SSO requires MS_TENANT_ID / MS_CLIENT_ID / MS_CLIENT_SECRET in .env.local
        </p>
      )}
      <p className="mt-4 text-center text-xs text-muted">
        New here?{" "}
        <a href="/signup" className="text-accent hover:underline">
          Create an organization
        </a>
      </p>
    </AuthCard>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function MicrosoftLogo() {
  return (
    <svg width="15" height="15" viewBox="0 0 21 21" aria-hidden>
      <rect x="1" y="1" width="9" height="9" fill="#f25022" />
      <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
      <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
