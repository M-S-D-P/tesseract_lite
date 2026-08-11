import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { getDb, uid, REPOS_DIR } from "./db";
import { getSetting } from "./settings";
import { isIngestableFile } from "./rag/extract";
import { ingestDocument, setResourceProgress } from "./rag/ingest";

const execFileAsync = promisify(execFile);

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "build", ".next", "coverage",
  "__pycache__", ".venv", "venv", "target", "tmp", "log", "public/assets",
]);
const SKIP_FILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "Gemfile.lock",
  "poetry.lock", "cargo.lock", "composer.lock",
]);
const MAX_FILE_BYTES = 512 * 1024;
const BUNDLE_TARGET_BYTES = 350 * 1024; // each bundle becomes one document in both stores

function walk(dir: string, root: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), root, out);
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (SKIP_FILES.has(entry.name)) continue;
      if (!isIngestableFile(entry.name)) continue;
      if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
      out.push(rel);
    }
  }
}

export function parseGithubUrl(
  url: string
): { owner: string; repo: string; branch: string | null } | null {
  const m = url.trim().match(
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/(.*))?$/i
  );
  if (!m) return null;
  // Pasting the URL straight from the browser while on a branch gives
  // .../tree/<branch>, so honour that instead of silently taking the default.
  // Branch names may contain slashes (feature/foo), hence the greedy tail.
  const tail = m[3] ?? "";
  const treeMatch = tail.match(/^tree\/(.+?)\/?$/i);
  return {
    owner: m[1],
    repo: m[2],
    branch: treeMatch ? decodeURIComponent(treeMatch[1]) : null,
  };
}

// The token that reaches private repositories. The per-organization setting
// wins so an admin can configure it in the UI; the environment variable stays
// as a fallback for installs that would rather keep it out of the database.
export function githubToken(orgId?: string): string | undefined {
  const fromSettings = orgId ? getSetting(orgId, "github_token").trim() : "";
  return fromSettings || process.env.GITHUB_TOKEN || undefined;
}

function cloneUrlFor(owner: string, repo: string, token?: string): string {
  return token
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `https://github.com/${owner}/${repo}.git`;
}

// Branch list for the picker. Uses the REST API rather than `git ls-remote`
// so a bad token reports "not found or no access" instead of hanging on a
// credential prompt.
export async function listBranches(
  url: string,
  orgId: string
): Promise<{ branches: string[]; defaultBranch: string | null; private: boolean }> {
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error("Not a valid GitHub repository URL");
  const token = githubToken(orgId);
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tesseract",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
  const repoRes = await fetch(base, { headers });
  if (repoRes.status === 404) {
    throw new Error(
      token
        ? "Repository not found, or the configured GitHub token cannot see it"
        : "Repository not found. If it is private, add a GitHub token in Admin → Settings"
    );
  }
  if (repoRes.status === 401) {
    throw new Error("The configured GitHub token was rejected");
  }
  if (!repoRes.ok) throw new Error(`GitHub returned ${repoRes.status}`);
  const repoJson = (await repoRes.json()) as {
    default_branch?: string;
    private?: boolean;
  };

  const branches: string[] = [];
  // Up to 300 branches; beyond that the picker is the wrong tool anyway and
  // the field still accepts a typed name.
  for (let page = 1; page <= 3; page++) {
    const res = await fetch(`${base}/branches?per_page=100&page=${page}`, { headers });
    if (!res.ok) break;
    const rows = (await res.json()) as { name: string }[];
    branches.push(...rows.map((b) => b.name));
    if (rows.length < 100) break;
  }

  const defaultBranch = repoJson.default_branch ?? null;
  // Default first, then the rest alphabetically — it is what people want.
  branches.sort((a, b) => {
    if (a === defaultBranch) return -1;
    if (b === defaultBranch) return 1;
    return a.localeCompare(b);
  });
  return { branches, defaultBranch, private: Boolean(repoJson.private) };
}

