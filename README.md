# llama-cpp-local

Local llama.cpp gateway kit for CapaKit.

## What It Exposes

- OAIC endpoint at `/oaic`, forwarded to a local `llama-server`.
- MCP endpoint at `/mcp`, with `ask_local_model` for quick local chat testing.
- On-demand llama.cpp hydration from the configured release tag.
- On-demand GGUF model hydration into the `models` host mount.

## Options

- `default_model`: Hugging Face GGUF repo selector or local GGUF path.
- `release_tag`: llama.cpp release tag to download.
- `context_size`: llama.cpp context size.
- `threads`: CPU thread count.
- `gpu`: `metal` or `none`.

Default model:

```text
ggml-org/gemma-3-270m-it-GGUF:Q8_0
```

## Required Mounts

- `models`: read/write cache for llama.cpp binaries, GGUF files, and runtime caches.

## Run

```sh
capakit up . --mount models=/path/to/model-cache
```

Call MCP:

```sh
capakit mcp list-tools .
capakit mcp call-tool . --tool ask_local_model --json '{"prompt":"Say hello from local llama.cpp"}'
```

Call OAIC:

```sh
curl "$CAPAKIT_OAIC_URL/v1/chat/completions" \
  -H 'content-type: application/json' \
  -d '{"model":"ggml-org/gemma-3-270m-it-GGUF:Q8_0","messages":[{"role":"user","content":"Say hello"}]}'
```

## Run Capability Test

The test auto-binds `models` from `tests/simple-local-chat/models`.

```sh
capakit test .
```
