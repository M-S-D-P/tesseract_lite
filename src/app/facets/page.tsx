"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  FolderGit2,
  FolderUp,
  Upload,
  Trash2,
  RefreshCw,
  Plus,
  X,
  ChevronRight,
  Lock,
  Users,
} from "lucide-react";
import { PageShell } from "@/components/TopBar";
import { Badge, Button, Input, ProgressBar, Spinner } from "@/components/ui";

type Resource = {
  id: string;
  type: "file" | "github" | "confluence" | "folder";
  name: string;
  ref: string | null;
  status: "pending" | "processing" | "ready" | "error";
  error: string | null;
  meta: string;
  created_at: string;
  progress_phase: string | null;
  progress_done: number | null;
  progress_total: number | null;
  branch: string | null;
  visibility: "private" | "org";
  created_by: string | null;
  owner_email: string | null;
  mine: boolean;
  sync_interval: string;
  last_synced_at: string | null;
  next_sync_at: string | null;
  sync: { total: number; local_synced: number };
};

export default function FacetsPage() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch("/api/resources");
    if (res.ok) setResources((await res.json()).resources);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Poll while anything is still ingesting.
  useEffect(() => {
    const anyPending = resources.some((r) => r.status === "pending" || r.status === "processing");
    if (!anyPending) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [resources, load]);

  const setVisibility = async (id: string, visibility: "org" | "private") => {
    await fetch(`/api/resources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ visibility }),
    });
    load();
  };

  const setSchedule = async (id: string, syncInterval: string) => {
    await fetch(`/api/resources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ syncInterval }),
    });
    load();
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove "${name}" and everything indexed from it?`)) return;
    await fetch(`/api/resources/${id}`, { method: "DELETE" });
    load();
  };

  const resync = async (id: string) => {
    setResources((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "processing" as const } : r))
    );
    await fetch(`/api/resources/${id}/resync`, { method: "POST" });
    load();
  };

  const changeBranch = async (id: string, currentBranch: string | null) => {
    const next = window.prompt("Switch to branch:", currentBranch ?? "");
    if (next === null) return; // cancelled
    const trimmed = next.trim();
    if (!trimmed || trimmed === currentBranch) return;
    setResources((prev) =>
      prev.map((r) => (r.id === id ? { ...r, status: "processing" as const } : r))
    );
    const res = await fetch(`/api/resources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ branch: trimmed }),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "Failed to switch branch" }));
      alert(error ?? "Failed to switch branch");
    }
    load();
  };

  return (
    <PageShell title="Facets">
      <div className="mx-auto max-w-4xl px-6 py-8 h-full overflow-y-auto">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Facets</h1>
            <p className="mt-1 max-w-xl text-sm text-muted">
              Each facet — a repo, Confluence space, folder, or file — is indexed
              and kept in sync. Chat retrieves across every facet you can see.
              Facets are private to you unless you share them.
            </p>
          </div>
          <Button onClick={() => setAddOpen(true)} className="shrink-0">
            <Plus className="size-4" /> Add facet
          </Button>
        </div>

        <div className="mt-6 overflow-x-auto rounded-xl border border-border-app">
          <table className="w-full min-w-[720px] table-fixed text-sm">
            <thead>
              <tr className="border-b border-border-app bg-surface-2 text-left text-xs uppercase tracking-wide text-muted">
                <th className="w-[40%] px-4 py-2.5 font-medium">Resource</th>
                <th className="w-[24%] px-4 py-2.5 font-medium">Status</th>
                <th className="w-[16%] px-4 py-2.5 font-medium">Indexed</th>
                <th className="w-[20%] px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="bg-surface">
              {resources.map((r) => (
                <tr key={r.id} className="border-b border-border-app last:border-0">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {r.type === "github" && <FolderGit2 className="size-4 shrink-0 text-muted" />}
                      {r.type === "confluence" && <BookOpen className="size-4 shrink-0 text-muted" />}
                      {r.type === "folder" && <FolderUp className="size-4 shrink-0 text-muted" />}
                      <span className="min-w-0 truncate font-medium" title={r.name}>
                        {r.name}
                      </span>
                      {r.branch && (
                        <button
                          onClick={() => changeBranch(r.id, r.branch)}
                          disabled={r.status === "processing"}
                          className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted hover:text-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-60"
                          title="Tracked branch — click to switch"
                        >
                          {r.branch}
                        </button>
                      )}
                      {r.visibility === "org" ? (
                        <Badge tone="neutral">shared</Badge>
                      ) : (
                        <Badge tone="neutral">private</Badge>
                      )}
                    </div>
                    {!r.mine && r.owner_email && (
                      <div className="mt-0.5 text-[10px] text-muted">
                        shared by {r.owner_email}
                      </div>
                    )}
                    {r.error && (
                      <div className="mt-0.5 truncate text-xs text-danger" title={r.error}>
                        {r.error}
                      </div>
                    )}
                    <LastSyncSummary meta={r.meta} />
                    {(r.status === "pending" || r.status === "processing") && (
                      <ProgressBar
                        phase={r.progress_phase ?? "queued"}
                        done={r.progress_done}
                        total={r.progress_total}
                      />
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {r.status === "ready" && <Badge tone="success">ready</Badge>}
                    {r.status === "error" && <Badge tone="danger">error</Badge>}
                    {(r.status === "pending" || r.status === "processing") && (
                      <span className="inline-flex items-center gap-1.5">
                        <Spinner className="size-3" />
                        <Badge tone="warn">{r.status}</Badge>
                      </span>
                    )}
                    <div className="mt-1.5">
                      <select
                        value={r.sync_interval}
                        onChange={(e) => setSchedule(r.id, e.target.value)}
                        className="rounded-md border border-border-app bg-surface px-1.5 py-0.5 text-[11px] text-muted"
                        title="Sync schedule"
                      >
                        <option value="manual">manual sync</option>
                        <option value="6h">every 6h</option>
                        <option value="daily">daily</option>
                        <option value="weekly">weekly</option>
                      </select>
                    </div>
                    {r.last_synced_at && (
                      <div className="mt-1 text-[10px] text-muted">
                        synced {new Date(r.last_synced_at.replace(" ", "T") + "Z").toLocaleString()}
                      </div>
                    )}
                  </td>
                  <SyncCell synced={r.sync.local_synced} total={r.sync.total} />
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => resync(r.id)}
                      disabled={r.status === "processing"}
                      className="mr-1 rounded p-1.5 text-muted hover:text-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label="Re-sync resource"
                      title={
                        r.status === "processing"
                          ? "Already syncing"
                          : "Re-sync this facet — re-clones/re-fetches and re-indexes from scratch, even if it already shows ready"
                      }
                    >
                      <RefreshCw className="size-4" />
                    </button>
                    {r.mine && (
                      <button
                        onClick={() =>
                          setVisibility(r.id, r.visibility === "org" ? "private" : "org")
                        }
                        className="mr-1 rounded p-1.5 text-muted hover:text-accent cursor-pointer"
                        aria-label={
                          r.visibility === "org" ? "Make private" : "Share with everyone"
                        }
                        title={
                          r.visibility === "org"
                            ? "Shared with the organization — click to make it private again"
                            : "Private to you — click to share with everyone"
                        }
                      >
                        {r.visibility === "org" ? (
                          <Users className="size-4" />
                        ) : (
                          <Lock className="size-4" />
                        )}
                      </button>
                    )}
                    <button
                      onClick={() => remove(r.id, r.name)}
                      className="rounded p-1.5 text-muted hover:text-danger cursor-pointer"
                      aria-label="Delete resource"
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </td>
                </tr>
              ))}
              {!loading && resources.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center">
                    <p className="text-sm text-muted">No facets yet.</p>
                    <Button className="mt-3" onClick={() => setAddOpen(true)}>
                      <Plus className="size-4" /> Add your first facet
                    </Button>
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center">
                    <Spinner />
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <button
          onClick={load}
          className="mt-3 inline-flex items-center gap-1.5 text-xs text-muted hover:text-foreground cursor-pointer"
        >
          <RefreshCw className="size-3" /> Refresh
        </button>
      </div>
      {addOpen && <AddFacetDialog onClose={() => setAddOpen(false)} onChanged={load} />}
    </PageShell>
  );
}

// --- Add facet -------------------------------------------------------------

type SourceKind = "github" | "confluence" | "files" | "folder";

const SOURCES: {
  kind: SourceKind;
  label: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    kind: "github",
    label: "GitHub repository",
    hint: "Public or token-authorized repo",
    icon: <FolderGit2 className="size-4" />,
  },
  {
    kind: "confluence",
    label: "Confluence",
    hint: "Pick spaces from your site",
    icon: <BookOpen className="size-4" />,
  },
  {
    kind: "files",
    label: "Files",
    hint: "PDF, DOCX, MD, code, AppMap",
    icon: <Upload className="size-4" />,
  },
  {
    kind: "folder",
    label: "Folder",
    hint: "Upload a directory tree",
    icon: <FolderUp className="size-4" />,
  },
];

