import { requireUser, errorResponse } from "@/lib/auth";
import { listBranches } from "@/lib/github";

// GET /api/github/branches?url=... — branch list for the picker on the add-repo
// form. Also reports whether the repository is private, so the UI can say why
// a token is needed instead of failing at clone time.
export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const url = new URL(request.url).searchParams.get("url") ?? "";
    if (!url.trim()) {
      return Response.json({ error: "A repository URL is required" }, { status: 400 });
    }
    const result = await listBranches(url, user.orgId);
    return Response.json(result);
  } catch (e) {
    // Bad URL, missing repo and rejected token are all user-fixable.
    if (e instanceof Error && !("status" in e)) {
      return Response.json({ error: e.message }, { status: 400 });
    }
    return errorResponse(e);
  }
}
