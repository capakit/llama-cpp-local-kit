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
- GGUF models
- CapaKit OAIC endpoint
- CapaKit MCP endpoint
- TypeScript
- Bun

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
- release_tag [string, default=b9060]: llama.cpp release tag to hydrate.
- threads [number, default=4]: llama.cpp CPU thread count.

External services
No external services declared.

AI app Kit dependencies
No AI app Kit dependencies declared.
Exports provided to dependents:
- mcp -> /mcp
- oaic -> /oaic

Commands
- Run:
  capakit run https://github.com/capakit/llama-cpp-local-kit \
    --mount models=~/.capakit/models
- Test:
  capakit test /Users/roman/Code/capakit/demo_kits/llama-cpp-local-kit
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

## Security

Vault secrets are user-provided secrets available only to trusted integrations such as secure exit nodes. Kit secrets are Kit-local secrets that can be exposed to code workloads.

## About CapaKit

CapaKit runs AI app Kits locally with isolated workloads, explicit mounts, and agent-friendly commands. Learn more at https://capakit.com.

More AI app Kits: https://github.com/capakit/apps