function AddFacetDialog({
  onClose,
  onChanged,
}: {
  onClose: () => void;
  onChanged: () => void;
}) {
  const [source, setSource] = useState<SourceKind>("github");

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-app bg-surface shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border-app px-5 py-3.5">
          <h2 className="text-sm font-semibold">Add facet</h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-muted hover:bg-surface-2 hover:text-foreground cursor-pointer"
            aria-label="Close"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="shrink-0 border-b border-border-app p-2 sm:w-56 sm:border-b-0 sm:border-r">
            {SOURCES.map((s) => (
              <button
                key={s.kind}
                onClick={() => setSource(s.kind)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left cursor-pointer ${
                  source === s.kind
                    ? "bg-surface-2 text-foreground"
                    : "text-muted hover:bg-surface-2/60 hover:text-foreground"
                }`}
              >
                <span className={source === s.kind ? "text-accent" : ""}>{s.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{s.label}</span>
                  <span className="block truncate text-[11px] text-muted">{s.hint}</span>
                </span>
                {source === s.kind && <ChevronRight className="size-3.5 shrink-0 text-accent" />}
              </button>
            ))}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {source === "github" && <GithubPanel onDone={onChanged} onClose={onClose} />}
            {source === "confluence" && (
              <ConfluencePanel onChanged={onChanged} onClose={onClose} />
            )}
            {(source === "files" || source === "folder") && (
              <UploadPanel kind={source} onDone={onChanged} onClose={onClose} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function GithubPanel({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [branches, setBranches] = useState<string[]>([]);
  const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
  const [isPrivate, setIsPrivate] = useState(false);
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [shareWithOrg, setShareWithOrg] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the branch list once a plausible URL has been typed, so the picker
  // is populated without a separate button.
  useEffect(() => {
    const trimmed = url.trim();
    if (!/github\.com\/[\w.-]+\/[\w.-]+/i.test(trimmed)) {
      setBranches([]);
      setDefaultBranch(null);
      setBranchError(null);
      return;
    }
    let cancelled = false;
    setLoadingBranches(true);
    setBranchError(null);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/github/branches?url=${encodeURIComponent(trimmed)}`);
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setBranches([]);
          setBranchError(data.error ?? "Could not read branches");
        } else {
          setBranches(data.branches ?? []);
          setDefaultBranch(data.defaultBranch ?? null);
          setIsPrivate(Boolean(data.private));
          // A /tree/<branch> URL pre-selects that branch.
          const m = trimmed.match(/\/tree\/(.+?)\/?$/);
          if (m) setBranch(decodeURIComponent(m[1]));
        }
      } catch {
        if (!cancelled) setBranchError("Could not reach GitHub");
      } finally {
        if (!cancelled) setLoadingBranches(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/resources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "github",
        url: url.trim(),
        branch: branch.trim() || undefined,
        shareWithOrg,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Failed to add repository");
      return;
    }
    onDone();
    onClose();
  };

  return (
    <form onSubmit={submit} className="flex h-full flex-col p-5">
      <p className="text-sm text-muted">
        The repository is cloned, bundled by directory and indexed. Paste a
        plain repo URL, or one pointing at a branch — a
        <code className="mx-1 text-xs">/tree/&lt;branch&gt;</code> link is
        understood.
      </p>
      <Input
        placeholder="https://github.com/org/repo"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="mt-4"
        autoFocus
      />

      <label className="mt-3 flex flex-col gap-1 text-sm">
        <span className="text-muted">
          Branch
          {loadingBranches && <span className="ml-2 text-xs">reading branches…</span>}
          {!loadingBranches && defaultBranch && (
            <span className="ml-2 text-xs">
              default is {defaultBranch}
              {isPrivate && " · private repository"}
            </span>
          )}
        </span>
        {branches.length > 0 ? (
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            className="rounded-lg border border-border-app bg-surface px-2.5 py-2 text-sm"
          >
            <option value="">{defaultBranch ? `${defaultBranch} (default)` : "Default"}</option>
            {branches.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        ) : (
          // No list (private without a token, rate limited, offline) — a typed
          // name still works, so never block on the picker.
          <Input
            placeholder="leave blank for the default branch"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        )}
      </label>
      {branchError && (
        <p className="mt-1 text-xs text-amber-500">
          {branchError} — you can still type a branch name.
        </p>
      )}

      <label className="mt-4 flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={shareWithOrg}
          onChange={(e) => setShareWithOrg(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Share with everyone
          <span className="block text-xs text-muted">
            Off: only you can see or search it. On: everyone in the
            organization can, and it is indexed once instead of per person.
          </span>
        </span>
      </label>

      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      <div className="mt-4 flex justify-end">
        <Button type="submit" disabled={busy || !url.trim()}>
          {busy ? <Spinner className="size-4" /> : <FolderGit2 className="size-4" />} Add
          repository
        </Button>
      </div>
    </form>
  );
}

function UploadPanel({
  kind,
  onDone,
  onClose,
}: {
  kind: "files" | "folder";
  onDone: () => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [shareWithOrg, setShareWithOrg] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    const form = new FormData();
    form.append("shareWithOrg", String(shareWithOrg));
    for (const f of Array.from(files)) {
      form.append("files", f);
      if (kind === "folder") {
        form.append(
          "paths",
          (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name
        );
      }
    }
    const res = await fetch("/api/resources", { method: "POST", body: form });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Upload failed");
      return;
    }
    onDone();
    onClose();
  };

  return (
    <div className="p-5">
      <p className="text-sm text-muted">
        {kind === "files"
          ? "Upload individual documents — PDF, DOCX, Markdown, source files, or *.appmap.json runtime traces."
          : "Upload an entire directory. Structure is preserved, and the folder syncs on the schedule you pick."}
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple={kind === "files"}
        hidden
        {...(kind === "folder" ? { webkitdirectory: "" } : {})}
        onChange={(e) => upload(e.target.files)}
      />
      <button
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        className="mt-4 flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border-app px-6 py-10 text-sm text-muted hover:border-accent hover:text-foreground cursor-pointer disabled:opacity-60"
      >
        {busy ? (
          <Spinner />
        ) : kind === "files" ? (
          <Upload className="size-6" />
        ) : (
          <FolderUp className="size-6" />
        )}
        {busy ? "Uploading…" : kind === "files" ? "Choose files" : "Choose folder"}
      </button>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </div>
  );
}

type Space = {
  key: string;
  name: string;
  type: string;
  added: boolean;
  resourceId?: string | null;
};

function ConfluencePanel({
  onChanged,
  onClose,
}: {
  onChanged: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<{
    connected: boolean;
    configured?: boolean;
    user?: string;
    site?: string;
    error?: string;
  } | null>(null);
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/confluence/status").then(async (r) => {
      const s = await r.json();
      setStatus(s);
      if (s.connected) {
        const res = await fetch("/api/confluence/spaces");
        if (res.ok) setSpaces((await res.json()).spaces);
      }
    });
  }, []);

  const filtered = (spaces ?? []).filter(
    (s) =>
      s.name.toLowerCase().includes(query.toLowerCase()) ||
      s.key.toLowerCase().includes(query.toLowerCase())
  );

  const toggle = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const addSelected = async () => {
    setBusy(true);
    for (const key of Array.from(selected)) {
      await fetch("/api/resources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "confluence", spaceKey: key }),
      });
    }
    setBusy(false);
    onChanged();
    onClose();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border-app px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">
            {status?.site ?? "Confluence"}
          </span>
          {status?.connected && <Badge tone="success">connected as {status.user}</Badge>}
          {status && !status.connected && <Badge tone="danger">not connected</Badge>}
        </div>
        {status && !status.connected && (
          <p className="mt-2 text-sm text-danger">
            {status.error ?? "Connection failed"}
            {!status.configured && " — add your site URL, account email, and API token in Admin → Settings."}
          </p>
        )}
        {status?.connected && (
          <>
            <p className="mt-2 text-xs text-muted">
              Check any number of spaces — each becomes its own synced facet.
              Spaces already added can be removed here.
            </p>
            <Input
              placeholder="Search spaces…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="mt-3"
              autoFocus
            />
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {(!status || (status.connected && spaces === null)) && (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        )}
        {filtered.map((s) => (
          <label
            key={s.key}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm ${
              s.added ? "opacity-60" : "cursor-pointer hover:bg-surface-2"
            }`}
          >
            <input
              type="checkbox"
              disabled={s.added}
              checked={s.added || selected.has(s.key)}
              onChange={() => toggle(s.key)}
              className="accent-[var(--accent)]"
            />
            <span className="min-w-0 flex-1 truncate">
              {s.name}
              {s.type === "personal" && (
                <span className="ml-1.5 text-xs text-muted">(personal)</span>
              )}
            </span>
            <span className="font-mono text-xs text-muted">{s.key}</span>
            {s.added && <Badge tone="success">added</Badge>}
            {s.added && s.resourceId && (
              <button
                onClick={async (e) => {
                  e.preventDefault();
                  if (!confirm(`Remove the "${s.name}" facet?`)) return;
                  await fetch(`/api/resources/${s.resourceId}`, { method: "DELETE" });
                  setSpaces((prev) =>
                    (prev ?? []).map((x) =>
                      x.key === s.key ? { ...x, added: false, resourceId: null } : x
                    )
                  );
                  onChanged();
                }}
                className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-danger hover:bg-danger/10 cursor-pointer"
              >
                Remove
              </button>
            )}
          </label>
        ))}
        {status?.connected && spaces !== null && filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-sm text-muted">No spaces match</p>
        )}
      </div>
      {status?.connected && (
        <div className="flex items-center justify-end border-t border-border-app px-5 py-3">
          <Button onClick={addSelected} disabled={selected.size === 0 || busy}>
            {busy ? <Spinner className="size-4" /> : <BookOpen className="size-4" />}
            Add {selected.size > 0 ? `${selected.size} ` : ""}space
            {selected.size === 1 ? "" : "s"}
          </Button>
        </div>
      )}
    </div>
  );
}

function LastSyncSummary({ meta }: { meta: string }) {
  let last: { unchanged?: number; updated?: number; added?: number; removed?: number; failed?: number } | null = null;
  try {
    last = JSON.parse(meta || "{}").lastSync ?? null;
  } catch {
    /* no meta */
  }
  if (!last) return null;
  const parts = [
    last.unchanged ? `${last.unchanged} unchanged (skipped)` : null,
    last.updated ? `${last.updated} updated` : null,
    last.added ? `${last.added} added` : null,
    last.removed ? `${last.removed} removed` : null,
    last.failed ? `${last.failed} failed` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return (
    <div className="mt-0.5 text-[11px] text-muted">last sync: {parts.join(" · ")}</div>
  );
}

function SyncCell({ synced, total }: { synced: number; total: number }) {
  if (total === 0) return <td className="px-4 py-3 text-xs text-muted">—</td>;
  const ok = synced === total;
  return (
    <td className="px-4 py-3">
      <Badge tone={ok ? "success" : "warn"}>
        {synced}/{total} synced
      </Badge>
    </td>
  );
}
