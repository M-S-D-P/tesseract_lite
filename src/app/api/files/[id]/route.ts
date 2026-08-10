import { requireUser, errorResponse } from "@/lib/auth";
import { loadGeneratedFile } from "@/lib/filegen";

// GET /api/files/:id — download a model-generated artifact (org-scoped).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await requireUser();
    const { id } = await params;
    const file = loadGeneratedFile(id, user.orgId);
    if (!file) return Response.json({ error: "Not found" }, { status: 404 });
    return new Response(new Uint8Array(file.buffer), {
      headers: {
        "Content-Type": file.mime,
        "Content-Disposition": `attachment; filename="${file.name}"`,
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}
