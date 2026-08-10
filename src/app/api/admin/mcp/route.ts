import { getDb, uid } from "@/lib/db";
import { requireAdmin, requireUser, errorResponse } from "@/lib/auth";
import { listMcpServers } from "@/lib/mcp";

export async function GET() {
  try {
    const user = await requireUser();
    return Response.json({ servers: listMcpServers(user.orgId) });
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const { name, url, headers, allowedTools, description } = await request.json();
    if (!name || !url || !/^https?:\/\//.test(url)) {
      return Response.json(
        { error: "A name and an http(s) MCP server URL are required" },
        { status: 400 }
      );
    }
    const id = uid();
    getDb()
      .prepare(
        "INSERT INTO mcp_servers (id, org_id, name, url, headers, allowed_tools, description) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id,
        admin.orgId,
        String(name).trim(),
        String(url).trim(),
        JSON.stringify(headers ?? {}),
        allowedTools && Array.isArray(allowedTools) && allowedTools.length > 0
          ? JSON.stringify(allowedTools)
          : null,
        description ?? null
      );
    return Response.json({ id });
  } catch (e) {
    return errorResponse(e);
  }
}
