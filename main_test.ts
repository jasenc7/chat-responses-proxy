import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ChatCompletionsRequest,
  createHandler,
  extractAssistantText,
  extractToolCalls,
  messageText,
  normalizeBaseUrl,
  resolveConfig,
  toChatCompletion,
  toResponsesRequest,
  translateTool,
  translateToolChoice,
} from "./main.ts";

// ---------- unit: normalizeBaseUrl ----------

Deno.test("normalizeBaseUrl strips trailing slash", () => {
  assertEquals(
    normalizeBaseUrl("https://api.perplexity.ai/v1/"),
    "https://api.perplexity.ai/v1",
  );
});

Deno.test("normalizeBaseUrl strips trailing /agent", () => {
  assertEquals(
    normalizeBaseUrl("https://api.perplexity.ai/v1/agent"),
    "https://api.perplexity.ai/v1",
  );
});

Deno.test("normalizeBaseUrl strips trailing /responses", () => {
  assertEquals(
    normalizeBaseUrl("https://api.perplexity.ai/v1/responses"),
    "https://api.perplexity.ai/v1",
  );
});

Deno.test("normalizeBaseUrl leaves canonical URL alone", () => {
  assertEquals(
    normalizeBaseUrl("https://api.perplexity.ai/v1"),
    "https://api.perplexity.ai/v1",
  );
});

// ---------- unit: messageText ----------

Deno.test("messageText handles string content", () => {
  assertEquals(messageText({ role: "user", content: "hello" }), "hello");
});

Deno.test("messageText concatenates array text parts", () => {
  assertEquals(
    messageText({
      role: "user",
      content: [
        { type: "text", text: "foo " },
        { type: "input_text", text: "bar" },
        { type: "image_url", text: "ignored" },
      ],
    }),
    "foo bar",
  );
});

// ---------- unit: toResponsesRequest ----------

Deno.test("toResponsesRequest routes system messages to instructions", () => {
  const out = toResponsesRequest({
    model: "openai/gpt-5.4",
    messages: [
      { role: "system", content: "Be brief." },
      { role: "system", content: "Answer in English." },
      { role: "user", content: "hi" },
    ],
  });
  assertEquals(out.instructions, "Be brief.\n\nAnswer in English.");
  const input = out.input as Array<
    { role: string; content: Array<{ type: string; text: string }> }
  >;
  assertEquals(input.length, 1);
  assertEquals(input[0].role, "user");
  assertEquals(input[0].content[0], { type: "input_text", text: "hi" });
});

Deno.test("toResponsesRequest maps assistant to output_text", () => {
  const out = toResponsesRequest({
    model: "openai/gpt-5.4",
    messages: [
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ],
  });
  const input = out.input as Array<
    { role: string; content: Array<{ type: string; text: string }> }
  >;
  assertEquals(input.map((m) => m.role), ["user", "assistant", "user"]);
  assertEquals(input[1].content[0].type, "output_text");
  assertEquals(input[0].content[0].type, "input_text");
});

Deno.test("toResponsesRequest converts tool results to function_call_output items", () => {
  const out = toResponsesRequest({
    model: "openai/gpt-5.4",
    messages: [
      { role: "user", content: "search for X" },
      { role: "tool", content: '{"result":42}', tool_call_id: "call_123" },
    ],
  });
  const input = out.input as Array<Record<string, unknown>>;
  assertEquals(input[1], {
    type: "function_call_output",
    call_id: "call_123",
    output: '{"result":42}',
  });
});

Deno.test("toResponsesRequest converts assistant tool_calls to function_call items", () => {
  const out = toResponsesRequest({
    model: "openai/gpt-5.4",
    messages: [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "call_abc",
          type: "function",
          function: { name: "list_files", arguments: '{"path":"/"}' },
        }],
      },
      { role: "tool", content: "[a.txt, b.txt]", tool_call_id: "call_abc" },
    ],
  });
  const input = out.input as Array<Record<string, unknown>>;
  // user message, function_call item, function_call_output item — 3 entries, no empty assistant msg.
  assertEquals(input.length, 3);
  assertEquals(input[1], {
    type: "function_call",
    call_id: "call_abc",
    name: "list_files",
    arguments: '{"path":"/"}',
  });
  assertEquals(input[2].type, "function_call_output");
});

Deno.test("toResponsesRequest emits text + tool_calls for assistant with both", () => {
  const out = toResponsesRequest({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: "let me check",
        tool_calls: [{
          id: "c1",
          type: "function",
          function: { name: "read_file", arguments: "{}" },
        }],
      },
    ],
  });
  const input = out.input as Array<Record<string, unknown>>;
  assertEquals(input.length, 2);
  assertEquals(
    (input[0].content as Array<{ text: string }>)[0].text,
    "let me check",
  );
  assertEquals(input[1].type, "function_call");
});

