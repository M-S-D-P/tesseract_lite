"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button, Input } from "@/components/ui";

const MIN_LENGTH = 10;

export default function ChangePasswordPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [forced, setForced] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me").then(async (r) => {
      if (!r.ok) return router.push("/login");
      const d = await r.json();
      setEmail(d.user?.email ?? "");
      setForced(Boolean(d.user?.mustChangePassword));
    });
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (next !== confirm) return setError("The two new passwords do not match");
    if (next.length < MIN_LENGTH) {
      return setError(`Your new password must be at least ${MIN_LENGTH} characters`);
    }
    setBusy(true);
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    setBusy(false);
    if (!res.ok) return setError((await res.json()).error ?? "Could not change the password");
    setDone(true);
    setTimeout(() => router.push("/"), 900);
  };

  return (
    <main className="flex h-dvh items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2.5">
          <span className="tesseract-mark size-5 shrink-0" aria-hidden />
          <span className="brand-text text-lg font-bold tracking-tight">Tesseract</span>
        </div>

        <h1 className="text-xl font-semibold">
          {forced ? "Choose your own password" : "Change your password"}
        </h1>
        <p className="mt-1 text-sm text-muted">
          {forced
            ? "This account is still using the password it was set up with. Pick your own before continuing."
            : email}
        </p>

        {done ? (
          <p className="mt-6 rounded-lg bg-accent-soft px-3 py-2 text-sm text-accent">
            Password updated — taking you back.
          </p>
        ) : (
          <form onSubmit={submit} className="mt-6 flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">{forced ? "Password you were given" : "Current password"}</span>
              <Input
                type="password"
                value={current}
                onChange={(e) => setCurrent(e.target.value)}
                autoComplete="current-password"
                required
                autoFocus
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">New password</span>
              <Input
                type="password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
                autoComplete="new-password"
                minLength={MIN_LENGTH}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-muted">New password again</span>
              <Input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <p className="text-xs text-muted">At least {MIN_LENGTH} characters.</p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="mt-1">
              {busy ? "Saving…" : "Set new password"}
            </Button>
          </form>
        )}
      </div>
    </main>
  );
}
