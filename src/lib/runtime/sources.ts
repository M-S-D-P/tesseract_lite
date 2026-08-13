import net from "net";
import fs from "fs";
import { getDb } from "../db";
import { RailsLogParser } from "./parser";
import { recordRequest } from "./store";

// Manages one listener per configured source, so several locally running
// applications can stream at once — each on its own port, or by tailing its own
// log file. Replaces the single hardcoded port.
//
// Two transports:
//   port — we bind a TCP port; the app pipes into it (`… | nc localhost PORT`)
//   file — we tail a log file directly, so the app needs no change at all

export type RuntimeSource = {
  id: string;
  org_id: string;
  name: string;
  kind: "port" | "file";
  port: number | null;
  file_path: string | null;
  app_url: string | null;
  resource_id: string | null;
  created_by: string | null;
  enabled: number;
  status: string;
  error: string | null;
  requests_seen: number;
  last_seen_at: string | null;
  created_at: string;
};

type Handle = {
  stop: () => void;
};

declare global {
  // eslint-disable-next-line no-var
  var __tesseractSources: Map<string, Handle> | undefined;
}

function handles(): Map<string, Handle> {
  if (!globalThis.__tesseractSources) globalThis.__tesseractSources = new Map();
  return globalThis.__tesseractSources;
}

function setStatus(id: string, status: string, error?: string | null) {
  try {
    getDb()
      .prepare("UPDATE runtime_sources SET status = ?, error = ? WHERE id = ?")
      .run(status, error ?? null, id);
  } catch {
    /* status is advisory */
  }
}

function noteActivity(id: string, requests: number) {
  if (requests <= 0) return;
  try {
    getDb()
      .prepare(
        "UPDATE runtime_sources SET requests_seen = requests_seen + ?, last_seen_at = datetime('now') WHERE id = ?"
      )
      .run(requests, id);
  } catch {
    /* advisory */
  }
}

// One parser per stream; each records against the owning source.
function makeParser(source: RuntimeSource) {
  return new RailsLogParser((req) => {
    try {
      recordRequest(source.org_id, req, source.kind === "file" ? "file" : "log", source.id);
      noteActivity(source.id, 1);
    } catch (e) {
      console.error(`[runtime:${source.name}] record failed:`, (e as Error).message);
    }
  });
}

function startPortSource(source: RuntimeSource): Handle | null {
  const port = Number(source.port);
  if (!port || port < 1 || port > 65535) {
    setStatus(source.id, "error", "Invalid port");
    return null;
  }

  const server = net.createServer((socket) => {
    const parser = makeParser(source);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) parser.push(line);
    });
    const finish = () => {
      if (buffer) parser.push(buffer);
      parser.flush();
    };
    socket.on("end", finish);
    socket.on("close", finish);
    socket.on("error", () => {
      /* a dropped client is normal */
    });
  });

  server.on("error", (e) => {
    const msg = (e as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? `Port ${port} is already in use`
      : (e as Error).message;
    console.error(`[runtime:${source.name}] ${msg}`);
    setStatus(source.id, "error", msg);
  });
  server.listen(port, () => {
    console.log(`[runtime:${source.name}] listening on tcp://localhost:${port}`);
    setStatus(source.id, "listening", null);
  });

  return { stop: () => server.close() };
}

// Tails a log file: reads only what is appended, and restarts from zero if the
// file shrinks (log rotation) so rotation doesn't silently stop capture.
function startFileSource(source: RuntimeSource): Handle | null {
  const path = source.file_path;
  if (!path) {
    setStatus(source.id, "error", "No file path");
    return null;
  }
  if (!fs.existsSync(path)) {
    setStatus(source.id, "error", `File not found: ${path}`);
    return null;
  }

  const parser = makeParser(source);
  let position = 0;
  try {
    // Start at the end — historical content is not "live".
    position = fs.statSync(path).size;
  } catch {
    position = 0;
  }
  let reading = false;
  let stopped = false;

  const drain = () => {
    if (reading || stopped) return;
    reading = true;
    try {
      const size = fs.statSync(path).size;
      if (size < position) position = 0; // rotated
      if (size > position) {
        const fd = fs.openSync(path, "r");
        const length = size - position;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, position);
        fs.closeSync(fd);
        position = size;
        const text = buf.toString("utf8");
        for (const line of text.split("\n")) parser.push(line);
      }
    } catch (e) {
      setStatus(source.id, "error", (e as Error).message);
    } finally {
      reading = false;
    }
  };

  // Polling rather than fs.watch: watch semantics differ across platforms and
  // miss appends on some filesystems, which is exactly our case.
  const timer = setInterval(drain, 750);
  setStatus(source.id, "tailing", null);
  console.log(`[runtime:${source.name}] tailing ${path}`);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      parser.flush();
    },
  };
}