Deno.test("toResponsesRequest renames max_tokens → max_output_tokens", () => {
  const out = toResponsesRequest({
    model: "openai/gpt-5.4",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 256,
    temperature: 0.7,
  });
  assertEquals(out.max_output_tokens, 256);
  assertEquals(out.temperature, 0.7);
  assert(!("max_tokens" in out));
});

Deno.test("toResponsesRequest only sends tool_choice when tools present", () => {
  const withoutTools = toResponsesRequest({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    tool_choice: "auto",
  });
  assert(!("tool_choice" in withoutTools));
  assert(!("tools" in withoutTools));

  const withTools = toResponsesRequest({
    model: "x",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "web_search" }],
    tool_choice: "auto",
  });
  assertEquals(withTools.tool_choice, "auto");
  assertEquals(withTools.tools, [{ type: "web_search" }]);
});

// ---------- unit: translateTool / translateToolChoice ----------

Deno.test("translateTool flattens chat.completions function tools", () => {
  const out = translateTool({
    type: "function",
    function: {
      name: "read_file",
      description: "Read a file",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  });
  assertEquals(out, {
    type: "function",
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  });
});

Deno.test("translateTool preserves strict flag", () => {
  const out = translateTool({
    type: "function",
    function: { name: "x", parameters: {}, strict: true },
  }) as Record<string, unknown>;
  assertEquals(out.strict, true);
});

Deno.test("translateTool leaves built-in Responses tools alone", () => {
  const builtin = { type: "web_search" };
  assertEquals(translateTool(builtin), builtin);
  const fetchUrl = { type: "fetch_url", filters: { domains: ["x.com"] } };
  assertEquals(translateTool(fetchUrl), fetchUrl);
});

Deno.test("translateTool leaves already-Responses-shaped tools alone", () => {
  const already = { type: "function", name: "x", parameters: {} };
  assertEquals(translateTool(already), already);
});

Deno.test("translateToolChoice flattens named function choice", () => {
  assertEquals(
    translateToolChoice({ type: "function", function: { name: "read_file" } }),
    { type: "function", name: "read_file" },
  );
});

Deno.test("translateToolChoice passes strings through", () => {
  assertEquals(translateToolChoice("auto"), "auto");
  assertEquals(translateToolChoice("none"), "none");
  assertEquals(translateToolChoice("required"), "required");
});

Deno.test("toResponsesRequest translates each function tool (the bug this fixes)", () => {
  // This is the exact shape Vibe sends that Perplexity rejected with
  // "function tool name is required" for tools[0..10].
  const out = toResponsesRequest({
    model: "anthropic/claude-sonnet-4-6",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      { type: "function", function: { name: "read_file", parameters: {} } },
      { type: "function", function: { name: "write_file", parameters: {} } },
    ],
    tool_choice: "auto",
  });
  const tools = out.tools as Array<Record<string, unknown>>;
  assertEquals(tools[0].name, "read_file");
  assertEquals(tools[1].name, "write_file");
  // Crucially: no nested .function field remains.
  assert(!("function" in tools[0]));
  assert(!("function" in tools[1]));
});

// ---------- unit: extractAssistantText ----------

Deno.test("extractAssistantText prefers output_text shortcut", () => {
  assertEquals(extractAssistantText({ output_text: "shortcut" }), "shortcut");
});

Deno.test("extractAssistantText walks output[].content[]", () => {
  const text = extractAssistantText({
    output: [
      { type: "search_results" },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }, {
          type: "output_text",
          text: " world",
        }],
      },
    ],
  });
  assertEquals(text, "hello world");
});

Deno.test("extractAssistantText ignores non-message items", () => {
  assertEquals(
    extractAssistantText({
      output: [{ type: "search_results" }, { type: "fetch_url_results" }],
    }),
    "",
  );
});

// ---------- unit: toChatCompletion / extractToolCalls ----------

Deno.test("toChatCompletion builds a valid chat.completion envelope", () => {
  const out = toChatCompletion("openai/gpt-5-mini", {
    id: "resp_abc",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "hi there" }],
    }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  });
  assertEquals(out.id, "resp_abc");
  assertEquals(out.object, "chat.completion");
  assertEquals(out.choices[0].message.content, "hi there");
  assertEquals(out.choices[0].finish_reason, "stop");
  assertEquals(out.usage, {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
  });
});

