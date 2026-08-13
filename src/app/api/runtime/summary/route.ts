import { requireUser, requireAdmin, errorResponse } from "@/lib/auth";
import { runtimeSummary } from "@/lib/runtime/store";
import { visibleSourceIds } from "@/lib/runtime/sources";
import { getSetting, setSetting } from "@/lib/settings";
import { getDb } from "@/lib/db";
import crypto from "crypto";

export async function GET(request: Request) {
  try {
    const user = await requireUser();
    const minutes = Number(new URL(request.url).searchParams.get("minutes")) || 60;
    return Response.json({
      ...runtimeSummary(
        user.orgId,
        minutes,
        visibleSourceIds(user.orgId, user.id, user.role === "admin")
      ),
      ingestToken: getSetting(user.orgId, "runtime_ingest_token"),
      logPort: process.env.RUNTIME_LOG_PORT || "9999",
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// Rotate/create the machine token used by the HTTP ingest endpoint.
export async function POST() {
  try {
    const admin = await requireAdmin();
    const token = crypto.randomBytes(24).toString("hex");
    setSetting(admin.orgId, "runtime_ingest_token", token);
    return Response.json({ token });
  } catch (e) {
    return errorResponse(e);
  }
}

// Clear the rolling window.
export async function DELETE() {
  try {
    const admin = await requireAdmin();
    const db = getDb();
    db.prepare("DELETE FROM runtime_queries WHERE org_id = ?").run(admin.orgId);
    db.prepare("DELETE FROM runtime_requests WHERE org_id = ?").run(admin.orgId);
    return Response.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
