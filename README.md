# chat-responses-proxy

A tiny Deno server that translates **OpenAI Chat Completions** to the **OpenAI
Responses API** (and specifically the Perplexity Agent API). Lets
chat-completions-only CLIs like Mistral Vibe talk to Perplexity's Agent API
without forking them.

## Run it

```bash
deno task start              # prompts for base URL + API key on first run
deno task start -- --verbose # log every request/response pair to stderr
deno task dev                # --watch + --verbose
```

First-run config is saved to `~/.config/chat-responses-proxy.json` (chmod 600).
Env vars override the file:

```bash
CHAT_URL=https://api.perplexity.ai/v1 \
CHAT_API_KEY=pplx-... \
  deno task start
```

## Point your CLI at it

```
base URL: http://localhost:8000/v1
API key:  anything (not checked, but most CLIs require a non-empty value)
model:    openai/gpt-5.4, anthropic/claude-sonnet-4-6, google/gemini-3.1-pro-preview, …
```

Run `curl http://localhost:8000/v1/models` to see the full Perplexity model
list.

## What it does

- Translates `messages` → Responses `input` + `instructions` (system msgs become
  `instructions`)
- Renames `max_tokens` → `max_output_tokens`
- Folds `role: "tool"` messages into tagged user turns
- Bridges Responses SSE (`response.output_text.delta`, `response.completed`) to
  chat-completions SSE (`choices[].delta.content` + `[DONE]`)
- Passes through `GET /v1/models`
- Normalizes sloppy base URLs (strips trailing `/`, `/agent`, `/responses`)

## Development

```bash
deno task check   # typecheck
deno task test    # run the suite (no network, uses mock upstream)
deno task fmt
```

The test suite spins up a mock Perplexity server locally, so it runs offline and
doesn't burn API credits.