Deno.test("extractToolCalls pulls function_call items into OpenAI shape", () => {
  const calls = extractToolCalls({
    output: [
      {
        type: "function_call",
        call_id: "call_1",
        name: "read_file",
        arguments: '{"path":"a.txt"}',
      },
      {
        type: "function_call",
        call_id: "call_2",
        name: "list_files",
        arguments: "{}",
      },
    ],
  });
  assertEquals(calls, [
    {
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"a.txt"}' },
    },
    {
      id: "call_2",
      type: "function",
      function: { name: "list_files", arguments: "{}" },
    },
  ]);
});

Deno.test("toChatCompletion surfaces tool_calls and uses finish_reason=tool_calls", () => {
  const out = toChatCompletion("m", {
    output: [{
      type: "function_call",
      call_id: "c1",
      name: "read_file",
      arguments: "{}",
    }],
  });
  assertEquals(out.choices[0].finish_reason, "tool_calls");
  const msg = out.choices[0].message as {
    content: string | null;
    tool_calls: unknown[];
  };
  assertEquals(msg.content, null);
  assertEquals(msg.tool_calls.length, 1);
});

// ---------- unit: resolveConfig ----------

Deno.test("resolveConfig reads from env without prompting", async () => {
  const cfg = await resolveConfig({
    env: {
      CHAT_URL: "https://api.perplexity.ai/v1",
      CHAT_API_KEY: "pplx-test",
    },
    configPath: "/tmp/nonexistent-proxy-config.json",
    interactive: false,
  });
  assertEquals(cfg.chatUrl, "https://api.perplexity.ai/v1");
  assertEquals(cfg.chatKey, "pplx-test");
});

Deno.test("resolveConfig normalizes a bad env URL", async () => {
  const cfg = await resolveConfig({
    env: {
      CHAT_URL: "https://api.perplexity.ai/v1/responses/",
      CHAT_API_KEY: "k",
    },
    configPath: "/tmp/nonexistent-proxy-config.json",
    interactive: false,
  });
  assertEquals(cfg.chatUrl, "https://api.perplexity.ai/v1");
});

Deno.test("resolveConfig reads from a config file when env is empty", async () => {
  const path = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(
    path,
    JSON.stringify({ chatUrl: "http://file.example/v1", chatKey: "file-key" }),
  );
  try {
    const cfg = await resolveConfig({
      env: {},
      configPath: path,
      interactive: false,
    });
    assertEquals(cfg.chatUrl, "http://file.example/v1");
    assertEquals(cfg.chatKey, "file-key");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("resolveConfig throws in non-interactive mode when missing", async () => {
  let threw = false;
  try {
    await resolveConfig({
      env: {},
      configPath: "/tmp/nonexistent-proxy-config.json",
      interactive: false,
    });
  } catch (e) {
    threw = true;
    assertStringIncludes(String(e), "CHAT_URL not set");
  }
  assert(threw, "expected resolveConfig to throw");
});

// ---------- integration: handler against a mock upstream ----------

/** A fake Perplexity Agent API. Understands /models, /agent (JSON), /agent (SSE). */
function mockUpstream(): {
  url: string;
  stop: () => Promise<void>;
  lastRequestBody: () => unknown;
} {
  let lastBody: unknown = null;
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    async (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/models") {
        return Response.json({
          object: "list",
          data: [{ id: "openai/gpt-5-mini" }],
        });
      }
      if (u.pathname !== "/agent") return new Response("nope", { status: 404 });
      const body = await req.json();
      lastBody = body;

      if (body.stream) {
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            const send = (o: unknown) =>
              c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
            send({ type: "response.created" });
            send({ type: "response.output_text.delta", delta: "Hello" });
            send({ type: "response.output_text.delta", delta: " world" });
            send({ type: "response.output_text.delta", delta: "!" });
            // Terminal event with full text attached — bridge must NOT duplicate.
            send({
              type: "response.completed",
              response: {
                output: [{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "Hello world!" }],
                }],
              },
            });
            c.close();
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      return Response.json({
        id: "resp_test",
        object: "response",
        model: body.model,
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "mocked reply" }],
        }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
      });
    },
  );

  return {
    url: `http://localhost:${server.addr.port}`,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
    lastRequestBody: () => lastBody,
  };
}