// Clones a repo, packs its text files into markdown bundles (path-headed
// sections), and ingests each bundle through the dual-store pipeline.
export async function ingestGithubRepo(
  resourceId: string,
  url: string,
  branchArg?: string | null
) {
  const db = getDb();
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error("Not a valid GitHub URL");
  const row = db
    .prepare("SELECT org_id, branch FROM resources WHERE id = ?")
    .get(resourceId) as { org_id: string; branch: string | null } | undefined;
  // Explicit argument wins, then whatever the resource already tracks (so a
  // re-sync stays on its branch), then the branch embedded in the URL.
  const branch = branchArg ?? row?.branch ?? parsed.branch ?? null;

  const cloneDir = path.join(REPOS_DIR, `clone-${uid()}`);
  db.prepare("UPDATE resources SET status = 'processing' WHERE id = ?").run(resourceId);
  try {
    setResourceProgress(
      resourceId,
      branch ? `cloning repository (${branch})` : "cloning repository"
    );
    const token = githubToken(row?.org_id);
    const cloneUrl = cloneUrlFor(parsed.owner, parsed.repo, token);
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch, "--single-branch");
    args.push(cloneUrl, cloneDir);
    try {
      await execFileAsync("git", args, {
        timeout: 300_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });
    } catch (e) {
      // git puts the reason on stderr and the token is in the URL, so scrub
      // before it can reach the UI or the logs.
      const stderr = String((e as { stderr?: string }).stderr ?? (e as Error).message);
      const safe = token ? stderr.split(token).join("***") : stderr;
      if (branch && /Remote branch .* not found|not found in upstream/i.test(safe)) {
        throw new Error(`Branch "${branch}" does not exist in ${parsed.owner}/${parsed.repo}`);
      }
      if (/Authentication failed|could not read Username|403/i.test(safe)) {
        throw new Error(
          token
            ? "GitHub rejected the configured token for this repository"
            : "This repository is private. Add a GitHub token in Admin → Settings."
        );
      }
      throw new Error(safe.trim().split("\n").slice(-3).join(" ").slice(0, 300));
    }

    // Record the branch actually checked out, so the list shows something
    // truthful even when the caller let the default win.
    let resolvedBranch = branch;
    if (!resolvedBranch) {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", cloneDir, "rev-parse", "--abbrev-ref", "HEAD"],
          { timeout: 15_000 }
        );
        resolvedBranch = stdout.trim() || null;
      } catch {
        /* leave it unknown rather than failing the ingestion */
      }
    }
    if (resolvedBranch) {
      db.prepare("UPDATE resources SET branch = ? WHERE id = ?").run(
        resolvedBranch,
        resourceId
      );
    }

    // Rails intelligence: extract routes/models/schema/controllers into the
    // knowledge graph before bundling (stage 6+8 of the platform pipeline).
    let graphCounts: { entities: number; edges: number } | null = null;
    const { isRailsRepo, analyzeRailsRepo } = await import("./rails-graph");
    if (isRailsRepo(cloneDir)) {
      setResourceProgress(resourceId, "extracting Rails app graph");
      try {
        graphCounts = analyzeRailsRepo(resourceId, cloneDir);
      } catch (e) {
        console.error("rails graph extraction failed:", (e as Error).message);
      }
    }

    setResourceProgress(resourceId, "scanning & bundling files");
    const files: string[] = [];
    walk(cloneDir, cloneDir, files);
    files.sort();
    if (files.length === 0) throw new Error("No ingestable text files found in repo");

    // Pack files into bundles so both stores hold identical content
    // without thousands of tiny uploads.
    const repoLabel = `${parsed.owner}/${parsed.repo}`;
    let bundle: string[] = [];
    let bundleBytes = 0;
    let bundleIndex = 0;
    let fileCount = 0;
    const bundles: { name: string; text: string; paths: string[] }[] = [];
    let bundlePaths: string[] = [];

    const flush = () => {
      if (bundle.length === 0) return;
      bundleIndex += 1;
      bundles.push({
        name: `${parsed.owner}-${parsed.repo}-part-${String(bundleIndex).padStart(3, "0")}.md`,
        text: `# Repository ${repoLabel} (part ${bundleIndex})\n\n${bundle.join("\n\n")}`,
        paths: bundlePaths,
      });
      bundle = [];
      bundlePaths = [];
      bundleBytes = 0;
    };

    for (const rel of files) {
      let content: string;
      try {
        content = fs.readFileSync(path.join(cloneDir, rel), "utf8");
      } catch {
        continue;
      }
      if (content.includes("\u0000")) continue; // binary sneaking through
      const section = `## File: ${rel}\n\n\`\`\`\n${content}\n\`\`\``;
      bundle.push(section);
      bundlePaths.push(rel);
      bundleBytes += section.length;
      fileCount += 1;
      if (bundleBytes >= BUNDLE_TARGET_BYTES) flush();
    }
    flush();

    let localFailures = 0;
    let done = 0;
    for (const b of bundles) {
      setResourceProgress(resourceId, "embedding & uploading", done, bundles.length);
      const res = await ingestDocument({
        target: { scope: "kb", resourceId },
        name: b.name,
        buffer: Buffer.from(b.text, "utf8"),
        mime: "text/markdown",
        path: b.paths.slice(0, 20).join(", "),
        precomputedText: b.text,
      });
      if (!res.localOk) localFailures += 1;
      done += 1;
    }
    setResourceProgress(resourceId, null);

    const meta = {
      owner: parsed.owner,
      repo: parsed.repo,
      ...(resolvedBranch ? { branch: resolvedBranch } : {}),
      files: fileCount,
      bundles: bundles.length,
      ...(graphCounts ? { graph: graphCounts } : {}),
    };
    const anyFailure = localFailures > 0;
    db.prepare(
      "UPDATE resources SET status = ?, error = ?, meta = ? WHERE id = ?"
    ).run(
      anyFailure ? "error" : "ready",
      anyFailure
        ? `${localFailures} bundle(s) failed to index`
        : null,
      JSON.stringify(meta),
      resourceId
    );
  } catch (e) {
    setResourceProgress(resourceId, null);
    db.prepare("UPDATE resources SET status = 'error', error = ? WHERE id = ?").run(
      (e as Error).message,
      resourceId
    );
    throw e;
  } finally {
    fs.rmSync(cloneDir, { recursive: true, force: true });
  }
}
