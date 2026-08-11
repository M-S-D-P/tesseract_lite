"use client";

import { useCallback, useEffect, useState } from "react";
import { Copy, Plug, Settings2, Trash2, UserPlus, Users } from "lucide-react";
import { PageShell } from "@/components/TopBar";
import { Badge, Button, Input, cx } from "@/components/ui";

type Tab = "users" | "mcp" | "settings";

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("users");
  return (
    <PageShell title="Administration">
      <div className="mx-auto max-w-4xl px-6 py-8 h-full overflow-y-auto">
        <h1 className="text-xl font-semibold">Administration</h1>
        <div className="mt-4 flex gap-1 border-b border-border-app">
          <TabButton active={tab === "users"} onClick={() => setTab("users")} icon={<Users className="size-4" />}>
            Users & invites
          </TabButton>
          <TabButton active={tab === "mcp"} onClick={() => setTab("mcp")} icon={<Plug className="size-4" />}>
            MCP servers
          </TabButton>
          <TabButton active={tab === "settings"} onClick={() => setTab("settings")} icon={<Settings2 className="size-4" />}>
            Settings
          </TabButton>
        </div>
        <div className="py-6">
          {tab === "users" && <UsersTab />}
          {tab === "mcp" && <McpTab />}
          {tab === "settings" && <SettingsTab />}
        </div>
      </div>
    </PageShell>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cx(
        "-mb-px flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium cursor-pointer",
        active
          ? "border-accent text-foreground"
          : "border-transparent text-muted hover:text-foreground"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ---------- Users & invites ----------

type UserRow = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  auth_provider: string;
  must_change_password: number;
};
type InviteRow = {
  id: string;
  email: string;
  role: string;
  token: string;
  expires_at: string;
  accepted_at: string | null;
};

function UsersTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [lastInviteUrl, setLastInviteUrl] = useState("");
  const [error, setError] = useState("");
  // Shown once, right after a reset — the plaintext is never stored.
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/users");
    if (res.ok) {
      const data = await res.json();
      setUsers(data.users);
      setInvites(data.invites);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, role }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Invite failed");
      return;
    }
    setLastInviteUrl(data.inviteUrl);
    setEmail("");
    load();
  };

  const patchUser = async (id: string, body: Record<string, string>) => {
    const res = await fetch(`/api/admin/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) alert((await res.json()).error);
    load();
  };

  const resetPassword = async (u: UserRow) => {
    if (
      !confirm(
        `Issue a new temporary password for ${u.email}?\n\nTheir current password stops working immediately, and they must set their own the next time they sign in.`
      )
    ) {
      return;
    }
    const res = await fetch(`/api/admin/users/${u.id}/password`, { method: "POST" });
    const data = await res.json();
    if (!res.ok) return alert(data.error ?? "Could not reset the password");
    setIssued(data);
    load();
  };

  const inviteUrlFor = (token: string) =>
    `${window.location.origin}/invite/${token}`;

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
        <Input
          type="email"
          required
          placeholder="teammate@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="max-w-xs"
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          className="rounded-lg border border-border-app bg-surface px-2.5 py-2 text-sm"
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <Button type="submit">
          <UserPlus className="size-4" /> Create invite link
        </Button>
        {error && <span className="text-sm text-danger">{error}</span>}
      </form>
      {lastInviteUrl && (
        <div className="flex items-center gap-2 rounded-lg border border-border-app bg-surface-2 px-3 py-2 text-sm">
          <span className="truncate">{lastInviteUrl}</span>
          <button
            onClick={() => navigator.clipboard.writeText(lastInviteUrl)}
            className="shrink-0 rounded p-1 text-muted hover:text-foreground cursor-pointer"
            aria-label="Copy invite link"
          >
            <Copy className="size-4" />
          </button>
        </div>
      )}

      {issued && (
        <div className="rounded-xl border border-accent bg-accent-soft px-4 py-3 text-sm">
          <div className="font-medium">Temporary password for {issued.email}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <code className="rounded bg-surface px-2 py-1 font-mono text-base tracking-wide">
              {issued.password}
            </code>
            <button
              onClick={() => navigator.clipboard.writeText(issued.password)}
              className="rounded p-1 text-muted hover:text-foreground cursor-pointer"
              aria-label="Copy password"
            >
              <Copy className="size-4" />
            </button>
            <button
              onClick={() => setIssued(null)}
              className="ml-auto text-xs text-muted hover:text-foreground cursor-pointer"
            >
              Dismiss
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">
            Shown once — it is not stored anywhere in readable form. Hand it over
            through a channel you trust; they will be made to replace it on their
            next sign-in.
          </p>
        </div>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Users</h2>
        <div className="overflow-hidden rounded-xl border border-border-app">
          <table className="w-full text-sm">
            <tbody className="bg-surface">
              {users.map((u) => (
                <tr key={u.id} className="border-b border-border-app last:border-0">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{u.name || u.email}</div>
                    <div className="text-xs text-muted">{u.email}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={u.role === "admin" ? "accent" : "neutral"}>{u.role}</Badge>{" "}
                    {u.status !== "active" && <Badge tone="danger">disabled</Badge>}{" "}
                    {u.auth_provider === "microsoft" && <Badge tone="neutral">SSO</Badge>}{" "}
                    {u.must_change_password === 1 && (
                      <Badge tone="warn">password not set yet</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-right text-xs">
                    <button
                      onClick={() =>
                        patchUser(u.id, { role: u.role === "admin" ? "member" : "admin" })
                      }
                      className="mr-3 text-muted hover:text-foreground cursor-pointer"
                    >
                      {u.role === "admin" ? "Make member" : "Make admin"}
                    </button>
                    {u.auth_provider === "password" && (
                      <button
                        onClick={() => resetPassword(u)}
                        className="mr-3 text-muted hover:text-foreground cursor-pointer"
                      >
                        Reset password
                      </button>
                    )}
                    <button
                      onClick={() =>
                        patchUser(u.id, {
                          status: u.status === "active" ? "disabled" : "active",
                        })
                      }
                      className="text-muted hover:text-danger cursor-pointer"
                    >
                      {u.status === "active" ? "Disable" : "Enable"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {invites.filter((i) => !i.accepted_at).length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold">Pending invites</h2>
          <div className="overflow-hidden rounded-xl border border-border-app">
            <table className="w-full text-sm">
              <tbody className="bg-surface">
                {invites
                  .filter((i) => !i.accepted_at)
                  .map((i) => (
                    <tr key={i.id} className="border-b border-border-app last:border-0">
                      <td className="px-4 py-2.5">{i.email}</td>
                      <td className="px-4 py-2.5">
                        <Badge>{i.role}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-muted">
                        expires {new Date(i.expires_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <button
                          onClick={() => navigator.clipboard.writeText(inviteUrlFor(i.token))}
                          className="mr-2 rounded p-1 text-muted hover:text-foreground cursor-pointer"
                          aria-label="Copy invite link"
                        >
                          <Copy className="size-4" />
                        </button>
                        <button
                          onClick={async () => {
                            await fetch(`/api/admin/users/${i.id}?invite=1`, { method: "DELETE" });
                            load();
                          }}
                          className="rounded p-1 text-muted hover:text-danger cursor-pointer"
                          aria-label="Revoke invite"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

// ---------- MCP servers ----------

type McpRow = {
  id: string;
  name: string;
  url: string;
  description: string | null;
  enabled: number;
};

function McpTab() {
  const [servers, setServers] = useState<McpRow[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [headerKey, setHeaderKey] = useState("");
  const [headerValue, setHeaderValue] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/mcp");
    if (res.ok) setServers((await res.json()).servers);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    const headers: Record<string, string> = {};
    if (headerKey.trim() && headerValue.trim()) headers[headerKey.trim()] = headerValue.trim();
    const res = await fetch("/api/admin/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, url, headers }),
    });
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to add server");
      return;
    }
    setName("");
    setUrl("");
    setHeaderKey("");
    setHeaderValue("");
    load();
  };

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={add} className="flex flex-col gap-2 rounded-xl border border-border-app bg-surface p-4">
        <div className="text-sm font-semibold">Connect an MCP server</div>
        <p className="text-xs text-muted">
          Remote MCP servers (Streamable HTTP) are attached as tools on every chat
          request — e.g. Atlassian/Confluence, GitHub, or an internal AppMap server.
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          <Input placeholder="Name (e.g. Confluence)" value={name} onChange={(e) => setName(e.target.value)} className="max-w-45" required />
          <Input placeholder="https://mcp.example.com/mcp" value={url} onChange={(e) => setUrl(e.target.value)} className="flex-1 min-w-60" required />
        </div>
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Auth header name (optional)" value={headerKey} onChange={(e) => setHeaderKey(e.target.value)} className="max-w-56" />
          <Input placeholder="Header value" value={headerValue} onChange={(e) => setHeaderValue(e.target.value)} className="flex-1 min-w-60" type="password" />
        </div>
        <div className="flex items-center gap-3">
          <Button type="submit" className="self-start">
            <Plug className="size-4" /> Add server
          </Button>
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
      </form>

      <div className="flex flex-col gap-2">
        {servers.map((s) => (
          <div
            key={s.id}
            className="flex items-center gap-3 rounded-xl border border-border-app bg-surface px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <Badge tone={s.enabled ? "success" : "neutral"}>
                  {s.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
              <div className="truncate text-xs text-muted">{s.url}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                await fetch(`/api/admin/mcp/${s.id}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ enabled: !s.enabled }),
                });
                load();
              }}
            >
              {s.enabled ? "Disable" : "Enable"}
            </Button>
            <button
              onClick={async () => {
                if (!confirm(`Remove MCP server "${s.name}"?`)) return;
                await fetch(`/api/admin/mcp/${s.id}`, { method: "DELETE" });
                load();
              }}
              className="rounded p-1.5 text-muted hover:text-danger cursor-pointer"
              aria-label="Delete server"
            >
              <Trash2 className="size-4" />
            </button>
          </div>
        ))}
        {servers.length === 0 && (
          <p className="text-sm text-muted">No MCP servers connected yet.</p>
        )}
      </div>
    </div>
  );
}