Deno.test("handler: non-streaming round-trip", async () => {
  const upstream = mockUpstream();
  try {
    const handler = createHandler({ chatUrl: upstream.url, chatKey: "k" });
    const body: ChatCompletionsRequest = {
      model: "openai/gpt-5-mini",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "hi" },
      ],
    };
    const res = await handler(
      new Request("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.object, "chat.completion");
    assertEquals(json.choices[0].message.content, "mocked reply");
    assertEquals(json.usage.prompt_tokens, 3);
    assertEquals(json.usage.completion_tokens, 2);

    // Verify the upstream got the translated Responses format.
    const sent = upstream.lastRequestBody() as Record<string, unknown>;
    assertEquals(sent.instructions, "Be brief.");
    assert(Array.isArray(sent.input));
  } finally {
    await upstream.stop();
  }
});

Deno.test("handler: streaming round-trip without duplicate final text", async () => {
  const upstream = mockUpstream();
  try {
    const handler = createHandler({ chatUrl: upstream.url, chatKey: "k" });
    const body: ChatCompletionsRequest = {
      model: "openai/gpt-5-mini",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const res = await handler(
      new Request("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "text/event-stream");

    const text = await res.text();
    // Parse out all data: JSON events.
    const events = text
      .split("\n\n")
      .map((b) =>
        b.split("\n").filter((l) => l.startsWith("data:")).map((l) =>
          l.slice(5).trim()
        ).join("")
      )
      .filter((s) => s && s !== "[DONE]")
      .map((s) => JSON.parse(s));

    // Extract all content deltas (skip role chunk + terminal empty delta).
    const contents = events
      .map((e) => e.choices?.[0]?.delta?.content)
      .filter((c): c is string => typeof c === "string");
    assertEquals(contents, ["Hello", " world", "!"]);

    // Final event must be finish_reason: stop.
    assertEquals(events.at(-1)!.choices[0].finish_reason, "stop");
    // Stream must end with [DONE].
    assertStringIncludes(text.trimEnd(), "data: [DONE]");
  } finally {
    await upstream.stop();
  }
});

Deno.test("handler: streaming backfills when upstream sent zero deltas", async () => {
  // Custom upstream that only sends a terminal event, no deltas.
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    () => {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          const send = (o: unknown) =>
            c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({
            type: "response.completed",
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "lone final" }],
              }],
            },
          });
          c.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );
  try {
    const handler = createHandler({
      chatUrl: `http://localhost:${server.addr.port}`,
      chatKey: "k",
    });
    const res = await handler(
      new Request("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "x" }],
        }),
      }),
    );
    const text = await res.text();
    assertStringIncludes(text, '"content":"lone final"');
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("handler: streams function-call tool_calls correctly", async () => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    () => {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          const send = (o: unknown) =>
            c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "fc_1",
              call_id: "call_abc",
              name: "read_file",
            },
          });
          send({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '{"path":',
          });
          send({
            type: "response.function_call_arguments.delta",
            item_id: "fc_1",
            delta: '"a.txt"}',
          });
          send({ type: "response.completed" });
          c.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  );
  try {
    const handler = createHandler({
      chatUrl: `http://localhost:${server.addr.port}`,
      chatKey: "k",
    });
    const res = await handler(
      new Request("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m",
          stream: true,
          messages: [{ role: "user", content: "read a.txt" }],
          tools: [{
            type: "function",
            function: { name: "read_file", parameters: {} },
          }],
        }),
      }),
    );
    const text = await res.text();
    const events = text
      .split("\n\n")
      .map((b) =>
        b.split("\n").filter((l) => l.startsWith("data:")).map((l) =>
          l.slice(5).trim()
        ).join("")
      )
      .filter((s) => s && s !== "[DONE]")
      .map((s) => JSON.parse(s));

    const toolChunks = events.filter((e) => e.choices?.[0]?.delta?.tool_calls);
    // Opening chunk with name + id, plus two argument-delta chunks.
    assertEquals(toolChunks.length, 3);
    assertEquals(
      toolChunks[0].choices[0].delta.tool_calls[0].function.name,
      "read_file",
    );
    assertEquals(toolChunks[0].choices[0].delta.tool_calls[0].id, "call_abc");
    assertEquals(toolChunks[0].choices[0].delta.tool_calls[0].index, 0);
    assertEquals(
      toolChunks[1].choices[0].delta.tool_calls[0].function.arguments,
      '{"path":',
    );
    assertEquals(
      toolChunks[2].choices[0].delta.tool_calls[0].function.arguments,
      '"a.txt"}',
    );

    // Final chunk finish_reason must be tool_calls, not stop.
    assertEquals(events.at(-1)!.choices[0].finish_reason, "tool_calls");
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test(
  "handler: streams Sonar-style inline function_call (args in output_item.added)",
  async () => {
    // Perplexity Sonar ships the entire function_call fully-formed in a single
    // `response.output_item.added` event with no subsequent
    // `response.function_call_arguments.delta` events. The proxy must inline
    // the arguments onto the opening tool_call chunk so clients see a complete
    // call.
    const ac = new AbortController();
    const server = Deno.serve({
      port: 0,
      signal: ac.signal,
      onListen: () => {},
    }, () => {
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          const send = (o: unknown) =>
            c.enqueue(enc.encode(`data: ${JSON.stringify(o)}\n\n`));
          send({
            type: "response.output_item.added",
            item: {
              type: "function_call",
              id: "item_1",
              call_id: "call_inline",
              name: "shell",
              arguments: '{"cmd":"echo hello"}',
              status: "completed",
            },
          });
          send({
            type: "response.output_item.done",
            item: {
              type: "function_call",
              id: "item_1",
              call_id: "call_inline",
              name: "shell",
              arguments: '{"cmd":"echo hello"}',
            },
          });
          send({ type: "response.completed" });
          c.close();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    try {
      const handler = createHandler({
        chatUrl: `http://localhost:${server.addr.port}`,
        chatKey: "k",
      });
      const res = await handler(
        new Request("http://proxy.local/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "perplexity/sonar",
            stream: true,
            messages: [{ role: "user", content: "run echo" }],
            tools: [{
              type: "function",
              function: { name: "shell", parameters: {} },
            }],
          }),
        }),
      );
      const text = await res.text();
      const events = text
        .split("\n\n")
        .map((b) =>
          b.split("\n").filter((l) => l.startsWith("data:")).map((l) =>
            l.slice(5).trim()
          )
            .join("")
        )
        .filter((s) => s && s !== "[DONE]")
        .map((s) => JSON.parse(s));

      const toolChunks = events.filter((e) =>
        e.choices?.[0]?.delta?.tool_calls
      );
      // Single opening chunk that already carries the full arguments payload.
      assertEquals(toolChunks.length, 1);
      assertEquals(
        toolChunks[0].choices[0].delta.tool_calls[0].function.name,
        "shell",
      );
      assertEquals(
        toolChunks[0].choices[0].delta.tool_calls[0].id,
        "call_inline",
      );
      assertEquals(toolChunks[0].choices[0].delta.tool_calls[0].index, 0);
      assertEquals(
        toolChunks[0].choices[0].delta.tool_calls[0].function.arguments,
        '{"cmd":"echo hello"}',
      );
      // Final chunk finish_reason must be tool_calls.
      assertEquals(events.at(-1)!.choices[0].finish_reason, "tool_calls");
    } finally {
      ac.abort();
      await server.finished;
    }
  },
);

