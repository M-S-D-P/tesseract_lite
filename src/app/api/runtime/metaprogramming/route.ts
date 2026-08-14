import { requireUser, errorResponse } from "@/lib/auth";
import { metaprogrammingReport } from "@/lib/runtime/store";
import { visibleSourceIds } from "@/lib/runtime/sources";

// The question static analysis cannot answer: which methods actually executed
// that are not written in the source they came from. Reading the code cannot
// produce this list; only watching the application run can.
export async function GET() {
  try {
    const user = await requireUser();
    return Response.json(
      await metaprogrammingReport(
        user.orgId,
        visibleSourceIds(user.orgId, user.id, user.role === "admin"),
        user.id
      )
    );
  } catch (e) {
    return errorResponse(e);
  }
}
