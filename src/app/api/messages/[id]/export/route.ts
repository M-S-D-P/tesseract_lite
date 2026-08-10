import { getDb } from "@/lib/db";
import { requireUser, errorResponse } from "@/lib/auth";
import { markdownToPdf, markdownToDocx } from "@/lib/export";

// GET /api/messages/:id/export?format=pdf|docx — download an answer as a
// formatted document.
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const format = new URL(request.url).searchParams.get("format") ?? "pdf";
    const row = getDb()
      .prepare(
        `SELECT m.content, t.title FROM messages m
         JOIN threads t ON t.id = m.thread_id
         WHERE m.id = ? AND t.org_id = ? AND t.user_id = ?`
      )
      .get(id, user.orgId, user.id) as { content: string; title: string } | undefined;
    if (!row || !row.content) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    const title = row.title === "New chat" ? "Tesseract answer" : row.title;
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === "docx") {
      const buffer = await markdownToDocx(row.content, title);
      return new Response(new Uint8Array(buffer), {
        headers: {
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "Content-Disposition": `attachment; filename="tesseract-${stamp}.docx"`,
        },
      });
    }
    const buffer = await markdownToPdf(row.content, title);
    return new Response(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="tesseract-${stamp}.pdf"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
