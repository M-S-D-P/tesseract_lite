import Anthropic from "@anthropic-ai/sdk";
import type { ReasoningTier } from "../models";
import { listMcpServers } from "../mcp";
import { recordMetric } from "../metrics";
import { FILE_TOOL_SCHEMA, FILE_TOOL_DESCRIPTION } from "../filegen";

// Tesseract Lite is Claude-only. Retrieval always runs through the LOCAL
// vector index via function tools, and full message history is replayed on
// every turn (no server-side conversation state).

export function providerConfigured(): string | null {
  if (!process.env.ANTHROPIC_API_KEY) {
    return "ANTHROPIC_API_KEY is not set — add it to .env.local and restart.";
  }
  return null;
}

export type ProviderRunContext = {
  orgId: string;
  model: string;
  tier: ReasoningTier;
  systemPrompt: string;
  webSearch: boolean;
  history: { role: "user" | "assistant"; content: string }[];
  userText: string;
  images: { mime: string; dataB64: string }[];
  enableKbTool: boolean;
  enableGraphTool: boolean;
  enableRuntimeTool?: boolean;
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>;
  emitDelta: (text: string) => void;
  emitTool: (name: string) => void;
  signal?: AbortSignal;
};

export type ProviderResult = { text: string };

const KB_TOOL_DESCRIPTION =
  "Search the organization's knowledge base (documents, GitHub repositories, Confluence pages, uploaded files). Use whenever the answer may depend on internal knowledge, code, or attached files.";
const GRAPH_TOOL_DESCRIPTION =
  "Query the structured application graph extracted from ingested Rails codebases: models, associations, DB tables, routes/APIs, controllers, jobs, services — with file provenance. Prefer over text search for questions about app structure or relationships.";
const RUNTIME_TOOL_DESCRIPTION =
  "Query LIVE runtime telemetry streamed from the running Rails application: request volume, slowest controller actions, failing endpoints, N+1 query patterns, hottest SQL, and recent requests. action=coverage compares the indexed source against observed traffic: which controllers are exercised, which serve no traffic, and which serve traffic without appearing in the source at all. action=metaprogramming lists methods that DID execute but are not defined in the source file they came from — Rails generates methods at runtime (concerns, generated association and attribute methods, scopes, delegation, method_missing), so this is evidence reading the code cannot produce. ALWAYS call action=metaprogramming when asked what is dynamically generated, what static analysis would miss, or how metaprogramming is handled — never answer those from general knowledge of Rails.";

const KB_TOOL_SCHEMA = {
  type: "object",
  properties: { query: { type: "string", description: "The search query" } },
  required: ["query"],
} as const;

const GRAPH_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["overview", "list", "inspect"] },
    kind: {
      type: "string",
      enum: ["model", "table", "controller", "route", "job", "service", "class", "function", "trace"],
    },
    name: { type: "string" },
  },
  required: ["action"],
} as const;

const RUNTIME_TOOL_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["summary", "recent", "coverage", "metaprogramming"],
    },
    minutes: { type: "number" },
    limit: { type: "number" },
  },
  required: ["action"],
} as const;

const MAX_TOOL_LOOPS = 6;

declare global {
  // eslint-disable-next-line no-var
  var __tesseractAnthropic: Anthropic | undefined;
}

