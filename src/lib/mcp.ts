import { getDb } from "./db";

export type McpServerRow = {
  id: string;
  name: string;
  url: string;
  headers: string;
  allowed_tools: string | null;
  description: string | null;
  enabled: number;
  created_at: string;
};

export function listMcpServers(orgId: string, onlyEnabled = false): McpServerRow[] {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM mcp_servers WHERE org_id = ? ${onlyEnabled ? "AND enabled = 1" : ""} ORDER BY created_at`
    )
    .all(orgId) as McpServerRow[];
}

// Builds native Responses-API MCP tool entries from enabled servers.
export function buildMcpTools(orgId: string): Record<string, unknown>[] {
  return listMcpServers(orgId, true).map((s) => {
    const tool: Record<string, unknown> = {
      type: "mcp",
      server_label: s.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "server",
      server_url: s.url,
      require_approval: "never",
    };
    if (s.description) tool.server_description = s.description;
    const headers = JSON.parse(s.headers || "{}");
    if (Object.keys(headers).length > 0) tool.headers = headers;
    if (s.allowed_tools) {
      const allowed = JSON.parse(s.allowed_tools);
      if (Array.isArray(allowed) && allowed.length > 0) tool.allowed_tools = allowed;
    }
    return tool;
  });
}
