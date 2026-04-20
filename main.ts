// chat-responses-proxy
// Translates OpenAI Chat Completions (what Vibe and friends speak) to the
// Perplexity Agent API / OpenAI Responses format.
//
//   deno task start                    # run the proxy
//   deno task start -- --verbose       # verbose logging
//   deno test                          # run the test suite

const DEFAULT_PORT = 8000;
const CONFIG_PATH = `${
  Deno.env.get("HOME") ?? ""
}/.config/chat-responses-proxy.json`;

// ---------- logging ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function truncate(s: string, max = 2000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}${dim(`… (+${s.length - max} chars)`)}`;
}

export function createLogger(verbose: boolean) {
  return function vlog(tag: string, label: string, payload?: unknown) {
    if (!verbose) return;
    const stamp = new Date().toISOString().slice(11, 23);
    const header = `${dim(stamp)} ${tag} ${label}`;
    if (payload === undefined) {
      console.error(header);
      return;
    }
    const body = typeof payload === "string"
      ? payload
      : JSON.stringify(payload, null, 2);
    console.error(`${header}\n${truncate(body)}`);
  };
}

// ---------- config (env → file → interactive prompt) ----------

export type Config = { chatUrl: string; chatKey: string };

async function loadConfigFile(path = CONFIG_PATH): Promise<Partial<Config>> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return {};
  }
}

async function saveConfigFile(cfg: Config, path = CONFIG_PATH): Promise<void> {
  try {
    const dir = path.slice(0, path.lastIndexOf("/"));
    if (dir) await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));
    await Deno.chmod(path, 0o600); // key is sensitive
  } catch (e) {
    console.warn(`Could not persist config to ${path}: ${e}`);
  }
}

/** Normalize the Agent API base URL: strip trailing slash and any trailing /agent or /responses. */
export function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").replace(/\/(agent|responses)$/, "");
}

function promptLine(label: string, opts: { default?: string } = {}): string {
  const suffix = opts.default ? ` [${opts.default}]` : "";
  const value = prompt(`${label}${suffix}:`) ?? "";
  const trimmed = value.trim();
  if (!trimmed && opts.default) return opts.default;
  return trimmed;
}

export async function resolveConfig(opts: {
  env?: { CHAT_URL?: string; CHAT_API_KEY?: string };
  configPath?: string;
  interactive?: boolean;
} = {}): Promise<Config> {
  const env = opts.env ?? {
    CHAT_URL: Deno.env.get("CHAT_URL"),
    CHAT_API_KEY: Deno.env.get("CHAT_API_KEY"),
  };
  const path = opts.configPath ?? CONFIG_PATH;
  const interactive = opts.interactive ?? true;

  const envUrl = env.CHAT_URL?.trim();
  const envKey = env.CHAT_API_KEY?.trim();
  const fileCfg = await loadConfigFile(path);

  let chatUrl = envUrl || fileCfg.chatUrl || "";
  let chatKey = envKey || fileCfg.chatKey || "";
  let shouldSave = false;

  if (!chatUrl) {
    if (!interactive) throw new Error("CHAT_URL not set");
    chatUrl = promptLine("Agent API base URL", {
      default: "https://api.perplexity.ai/v1",
    });
    if (!chatUrl) {
      console.error("Base URL is required.");
      Deno.exit(1);
    }
    shouldSave = true;
  }

  chatUrl = normalizeBaseUrl(chatUrl);

  if (!chatKey) {
    if (!interactive) throw new Error("CHAT_API_KEY not set");
    chatKey = promptLine("Agent API key (e.g. pplx-...)");
    if (!chatKey) {
      console.error("API key is required.");
      Deno.exit(1);
    }
    shouldSave = true;
  }

  if (shouldSave && interactive) {
    const answer = (prompt(`Save these to ${path}? [Y/n]:`) ?? "").trim()
      .toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      await saveConfigFile({ chatUrl, chatKey }, path);
      console.log(`Saved. Delete ${path} to reset.`);
    }
  }

  return { chatUrl, chatKey };
}

// ---------- request translation: chat.completions → Responses ----------

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: string; text?: string }> | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
  name?: string;
};

export type ChatCompletionsRequest = {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
};

export function messageText(msg: ChatMessage): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) =>
        p.type === "text" || p.type === "input_text" || p.type === "output_text"
      )
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

