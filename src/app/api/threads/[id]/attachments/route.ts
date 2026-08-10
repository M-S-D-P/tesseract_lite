import fs from "fs";
import path from "path";
import { getDb, uid, UPLOADS_DIR } from "@/lib/db";
import { requireUser, requireActiveSubscription, errorResponse } from "@/lib/auth";
import { isImageFile } from "@/lib/rag/extract";
import { ingestDocument } from "@/lib/rag/ingest";
import type { Attachment } from "@/lib/chat/completion";

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

// POST /api/threads/:id/attachments — multipart upload of chat attachments.
// Images are stored for base64 input; documents are dual-ingested into the
// thread's retrieval scope (OpenAI thread vector store + local chunks).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    requireActiveSubscription(user.orgId);
    const { id } = await params;
    const thread = getDb()
      .prepare("SELECT id FROM threads WHERE id = ? AND user_id = ?")
      .get(id, user.id);
    if (!thread) return Response.json({ error: "Thread not found" }, { status: 404 });

    const form = await request.formData();
    const files = form.getAll("files") as File[];
    if (files.length === 0) {
      return Response.json({ error: "No files provided" }, { status: 400 });
    }
    const attachments: (Attachment & { syncWarning?: string })[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        return Response.json(
          { error: `${file.name} exceeds the 50MB limit` },
          { status: 413 }
        );
      }
      const buffer = Buffer.from(await file.arrayBuffer());
      if (isImageFile(file.name, file.type)) {
        const rel = `${uid()}-${file.name.replace(/[^\w.-]/g, "_")}`;
        fs.writeFileSync(path.join(UPLOADS_DIR, rel), buffer);
        attachments.push({ kind: "image", name: file.name, path: rel, mime: file.type });
      } else {
        const result = await ingestDocument({
          target: { scope: "thread", threadId: id },
          name: file.name,
          buffer,
          mime: file.type || undefined,
        });
        attachments.push({
          kind: "document",
          name: file.name,
          documentId: result.documentId,
          syncWarning: result.localOk ? undefined : "indexing failed",
        });
      }
    }
    return Response.json({ attachments });
  } catch (e) {
    return errorResponse(e);
  }
}
