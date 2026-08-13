import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { RailsLogParser } from "@/lib/runtime/parser";
import { recordRequest } from "@/lib/runtime/store";

export const maxDuration = 300;

// POST /api/runtime/ingest — HTTP alternative to the TCP listener, for apps
// that can't open a socket to us (containers, CI, another host).
//
//   curl -X POST http://localhost:3005/api/runtime/ingest \
//     -H "X-Tesseract-Token: <token>" --data-binary @log/development.log
//
// Body is raw Rails log text (or newline-delimited). Auth is a shared token
// rather than a session, because the caller is a machine, not a browser.
export async function POST(request: Request) {
  const token = request.headers.get("x-tesseract-token") ?? "";
  const db = getDb();
  const orgs = db.prepare("SELECT id FROM orgs").all() as { id: string }[];

  let orgId: string | null = null;
  for (const o of orgs) {
    const expected = getSetting(o.id, "runtime_ingest_token");
    if (expected && token && expected === token) {
      orgId = o.id;
      break;
    }
  }
  if (!orgId) {
    return Response.json(
      { error: "Invalid or missing X-Tesseract-Token. Generate one in Tuning → Live runtime." },
      { status: 401 }
    );
  }

  const text = await request.text();
  let count = 0;
  const parser = new RailsLogParser((req) => {
    recordRequest(orgId!, req, "http");
    count++;
  });
  for (const line of text.split("\n")) parser.push(line);
  parser.flush();

  return Response.json({ ok: true, requests: count });
}