export function startSource(source: RuntimeSource) {
  stopSource(source.id);
  if (!source.enabled) {
    setStatus(source.id, "stopped", null);
    return;
  }
  const handle =
    source.kind === "file" ? startFileSource(source) : startPortSource(source);
  if (handle) handles().set(source.id, handle);
}

export function stopSource(id: string) {
  const h = handles().get(id);
  if (h) {
    try {
      h.stop();
    } catch {
      /* already gone */
    }
    handles().delete(id);
  }
  setStatus(id, "stopped", null);
}

// A developer sees the ports they added, and nobody else's — several people can
// each stream from their own machine without reading or breaking each other's
// setup. Administrators see all of them so abandoned ones can be cleaned up.
// Rows with no owner predate ownership and stay visible to everyone.
export function listSources(
  orgId: string,
  userId?: string,
  isAdmin = false
): RuntimeSource[] {
  const db = getDb();
  if (!userId || isAdmin) {
    return db
      .prepare("SELECT * FROM runtime_sources WHERE org_id = ? ORDER BY created_at")
      .all(orgId) as RuntimeSource[];
  }
  return db
    .prepare(
      `SELECT * FROM runtime_sources
       WHERE org_id = ? AND (created_by = ? OR created_by IS NULL)
       ORDER BY created_at`
    )
    .all(orgId, userId) as RuntimeSource[];
}

// The ids whose telemetry the caller may look at, or null for "no restriction"
// (administrators). Used to scope the stream, the summary and coverage, so one
// developer's traffic never lands in another's analysis.
export function visibleSourceIds(
  orgId: string,
  userId: string,
  isAdmin = false
): string[] | null {
  if (isAdmin) return null;
  return listSources(orgId, userId, false).map((s) => s.id);
}

export function getSource(id: string, orgId: string): RuntimeSource | undefined {
  return getDb()
    .prepare("SELECT * FROM runtime_sources WHERE id = ? AND org_id = ?")
    .get(id, orgId) as RuntimeSource | undefined;
}

// Read or write access to one source. Ownership is enforced here rather than
// only in the list, so a guessed id gets the same answer as a hidden row.
export function loadSource(
  id: string,
  orgId: string,
  userId: string,
  isAdmin = false
): RuntimeSource | undefined {
  const source = getSource(id, orgId);
  if (!source) return undefined;
  if (isAdmin) return source;
  if (source.created_by && source.created_by !== userId) return undefined;
  return source;
}

// Called at boot: bring every enabled source back up without a request.
export function startAllSources() {
  const db = getDb();
  let rows: RuntimeSource[] = [];
  try {
    rows = db
      .prepare("SELECT * FROM runtime_sources WHERE enabled = 1")
      .all() as RuntimeSource[];
  } catch {
    return; // table not migrated yet
  }

  // Seed a default source on first run so the product works out of the box.
  if (rows.length === 0) {
    const org = db.prepare("SELECT id FROM orgs ORDER BY created_at LIMIT 1").get() as
      | { id: string }
      | undefined;
    if (org) {
      const port = Number(process.env.RUNTIME_LOG_PORT || 9999);
      const id = `src-default-${port}`;
      db.prepare(
        `INSERT OR IGNORE INTO runtime_sources (id, org_id, name, kind, port)
         VALUES (?, ?, ?, 'port', ?)`
      ).run(id, org.id, "Local app", port);
      rows = db
        .prepare("SELECT * FROM runtime_sources WHERE enabled = 1")
        .all() as RuntimeSource[];
    }
  }

  for (const s of rows) startSource(s);
}
