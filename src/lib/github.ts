import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { getDb, uid, REPOS_DIR } from "./db";
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

export function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(
    /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?$/i
  );
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

// Clones a repo, packs its text files into markdown bundles (path-headed
// sections), and ingests each bundle through the dual-store pipeline.
export async function ingestGithubRepo(resourceId: string, url: string) {
  const db = getDb();
  const parsed = parseGithubUrl(url);
  if (!parsed) throw new Error("Not a valid GitHub URL");
  const cloneDir = path.join(REPOS_DIR, `clone-${uid()}`);
  db.prepare("UPDATE resources SET status = 'processing' WHERE id = ?").run(resourceId);
  try {
    setResourceProgress(resourceId, "cloning repository");
    const token = process.env.GITHUB_TOKEN;
    const cloneUrl = token
      ? `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.repo}.git`
      : `https://github.com/${parsed.owner}/${parsed.repo}.git`;
    await execFileAsync("git", ["clone", "--depth", "1", cloneUrl, cloneDir], {
      timeout: 300_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });

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