/**
 * Translate a chat-completions tool definition to the Responses format.
 *
 * chat.completions: { type: "function", function: { name, description, parameters } }
 * responses:        { type: "function", name, description, parameters, strict? }
 *
 * Built-in Responses tools (web_search, fetch_url, etc.) pass through untouched.
 */
export function translateTool(tool: unknown): unknown {
  if (!tool || typeof tool !== "object") return tool;
  const t = tool as Record<string, unknown>;
  if (t.type !== "function") return tool; // web_search, fetch_url, etc.

  // Already in Responses shape (has top-level name).
  if (typeof t.name === "string") return tool;

  const fn = (t.function ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { type: "function" };
  if (typeof fn.name === "string") out.name = fn.name;
  if (typeof fn.description === "string") out.description = fn.description;
  if (fn.parameters !== undefined) out.parameters = fn.parameters;
  if (typeof fn.strict === "boolean") out.strict = fn.strict;
  return out;
}

/**
 * Translate tool_choice between shapes.
 *
 * chat.completions: "auto" | "none" | "required" | { type: "function", function: { name } }
 * responses:        "auto" | "none" | "required" | { type: "function", name }
 */
export function translateToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  if (!choice || typeof choice !== "object") return choice;
  const c = choice as Record<string, unknown>;
  if (
    c.type === "function" && c.function &&
    typeof (c.function as Record<string, unknown>).name === "string"
  ) {
    return {
      type: "function",
      name: (c.function as Record<string, unknown>).name,
    };
  }
  return choice;
}