function anthropicClient(): Anthropic {
  if (!globalThis.__tesseractAnthropic) {
    globalThis.__tesseractAnthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return globalThis.__tesseractAnthropic;
}

// Reasoning tier → effort. Balanced maps to the API default ("high").
const ANTHROPIC_EFFORT: Record<ReasoningTier, "low" | "high" | "xhigh"> = {
  low: "low",
  medium: "high",
  high: "xhigh",
};

export async function runAnthropic(ctx: ProviderRunContext): Promise<ProviderResult> {
  const client = anthropicClient();
  const isHaiku = ctx.model.includes("haiku");

  const tools: Record<string, unknown>[] = [];
  if (ctx.enableKbTool) {
    tools.push({
      name: "search_knowledge_base",
      description: KB_TOOL_DESCRIPTION,
      input_schema: KB_TOOL_SCHEMA,
    });
  }
  if (ctx.enableGraphTool) {
    tools.push({
      name: "query_app_graph",
      description: GRAPH_TOOL_DESCRIPTION,
      input_schema: GRAPH_TOOL_SCHEMA,
    });
  }
  if (ctx.enableRuntimeTool) {
    tools.push({
      name: "query_runtime",
      description: RUNTIME_TOOL_DESCRIPTION,
      input_schema: RUNTIME_TOOL_SCHEMA,
    });
  }
  tools.push({
    name: "generate_file",
    description: FILE_TOOL_DESCRIPTION,
    input_schema: FILE_TOOL_SCHEMA,
  });
  if (ctx.webSearch) {
    tools.push({ type: "web_search_20260209", name: "web_search" });
  }

  // Admin-configured MCP servers ride along via the MCP connector beta.
  const mcpServers = listMcpServers(ctx.orgId, true).map((s) => {
    const headers = JSON.parse(s.headers || "{}") as Record<string, string>;
    const bearer = Object.values(headers)
      .find((v) => v.startsWith("Bearer "))
      ?.slice(7);
    const entry: Record<string, unknown> = {
      type: "url",
      name: s.name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "server",
      url: s.url,
    };
    if (bearer) entry.authorization_token = bearer;
    return entry;
  });
  for (const s of mcpServers) {
    tools.push({ type: "mcp_toolset", mcp_server_name: s.name });
  }

  type MessageParam = Anthropic.Beta.BetaMessageParam;
  const messages: MessageParam[] = ctx.history
    .filter((m) => m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const userContent: Anthropic.Beta.BetaContentBlockParam[] = [
    { type: "text", text: ctx.userText },
    ...ctx.images.map(
      (img) =>
        ({
          type: "image",
          source: {
            type: "base64",
            media_type: img.mime as "image/png",
            data: img.dataB64,
          },
        }) as Anthropic.Beta.BetaImageBlockParam
    ),
  ];
  messages.push({ role: "user", content: userContent });

  const runTurn = (extraMessages: MessageParam[] = []) =>
    client.beta.messages.stream(
      {
        model: ctx.model,
        max_tokens: 64000,
        // Long system prompts are marked cacheable so repeat turns against the
        // same configuration skip re-processing the prefix.
        system:
          ctx.systemPrompt.length > 4000
            ? ([
                {
                  type: "text",
                  text: ctx.systemPrompt,
                  cache_control: { type: "ephemeral" },
                },
              ] as never)
            : ctx.systemPrompt,
        messages: [...messages, ...extraMessages],
        ...(tools.length > 0 ? { tools: tools as never } : {}),
        ...(mcpServers.length > 0
          ? { mcp_servers: mcpServers as never, betas: ["mcp-client-2025-11-20"] }
          : {}),
        ...(isHaiku ? {} : { thinking: { type: "adaptive" } as never }),
        ...(isHaiku ? {} : { output_config: { effort: ANTHROPIC_EFFORT[ctx.tier] } as never }),
      },
      { signal: ctx.signal }
    );

  let text = "";
  let hitCap = false;
  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    const stream = runTurn();

    stream.on("text", (delta) => {
      text += delta;
      ctx.emitDelta(delta);
    });

    const message = await stream.finalMessage();
    recordMetric(ctx.orgId, "chat_input_tokens", message.usage.input_tokens ?? 0, ctx.model);
    recordMetric(ctx.orgId, "chat_output_tokens", message.usage.output_tokens ?? 0, ctx.model);

    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    if (message.stop_reason !== "tool_use") break;

    const toolUses = message.content.filter(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use"
    );
    messages.push({ role: "assistant", content: message.content });
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of toolUses) {
      ctx.emitTool(
        call.name === "search_knowledge_base"
          ? "knowledge_base"
          : call.name === "generate_file"
            ? "generate_file"
            : "app_graph"
      );
      let output: string;
      try {
        output = await ctx.executeTool(call.name, call.input as Record<string, unknown>);
      } catch (e) {
        output = JSON.stringify({ error: (e as Error).message });
      }
      results.push({ type: "tool_result", tool_use_id: call.id, content: output });
    }
    messages.push({ role: "user", content: results });
    if (loop === MAX_TOOL_LOOPS - 1) hitCap = true;
  }

  // The tool loop hit its cap while the model still wanted to investigate
  // further. Without this, whatever it gathered on the final round trip is
  // silently discarded and the reply is left as just the narration text that
  // preceded each tool call — thorough models (more tool calls per turn) hit
  // this far more than terse ones, which made them look worse, not better.
  // One last no-more-tools turn forces a synthesis from what's already in.
  if (hitCap) {
    const stream = runTurn([
      {
        role: "user",
        content:
          "You've gathered enough context. Answer the question now using what you found — do not call any more tools.",
      },
    ]);
    stream.on("text", (delta) => {
      text += delta;
      ctx.emitDelta(delta);
    });
    const message = await stream.finalMessage();
    recordMetric(ctx.orgId, "chat_input_tokens", message.usage.input_tokens ?? 0, ctx.model);
    recordMetric(ctx.orgId, "chat_output_tokens", message.usage.output_tokens ?? 0, ctx.model);
  }

  return { text };
}

// Single-shot, no tools — used by the plain-RAG fallback where retrieval has
// already happened and the context is in the prompt.
export async function answerWithoutTools(opts: {
  orgId: string;
  model: string;
  tier: ReasoningTier;
  systemPrompt: string;
  userText: string;
  signal?: AbortSignal;
}): Promise<string> {
  const isHaiku = opts.model.includes("haiku");
  // Non-streaming .create() throws client-side ("Streaming is required for
  // operations that may take longer than 10 minutes") once max_tokens is
  // this high combined with elevated effort — every non-Haiku call failed
  // before reaching the network. Stream instead, same as runAnthropic.
  const stream = anthropicClient().beta.messages.stream(
    {
      model: opts.model,
      max_tokens: 32000,
      system: opts.systemPrompt,
      messages: [{ role: "user", content: opts.userText }],
      ...(isHaiku ? {} : { output_config: { effort: ANTHROPIC_EFFORT[opts.tier] } as never }),
    },
    { signal: opts.signal }
  );
  const message = await stream.finalMessage();
  recordMetric(opts.orgId, "chat_input_tokens", message.usage.input_tokens ?? 0, opts.model);
  recordMetric(opts.orgId, "chat_output_tokens", message.usage.output_tokens ?? 0, opts.model);
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}

export async function listAnthropicModels(): Promise<string[]> {
  if (!process.env.ANTHROPIC_API_KEY) return [];
  try {
    const out: string[] = [];
    for await (const m of anthropicClient().models.list()) out.push(m.id);
    return out;
  } catch {
    return [];
  }
}