// ---------- Settings ----------

function SettingsTab() {
  const [settings, setSettings] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [providers, setProviders] = useState<Record<string, boolean> | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [confluenceTest, setConfluenceTest] = useState<{
    connected: boolean;
    user?: string;
    error?: string;
  } | null>(null);
  const [testingConfluence, setTestingConfluence] = useState(false);
  const [githubTest, setGithubTest] = useState<{
    configured: boolean;
    connected?: boolean;
    login?: string | null;
    warning?: string | null;
    error?: string;
    message?: string;
  } | null>(null);
  const [testingGithub, setTestingGithub] = useState(false);

  const refreshModels = async () => {
    setRefreshing(true);
    setModelsError("");
    const res = await fetch("/api/admin/models");
    setRefreshing(false);
    if (res.ok) {
      const d = await res.json();
      setModels(d.models);
      setProviders(d.providers ?? null);
    } else setModelsError((await res.json()).error ?? "Could not fetch models");
  };

  useEffect(() => {
    fetch("/api/admin/settings").then(async (r) => {
      if (r.ok) setSettings((await r.json()).settings);
    });
  }, []);

  if (!settings) return null;

  const update = (key: string, value: string) =>
    setSettings((s) => ({ ...s!, [key]: value }));

  const save = async () => {
    setSaving(true);
    setSaved(false);
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    if (res.ok) {
      setSettings((await res.json()).settings);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  return (
    <div className="flex max-w-xl flex-col gap-6">
      <section className="rounded-xl border border-border-app bg-surface p-4">
        <h2 className="text-sm font-semibold">Embedding provider</h2>
        <p className="mt-1 text-xs text-muted">
          Chat is always Claude. Embeddings are separate: Anthropic has no
          embeddings API, so retrieval runs either on a model bundled with this
          install or on OpenAI.
        </p>
        <div className="mt-3 flex gap-2">
          {(["local", "openai"] as const).map((p) => (
            <button
              key={p}
              onClick={() => update("embedding_provider", p)}
              className={cx(
                "flex-1 rounded-xl border px-4 py-3 text-left cursor-pointer",
                settings.embedding_provider === p
                  ? "border-accent bg-accent-soft"
                  : "border-border-app hover:bg-surface-2"
              )}
            >
              <div className="text-sm font-medium">
                {p === "local" ? "Local (on this server)" : "OpenAI"}
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {p === "local"
                  ? "all-MiniLM-L6-v2 · 384-dim · no vendor key, nothing leaves the box"
                  : "text-embedding-3-small · 1536-dim · needs OPENAI_API_KEY"}
              </div>
            </button>
          ))}
        </div>
        {settings.embedding_provider === "openai" && !providers?.openaiEmbeddings && (
          <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-danger">
            OPENAI_API_KEY is not set on this server — ingestion and search will
            fail until you add it or switch back to the local embedder.
          </p>
        )}
        <p className="mt-3 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
          Switching providers changes the vector width, so the existing index
          cannot be reused. On the first ingest after a switch the index is
          rebuilt empty and every facet must be re-synced from Facets → Re-sync.
        </p>
      </section>

      <section className="rounded-xl border border-border-app bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Models per reasoning tier</h2>
          <div className="flex items-center gap-2">
            {providers && (
              <span className="flex gap-1">
                {Object.entries(providers).map(([name, ok]) => (
                  <Badge key={name} tone={ok ? "success" : "neutral"}>
                    {ok ? "✓ " : "— "}
                    {name}
                  </Badge>
                ))}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={refreshModels} disabled={refreshing}>
              {refreshing ? "Fetching…" : "Refresh models"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          Refresh pulls the live Claude model list from Anthropic, so a newly
          released model is a dropdown pick rather than an upgrade. Requires
          ANTHROPIC_API_KEY in .env.local.
        </p>
        {modelsError && <p className="mt-1 text-xs text-danger">{modelsError}</p>}
        <datalist id="openai-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="mt-3 flex flex-col gap-2">
          {(["low", "medium", "high"] as const).map((tier) => (
            <label key={tier} className="flex items-center gap-3 text-sm">
              <span className="w-20 capitalize text-muted">{tier}</span>
              {models.length > 0 ? (
                <select
                  value={settings[`model_${tier}`] ?? ""}
                  onChange={(e) => update(`model_${tier}`, e.target.value)}
                  className="w-full rounded-lg border border-border-app bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
                >
                  {!models.includes(settings[`model_${tier}`] ?? "") && (
                    <option value={settings[`model_${tier}`] ?? ""}>
                      {settings[`model_${tier}`]}
                    </option>
                  )}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <Input
                  value={settings[`model_${tier}`] ?? ""}
                  onChange={(e) => update(`model_${tier}`, e.target.value)}
                  list="openai-models"
                />
              )}
            </label>
          ))}
          <label className="flex items-center gap-3 text-sm">
            <span className="w-20 text-muted">Embeddings</span>
            <Input
              value={
                settings.embedding_provider === "openai"
                  ? (settings.embedding_model_openai ?? "")
                  : (settings.embedding_model_local ?? "")
              }
              onChange={(e) =>
                update(
                  settings.embedding_provider === "openai"
                    ? "embedding_model_openai"
                    : "embedding_model_local",
                  e.target.value
                )
              }
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border-app bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">GitHub connector</h2>
          <div className="flex items-center gap-2">
            {githubTest && (
              <span
                className={`text-xs ${
                  githubTest.connected
                    ? githubTest.warning
                      ? "text-amber-500"
                      : "text-emerald-500"
                    : "text-danger"
                }`}
              >
                {githubTest.connected
                  ? (githubTest.warning ?? `✓ connected as ${githubTest.login}`)
                  : (githubTest.error ?? githubTest.message)}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={testingGithub}
              onClick={async () => {
                setTestingGithub(true);
                setGithubTest(null);
                // Save the field first so the test uses what is on screen.
                await fetch("/api/admin/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ github_token: settings.github_token ?? "" }),
                });
                const r = await fetch("/api/github/status");
                setGithubTest(await r.json());
                setTestingGithub(false);
              }}
            >
              {testingGithub ? "Testing…" : "Test connection"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          Only needed for <strong>private</strong> repositories — public ones
          are cloned without a token. Use a classic personal access token with
          the <code>repo</code> scope, or a fine-grained token with Contents:
          Read on the repositories you want indexed. A <code>GITHUB_TOKEN</code>
          in .env.local is used when this is left blank.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-muted">Access token</span>
            <Input
              type="password"
              placeholder="github_pat_… or ghp_…"
              value={settings.github_token ?? ""}
              onChange={(e) => update("github_token", e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border-app bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Confluence connector</h2>
          <div className="flex items-center gap-2">
            {confluenceTest && (
              <span
                className={`text-xs ${confluenceTest.connected ? "text-emerald-500" : "text-danger"}`}
              >
                {confluenceTest.connected
                  ? `✓ connected as ${confluenceTest.user}`
                  : confluenceTest.error}
              </span>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={testingConfluence}
              onClick={async () => {
                setTestingConfluence(true);
                setConfluenceTest(null);
                // Save current form values first so the test uses them.
                await fetch("/api/admin/settings", {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    confluence_base_url: settings.confluence_base_url ?? "",
                    confluence_email: settings.confluence_email ?? "",
                    confluence_api_token: settings.confluence_api_token ?? "",
                  }),
                });
                const r = await fetch("/api/confluence/status");
                setConfluenceTest(await r.json());
                setTestingConfluence(false);
              }}
            >
              {testingConfluence ? "Testing…" : "Test connection"}
            </Button>
          </div>
        </div>
        <p className="mt-1 text-xs text-muted">
          Uses the Confluence REST API with an Atlassian API token (Basic auth:
          account email + token). Note: API tokens do not work with Atlassian&apos;s
          remote MCP server — that requires OAuth. Once configured, add spaces
          as facets from the Facets page.
        </p>
        <div className="mt-3 flex flex-col gap-2">
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-muted">Site URL</span>
            <Input
              placeholder="https://yourorg.atlassian.net/wiki"
              value={settings.confluence_base_url ?? ""}
              onChange={(e) => update("confluence_base_url", e.target.value)}
            />
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-muted">Account email</span>
            <Input
              placeholder="you@company.com (owner of the API token)"
              value={settings.confluence_email ?? ""}
              onChange={(e) => update("confluence_email", e.target.value)}
            />
          </label>
          <label className="flex items-center gap-3 text-sm">
            <span className="w-28 text-muted">API token</span>
            <Input
              type="password"
              placeholder="ATATT…"
              value={settings.confluence_api_token ?? ""}
              onChange={(e) => update("confluence_api_token", e.target.value)}
            />
          </label>
        </div>
      </section>

      <section className="rounded-xl border border-border-app bg-surface p-4">
        <h2 className="text-sm font-semibold">System prompt</h2>
        <textarea
          value={settings.system_prompt ?? ""}
          onChange={(e) => update("system_prompt", e.target.value)}
          rows={5}
          className="mt-2 w-full rounded-lg border border-border-app bg-surface px-3 py-2 text-sm outline-none focus:border-accent"
        />
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save settings"}
        </Button>
        {saved && <span className="text-sm text-emerald-500">Saved</span>}
      </div>
    </div>
  );
}