export function toResponsesRequest(
  body: ChatCompletionsRequest,
): Record<string, unknown> {
  const systems: string[] = [];
  // Responses `input` is a mixed array of message items and tool-call/result items.
  const input: Array<Record<string, unknown>> = [];

  for (const m of body.messages ?? []) {
    if (m.role === "system") {
      const text = messageText(m);
      if (text) systems.push(text);
      continue;
    }

    if (m.role === "tool") {
      // chat.completions tool result → Responses function_call_output item.
      input.push({
        type: "function_call_output",
        call_id: m.tool_call_id ?? "",
        output: messageText(m),
      });
      continue;
    }

    if (m.role === "assistant") {
      const text = messageText(m);
      if (text) {
        input.push({
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      // Emit each tool_call as a separate function_call item in input order.
      for (const tc of m.tool_calls ?? []) {
        if (tc.type && tc.type !== "function") continue;
        input.push({
          type: "function_call",
          call_id: tc.id ?? "",
          name: tc.function?.name ?? "",
          arguments: tc.function?.arguments ?? "",
        });
      }
      continue;
    }

    // user
    const text = messageText(m);
    input.push({
      role: "user",
      content: [{ type: "input_text", text }],
    });
  }

  const req: Record<string, unknown> = {
    model: body.model,
    input,
    stream: !!body.stream,
  };
  if (systems.length) req.instructions = systems.join("\n\n");
  if (typeof body.temperature === "number") req.temperature = body.temperature;
  if (typeof body.max_tokens === "number") {
    req.max_output_tokens = body.max_tokens;
  }
  if (Array.isArray(body.tools) && body.tools.length) {
    req.tools = body.tools.map(translateTool);
    if (body.tool_choice !== undefined) {
      req.tool_choice = translateToolChoice(body.tool_choice);
    }
  }
  return req;
}

// ---------- response translation: Responses → chat.completions ----------

export type ResponsesOutputItem = {
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
  // function_call items:
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
};

export type ResponsesResponse = {
  id?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
  output?: ResponsesOutputItem[];
  output_text?: string;
};

export function extractAssistantText(data: ResponsesResponse): string {
  if (typeof data.output_text === "string" && data.output_text.length) {
    return data.output_text;
  }
  for (const item of data.output ?? []) {
    if (item.type === "message" && Array.isArray(item.content)) {
      const text = item.content
        .filter((c) => c.type === "output_text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("");
      if (text) return text;
    }
  }
  return "";
}

export function extractToolCalls(data: ResponsesResponse) {
  const calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }> = [];
  for (const item of data.output ?? []) {
    if (item.type === "function_call") {
      calls.push({
        id: item.call_id ?? item.id ?? `call_${calls.length}`,
        type: "function",
        function: { name: item.name ?? "", arguments: item.arguments ?? "" },
      });
    }
  }
  return calls;
}

export function toChatCompletion(model: string, data: ResponsesResponse) {
  const content = extractAssistantText(data);
  const toolCalls = extractToolCalls(data);
  const u = data.usage ?? {};
  const message: Record<string, unknown> = {
    role: "assistant",
    content: content || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: data.id ?? `chatcmpl-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: toolCalls.length ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: u.input_tokens ?? 0,
      completion_tokens: u.output_tokens ?? 0,
      total_tokens: u.total_tokens ?? 0,
    },
  };
}

// ---------- streaming bridge: Responses SSE → chat.completions SSE ----------

export function streamBridge(
  upstream: Response,
  model: string,
  opts: {
    reqId?: number;
    started?: number;
    vlog?: ReturnType<typeof createLogger>;
  } = {},
): Response {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const tag = cyan(`[#${opts.reqId ?? 0}]`);
  const started = opts.started ?? performance.now();
  const vlog = opts.vlog ?? (() => {});
  let deltaCount = 0;
  let totalChars = 0;
  let sawToolCall = false;
  // Responses streams function calls out of order; we assign a stable index per item_id.
  const toolCallIndex = new Map<string, number>();
  let nextToolIndex = 0;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

      // Initial role chunk (OpenAI convention).
      send({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{
          index: 0,
          delta: { role: "assistant" },
          finish_reason: null,
        }],
      });

      const reader = upstream.body!.getReader();
      let buffer = "";
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          let idx;
          while ((idx = buffer.indexOf("\n\n")) !== -1) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const dataLines = block
              .split("\n")
              .filter((l) => l.startsWith("data:"))
              .map((l) => l.slice(5).trimStart());
            if (!dataLines.length) continue;
            const payload = dataLines.join("\n");
            if (payload === "[DONE]") continue;

            let evt: {
              type?: string;
              delta?: string;
              response?: ResponsesResponse;
            };
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }

            if (
              evt.type === "response.output_text.delta" &&
              typeof evt.delta === "string"
            ) {
              deltaCount++;
              totalChars += evt.delta.length;
              if (deltaCount <= 3) {
                vlog(tag, `${yellow("·")} delta #${deltaCount}`, evt.delta);
              }
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: { content: evt.delta },
                  finish_reason: null,
                }],
              });
            } else if (
              evt.type === "response.output_item.added" &&
              (evt as { item?: ResponsesOutputItem }).item?.type ===
                "function_call"
            ) {
              // New function call started — emit the opening tool_call delta with name + id.
              const item = (evt as { item: ResponsesOutputItem }).item;
              const key = item.id ?? item.call_id ?? `fc_${nextToolIndex}`;
              const idx = nextToolIndex++;
              toolCallIndex.set(key, idx);
              sawToolCall = true;
              // Some providers ship the function call fully-formed in the
              // `output_item.added` event — `arguments` is already populated
              // and there are no subsequent `response.function_call_arguments.delta`
              // events. Inline the arguments here so the client sees the
              // complete tool call either way.
              const inlineArgs = typeof item.arguments === "string"
                ? item.arguments
                : "";
              vlog(
                tag,
                `${yellow("ƒ")} tool_call #${idx} name=${item.name}${
                  inlineArgs ? ` args=${inlineArgs.length}b (inline)` : ""
                }`,
              );
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: idx,
                      id: item.call_id ?? item.id ?? `call_${idx}`,
                      type: "function",
                      function: {
                        name: item.name ?? "",
                        arguments: inlineArgs,
                      },
                    }],
                  },
                  finish_reason: null,
                }],
              });
            } else if (
              evt.type === "response.function_call_arguments.delta" &&
              typeof evt.delta === "string"
            ) {
              const key = (evt as { item_id?: string }).item_id ?? "";
              const idx = toolCallIndex.get(key) ?? 0;
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{
                  index: 0,
                  delta: {
                    tool_calls: [{
                      index: idx,
                      function: { arguments: evt.delta },
                    }],
                  },
                  finish_reason: null,
                }],
              });
            } else if (
              evt.type === "response.completed" || evt.type === "response.done"
            ) {
              vlog(tag, `${green("✓")} upstream event ${evt.type}`);
              // Only backfill if we got zero deltas (some providers ship the full
              // text only in the terminal event). If we already streamed deltas,
              // emitting the final text would duplicate the whole response.
              const finalText = deltaCount === 0 && evt.response
                ? extractAssistantText(evt.response)
                : "";
              if (finalText) {
                send({
                  id,
                  object: "chat.completion.chunk",
                  created,
                  model,
                  choices: [{
                    index: 0,
                    delta: { content: finalText },
                    finish_reason: null,
                  }],
                });
              }
            } else if (evt.type === "response.error" || evt.type === "error") {
              vlog(tag, `${red("✗")} upstream error event`, evt);
              send({
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
              });
            } else {
              // Unknown / unhandled event — dump the full payload so we can
              // diagnose cases where upstream sends error details, alternate
              // event names, or malformed frames. We log the first ~500 chars
              // to keep the output readable.
              const preview = payload.length > 500
                ? payload.slice(0, 500) + "…"
                : payload;
              vlog(
                tag,
                dim(`· ignored event ${evt.type ?? "?"} raw=${preview}`),
              );
            }
          }
        }
      } catch (e) {
        console.error("Stream bridge error:", e);
      } finally {
        vlog(
          tag,
          `${green("←")} stream done ${
            (performance.now() - started).toFixed(0)
          }ms deltas=${deltaCount} chars=${totalChars} tool_calls=${nextToolIndex}`,
        );
        send({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: sawToolCall ? "tool_calls" : "stop",
          }],
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------- server factory ----------

export function createHandler(cfg: Config, opts: { verbose?: boolean } = {}) {
  const vlog = createLogger(opts.verbose ?? false);
  let reqCounter = 0;

  return async function handler(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/v1/models") {
      const upstream = await fetch(`${cfg.chatUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.chatKey}` },
      });
      return new Response(upstream.body, {
        status: upstream.status,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    if (
      url.pathname !== "/v1/chat/completions" &&
      url.pathname !== "/chat/completions"
    ) {
      return new Response("Not found", { status: 404 });
    }

    let body: ChatCompletionsRequest;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const reqId = ++reqCounter;
    const tag = cyan(`[#${reqId}]`);
    const started = performance.now();

    const agentReq = toResponsesRequest(body);
    const wantsStream = !!body.stream;

    vlog(
      tag,
      `${
        green("→")
      } chat.completions model=${body.model} stream=${wantsStream} msgs=${
        body.messages?.length ?? 0
      } tools=${body.tools?.length ?? 0}`,
      body,
    );
    vlog(tag, `${green("→")} POST ${cfg.chatUrl}/agent (translated)`, agentReq);

    const upstream = await fetch(`${cfg.chatUrl}/agent`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.chatKey}`,
        "Content-Type": "application/json",
        Accept: wantsStream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(agentReq),
    });

    if (!upstream.ok) {
      const text = await upstream.text();
      vlog(
        tag,
        `${red("✗")} upstream ${upstream.status} in ${
          (performance.now() - started).toFixed(0)
        }ms`,
        text,
      );
      return new Response(
        JSON.stringify({
          error: { message: text, upstream_status: upstream.status },
        }),
        {
          status: upstream.status,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (wantsStream) {
      vlog(tag, `${yellow("⇌")} streaming bridge started`);
      return streamBridge(upstream, body.model, { reqId, started, vlog });
    }

    const data = await upstream.json();
    const out = toChatCompletion(body.model, data);
    vlog(
      tag,
      `${green("←")} chat.completion ${
        (performance.now() - started).toFixed(0)
      }ms tokens=${out.usage.total_tokens}`,
      data,
    );
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

// ---------- entry point ----------

export async function main(args: string[] = Deno.args): Promise<void> {
  const verbose = args.includes("--verbose") || args.includes("-v") ||
    Deno.env.get("PROXY_VERBOSE") === "1";

  const portArg = args.find((a) => a.startsWith("--port="));
  const port = portArg ? Number(portArg.split("=")[1]) : DEFAULT_PORT;

  const cfg = await resolveConfig();
  console.log(`Proxy listening on http://localhost:${port}`);
  console.log(`Forwarding to ${cfg.chatUrl}/agent`);
  if (verbose) {
    console.log(
      dim(
        "Verbose logging enabled — request/response pairs will be logged to stderr.",
      ),
    );
  }

  const handler = createHandler(cfg, { verbose });
  Deno.serve({ port }, handler);
}

if (import.meta.main) {
  await main();
}
