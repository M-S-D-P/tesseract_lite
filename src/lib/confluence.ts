import crypto from "crypto";
import { getDb } from "./db";
import { getSetting } from "./settings";
import { keyFingerprint } from "./openai";
import { ingestDocument, deleteDocument, setResourceProgress } from "./rag/ingest";

// Confluence Cloud REST connector. Atlassian API tokens authenticate REST
// calls via Basic auth (email:token) — they do NOT work with Atlassian's
// OAuth-only remote MCP server, which is why ingestion uses REST directly.

function confluenceConfig(orgId: string) {
  const baseUrl = getSetting(orgId, "confluence_base_url").replace(/\/$/, "");
  const email = getSetting(orgId, "confluence_email");
  const token = getSetting(orgId, "confluence_api_token");
  if (!baseUrl || !email || !token) {
    throw new Error(
      "Confluence is not configured — set site URL, account email, and API token in Admin → Settings"
    );
  }
  return {
    baseUrl,
    auth: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
  };
}

async function confluenceGet(orgId: string, path: string): Promise<Record<string, unknown>> {
  const { baseUrl, auth } = confluenceConfig(orgId);
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Confluence auth failed (${res.status}) — check the account email and API token`
    );
  }
  if (!res.ok) throw new Error(`Confluence API error ${res.status} on ${path}`);
  return (await res.json()) as Record<string, unknown>;
}

// Connection test: identifies the authenticated user, or throws with a
// human-readable reason.
export async function confluenceStatus(orgId: string): Promise<{
  connected: boolean;
  user?: string;
  error?: string;
}> {
  try {
    const me = (await confluenceGet(orgId, "/rest/api/user/current")) as {
      displayName?: string;
      email?: string;
    };
    return { connected: true, user: me.displayName || me.email || "unknown user" };
  } catch (e) {
    return { connected: false, error: (e as Error).message };
  }
}

export async function listConfluenceSpaces(orgId: string): Promise<
  { key: string; name: string; type: string }[]
> {
  const out: { key: string; name: string; type: string }[] = [];
  let start = 0;
  for (;;) {
    const data = (await confluenceGet(
      orgId,
      `/rest/api/space?limit=100&start=${start}`
    )) as { results?: { key: string; name: string; type: string }[] };
    const results = data.results ?? [];
    out.push(
      ...results.map((s) => ({ key: s.key, name: s.name, type: s.type }))
    );
    if (results.length < 100) break;
    start += 100;
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Ingest every page of a Confluence space through the dual-store pipeline.
// Each page is one document, cited as "SPACE: Page Title".
export async function ingestConfluenceSpace(
  resourceId: string,
  spaceKey: string,
  force = false
) {
  const db = getDb();
  const orgId = (db.prepare("SELECT org_id FROM resources WHERE id = ?").get(resourceId) as
    | { org_id: string }
    | undefined)?.org_id;
  if (!orgId) throw new Error("Resource has no organization");
  db.prepare("UPDATE resources SET status = 'processing' WHERE id = ?").run(resourceId);
  try {
    // Incremental sync: existing pages are matched by name; unchanged content
    // (same hash, fully synced) is SKIPPED instead of re-embedded — unless
    // force is set, e.g. a manual resync after switching vector backends,
    // where "synced" only means synced to whichever backend was active
    // then and may not reflect the one active now.
    const fp = keyFingerprint();
    const previous = db
      .prepare(
        "SELECT id, name, content_hash, openai_status, local_status, openai_key_fp FROM documents WHERE resource_id = ?"
      )
      .all(resourceId) as {
      id: string;
      name: string;
      content_hash: string | null;
      openai_status: string;
      local_status: string;
      openai_key_fp: string | null;
    }[];
    const previousByName = new Map(previous.map((d) => [d.name, d]));

    const { baseUrl } = confluenceConfig(orgId);
    // Cite by human-readable space name ("Sam"), not the raw key ("~754...").
    let spaceLabel = spaceKey;
    try {
      const space = (await confluenceGet(
        orgId,
        `/rest/api/space/${encodeURIComponent(spaceKey)}`
      )) as { name?: string };
      if (space.name) spaceLabel = space.name;
    } catch {
      /* keep the key */
    }
    // Collect every page first so ingestion progress has a real total.
    setResourceProgress(resourceId, "fetching pages");
    type ConfluencePage = {
      id: string;
      title: string;
      body?: { storage?: { value?: string } };
      _links?: { webui?: string };
    };
    const allPages: ConfluencePage[] = [];
    let start = 0;
    for (;;) {
      const data = (await confluenceGet(
        orgId,
        `/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&status=current&expand=body.storage,version&limit=50&start=${start}`
      )) as { results?: ConfluencePage[] };
      const results = data.results ?? [];
      allPages.push(...results);
      if (results.length < 50) break;
      start += 50;
    }
    if (allPages.length === 0) {
      throw new Error(`No pages found in space "${spaceKey}" (check the space key)`);
    }

    let pages = 0;
    let failures = 0;
    let unchanged = 0;
    let updated = 0;
    let added = 0;
    const seenNames = new Set<string>();
    for (const page of allPages) {
      setResourceProgress(
        resourceId,
        unchanged > 0
          ? `syncing pages (${unchanged} unchanged skipped)`
          : "embedding & uploading",
        pages,
        allPages.length
      );
      const text = htmlToText(page.body?.storage?.value ?? "");
      if (!text) {
        pages += 1;
        continue;
      }
      const pageUrl = page._links?.webui ? `${baseUrl}${page._links.webui}` : "";
      const markdown = `# ${page.title}\n\nSource: ${pageUrl}\n\n${text}`;
      const docName = `${spaceLabel}: ${page.title}`;
      seenNames.add(docName);
      const buffer = Buffer.from(markdown, "utf8");
      const hash = crypto.createHash("sha256").update(buffer).digest("hex");
      const existing = previousByName.get(docName);
      if (
        !force &&
        existing &&
        existing.content_hash === hash &&
        existing.local_status === "synced" &&
        existing.openai_status === "synced" &&
        existing.openai_key_fp === fp
      ) {
        // Duplicate — identical content already fully synced in both stores.
        unchanged += 1;
        pages += 1;
        continue;
      }
      if (existing) {
        await deleteDocument(existing.id);
        updated += 1;
      } else {
        added += 1;
      }
      const res = await ingestDocument({
        target: { scope: "kb", resourceId },
        name: docName,
        buffer,
        mime: "text/markdown",
        path: pageUrl,
        precomputedText: markdown,
      });
      pages += 1;
      if (!res.localOk) failures += 1;
    }
    // Pages deleted in Confluence disappear from the KB too.
    let removed = 0;
    for (const d of previous) {
      if (!seenNames.has(d.name)) {
        await deleteDocument(d.id);
        removed += 1;
      }
    }
    setResourceProgress(resourceId, null);
    db.prepare(
      "UPDATE resources SET status = ?, error = ?, meta = ?, name = ? WHERE id = ?"
    ).run(
      failures ? "error" : "ready",
      failures ? `${failures} page(s) failed to sync` : null,
      JSON.stringify({
        spaceKey,
        spaceLabel,
        pages,
        lastSync: {
          unchanged,
          updated,
          added,
          removed,
          failed: failures,
          at: new Date().toISOString(),
        },
      }),
      `Confluence: ${spaceLabel}`,
      resourceId
    );
  } catch (e) {
    setResourceProgress(resourceId, null);
    db.prepare("UPDATE resources SET status = 'error', error = ? WHERE id = ?").run(
      (e as Error).message,
      resourceId
    );
    throw e;
  }
}
