import fs from "fs";
import path from "path";
import { getDb, UPLOADS_DIR } from "./db";
import { ingestDocument, setResourceProgress } from "./rag/ingest";
import { isIngestableFile, isImageFile } from "./rag/extract";

// Folder uploads are staged to disk first, then ingested by a durable
// background job — a killed server resumes from the staged copy.

export const STAGING_DIR = path.join(UPLOADS_DIR, "staging");

export function stagingDirFor(resourceId: string) {
  return path.join(STAGING_DIR, resourceId);
}

function walkStaging(dir: string, root: string, out: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkStaging(full, root, out);
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
}

export async function ingestStagedFolder(resourceId: string) {
  const db = getDb();
  const stagingDir = stagingDirFor(resourceId);
  db.prepare("UPDATE resources SET status = 'processing' WHERE id = ?").run(resourceId);
  try {
    if (!fs.existsSync(stagingDir)) {
      throw new Error("Staged folder is missing — upload the folder again");
    }
    const files: string[] = [];
    walkStaging(stagingDir, stagingDir, files);
    const ingestable = files.filter(
      (f) => isIngestableFile(f) && !isImageFile(f)
    );
    if (ingestable.length === 0) {
      throw new Error("No ingestable text documents found in the folder");
    }
    ingestable.sort();

    let done = 0;
    let failures = 0;
    let skipped = files.length - ingestable.length;
    for (const rel of ingestable) {
      setResourceProgress(resourceId, "embedding & uploading", done, ingestable.length);
      const buffer = fs.readFileSync(path.join(stagingDir, rel));
      const res = await ingestDocument({
        target: { scope: "kb", resourceId },
        name: rel, // citations show the relative path inside the folder
        buffer,
        path: rel,
      });
      if (!res.localOk) failures += 1;
      done += 1;
    }
    setResourceProgress(resourceId, null);
    db.prepare(
      "UPDATE resources SET status = ?, error = ?, meta = ? WHERE id = ?"
    ).run(
      failures ? "error" : "ready",
      failures ? `${failures} file(s) failed to sync` : null,
      JSON.stringify({ files: ingestable.length, skipped }),
      resourceId
    );
    fs.rmSync(stagingDir, { recursive: true, force: true });
  } catch (e) {
    setResourceProgress(resourceId, null);
    db.prepare("UPDATE resources SET status = 'error', error = ? WHERE id = ?").run(
      (e as Error).message,
      resourceId
    );
    throw e;
  }
}