Deno.test("handler: /v1/models passthrough", async () => {
  const upstream = mockUpstream();
  try {
    const handler = createHandler({ chatUrl: upstream.url, chatKey: "k" });
    const res = await handler(new Request("http://proxy.local/v1/models"));
    assertEquals(res.status, 200);
    const json = await res.json();
    assertEquals(json.data[0].id, "openai/gpt-5-mini");
  } finally {
    await upstream.stop();
  }
});

Deno.test("handler: returns 404 for unknown paths", async () => {
  const handler = createHandler({ chatUrl: "http://unused", chatKey: "k" });
  const res = await handler(
    new Request("http://proxy.local/v1/nope", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
  );
  assertEquals(res.status, 404);
});

Deno.test("handler: returns 400 for invalid JSON", async () => {
  const handler = createHandler({ chatUrl: "http://unused", chatKey: "k" });
  const res = await handler(
    new Request("http://proxy.local/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    }),
  );
  assertEquals(res.status, 400);
});

Deno.test("handler: returns 405 for GET on /v1/chat/completions", async () => {
  const handler = createHandler({ chatUrl: "http://unused", chatKey: "k" });
  const res = await handler(
    new Request("http://proxy.local/v1/chat/completions"),
  );
  assertEquals(res.status, 405);
});

Deno.test("handler: propagates upstream errors with body", async () => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen: () => {} },
    () => {
      return new Response("rate limited", { status: 429 });
    },
  );
  try {
    const handler = createHandler({
      chatUrl: `http://localhost:${server.addr.port}`,
      chatKey: "k",
    });
    const res = await handler(
      new Request("http://proxy.local/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "m",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    assertEquals(res.status, 429);
    const json = await res.json();
    assertEquals(json.error.upstream_status, 429);
    assertStringIncludes(json.error.message, "rate limited");
  } finally {
    ac.abort();
    await server.finished;
  }
});
