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

Specifically, if you were to try and use Perplexit with Mistral Vibe:

```toml
[[providers]]
name = "perplexity"
api_base = "http://localhost:8000/v1"
api_key_env_var = "CHAT_API_KEY"
api_style = "openai"
backend = "generic"
```

Note: Doesn't work with Perplexity's Sonar. Here's my opinionated but plentiful model selection outside Mistral's defaults:

```toml
[[models]]
name = "anthropic/claude-sonnet-4-6"
provider = "perplexity"
alias = "sonnet-4-6"
temperature = 0.2
input_price = 3.0
output_price = 15.0
thinking = "medium"
auto_compact_threshold = 800000

[[models]]
name = "anthropic/claude-sonnet-4-5"
provider = "perplexity"
alias = "sonnet-4-5"
temperature = 0.2
input_price = 3.0
output_price = 15.0
thinking = "medium"
auto_compact_threshold = 160000

[[models]]
name = "anthropic/claude-haiku-4-5"
provider = "perplexity"
alias = "haiku-4-5"
temperature = 0.2
input_price = 1.0
output_price = 5.0
thinking = "low"
auto_compact_threshold = 160000

[[models]]
name = "openai/gpt-5.4"
provider = "perplexity"
alias = "gpt-5-4"
temperature = 0.2
input_price = 2.5
output_price = 15.0
thinking = "medium"
auto_compact_threshold = 800000

[[models]]
name = "openai/gpt-5.4-mini"
provider = "perplexity"
alias = "gpt-5-4-mini"
temperature = 0.2
input_price = 0.75
output_price = 4.5
thinking = "low"
auto_compact_threshold = 800000

[[models]]
name = "openai/gpt-5.4-nano"
provider = "perplexity"
alias = "gpt-5-4-nano"
temperature = 0.2
input_price = 0.2
output_price = 1.25
thinking = "low"
auto_compact_threshold = 800000

[[models]]
name = "google/gemini-3.1-pro-preview"
provider = "perplexity"
alias = "gemini-3-1-pro"
temperature = 0.2
input_price = 2.0
output_price = 12.0
thinking = "medium"
auto_compact_threshold = 800000

[[models]]
name = "google/gemini-3-flash-preview"
provider = "perplexity"
alias = "gemini-3-flash"
temperature = 0.2
input_price = 0.5
output_price = 3.0
thinking = "low"
auto_compact_threshold = 800000

[[models]]
name = "nvidia/nemotron-3-super-120b-a12b"
provider = "perplexity"
alias = "nemotron-3-super"
temperature = 0.2
input_price = 0.1
output_price = 0.5
thinking = "low"
auto_compact_threshold = 128000
```

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
