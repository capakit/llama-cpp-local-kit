<!--
Generated from kit-meta.json by scripts/demo-kit-standard.mjs.
Update kit-meta.json or capability.yml, then rerun the generator instead of hand-editing generated README sections.
-->

# llama.cpp Local

Local AI app Kit that serves GGUF models through llama.cpp with OpenAI-compatible and MCP endpoints.

## What It Does

- Downloads and runs a llama.cpp release on demand.
- Loads a local path or Hugging Face GGUF model spec.
- Exposes OpenAI-compatible chat and an MCP tool for local model prompts.

## Technologies

- llama.cpp
- gguf
- oaic
- mcp
- local-ai
- typescript
- bun

## App Kit Info

```text
AI app Kit: llama-cpp-local

Exposes
- Public path: /oaic
  Protocols:
    - Protocol: oaic
      Path: /oaic
- Public path: /mcp
  Protocols:
    - Protocol: mcp
      Path: /mcp
  Default MCP: yes

Requires
Secrets:
No secrets declared.

Host mounts:
- models [read_write]
  Usage: Local GGUF model cache for llama.cpp

Options:
- context_size [number, default=8192]: llama.cpp context size.
- default_model [string, default=ggml-org/gemma-3-270m-it-GGUF:Q8_0]: Default GGUF/Hugging Face model spec.
- gpu [enum, default=metal, values=none|metal]: Local GPU acceleration mode.
- hydrate_models [string, default=]: Additional GGUF/Hugging Face model specs to hydrate before start, separated by commas or newlines.
- release_tag [string, default=b9060]: llama.cpp release tag to hydrate.
- threads [number, default=4]: llama.cpp CPU thread count.

External services
No external services declared.

AI app Kit dependencies
No AI app Kit dependencies declared.

Use as dependency
Add this to another Kit's capability.yml:
dependencies:
  llama-cpp-local:
    source:
      path: /Users/roman/Code/capakit/demo-kits/llama-cpp-local-kit

Commands
- Run:
  capakit run https://github.com/capakit/llama-cpp-local-kit \
    --mount models=~/.capakit/models
- Test:
  capakit test --kit /Users/roman/Code/capakit/demo-kits/llama-cpp-local-kit
```

## Run

```sh
capakit run https://github.com/capakit/llama-cpp-local-kit \
--mount models=~/.capakit/models
```

## Install As A Skill

```sh
capakit run https://github.com/capakit/llama-cpp-local-kit --global-skill codex \
--mount models=~/.capakit/models
```

## Test

```sh
capakit test .
```

## About CapaKit

https://capakit.com
