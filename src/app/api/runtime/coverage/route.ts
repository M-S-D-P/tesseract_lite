import { requireUser, errorResponse } from "@/lib/auth";
import { runtimeCoverage } from "@/lib/runtime/store";
import { visibleSourceIds } from "@/lib/runtime/sources";

// Static code graph vs. what runtime actually exercised. This is the question
// an APM cannot answer, because an APM never parsed the source.
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(
      runtimeCoverage(
        user.orgId,
        visibleSourceIds(user.orgId, user.id, user.role === "admin")
      )
    );
  } catch (e) {
    return errorResponse(e);
  }
}
