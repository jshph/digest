# 14 — Modal GPU Testing

Run digest's multi-turn test harness against a GPU-accelerated llama-server on Modal. This mirrors the local Mac experience with 3-5x faster iteration cycles.

## Why

Local Mac (M5): 350-420 tok/s prefill, 16-19 tok/s generation. A 4-turn test session takes ~220s. On Modal L4 GPU: 2,100 tok/s prefill, 36 tok/s generation — same session in ~70s. Faster iteration on prompt tuning and agent behavior without changing the inference backend.

## Setup

```bash
cd ~/Hacks/digest
python3 -m venv .venv
source .venv/bin/activate
pip install modal
modal profile activate <your-profile>
```

## Running

```bash
# Dev mode — streams build logs, hot-reloads on file changes
modal serve modal_llama.py

# Persistent deployment
modal deploy modal_llama.py
```

First build takes ~2 min (GHCR image pull + 5.6GB model download). Subsequent runs use cached images.

The server URL appears in the output:
```
https://<workspace>--digest-llama-serve-dev.modal.run
```

## Testing against Modal

```bash
# Single turn
cd ~/vault && echo "explore craft vs AI" | \
  OPENAI_BASE_URL=https://<workspace>--digest-llama-serve-dev.modal.run \
  OPENAI_MODEL=qwen/qwen3.5-9b \
  node ~/Hacks/digest/dist/main.js

# Multi-turn (each line = separate prompt)
printf 'hey whats up\nexplore craft vs AI\nsay more about that\n' | \
  OPENAI_BASE_URL=... OPENAI_MODEL=... node ~/Hacks/digest/dist/main.js
```

## Architecture

`modal_llama.py` uses the pre-built `ghcr.io/ggml-org/llama.cpp:server-cuda` image. This is the native C++ llama-server, not llama-cpp-python — only the native server correctly parses Qwen's `<tool_call>` XML into structured `delta.tool_calls` via the Jinja chat template.

Key configuration:
- **GPU**: L4 (24GB VRAM, Ada Lovelace) — cheapest GPU that beats M5 on prefill
- **Context**: 32768 tokens (matches local config)
- **Slots**: 1 (single concurrent request, matches `-np 1` local setup)
- **Flash attention**: enabled
- **Scaledown**: 5 min idle before container stops (no cost when idle)

## Benchmarks: L4 GPU vs M5 Mac

| Metric | M5 (local) | L4 (Modal) | Speedup |
|--------|-----------|-----------|---------|
| Prefill | 350-420 tok/s | 2,100 tok/s | 5x |
| Generation | 16-19 tok/s | 36 tok/s | 2x |
| Turn 1 (passthrough) | 24s | 5-7s | 3.5x |
| Turn 2 (VaultSearch + synthesis) | 100s | 37s | 2.7x |
| 4-turn session | ~220s | ~70s | 3x |

## What llama-cpp-python doesn't work for

We tried `llama-cpp-python[server]` with pre-built CUDA wheels — faster image build (no compilation), but the Python server doesn't parse Qwen's `<tool_call>` XML into structured `delta.tool_calls`. Tool calls come through as text, so the agent never executes them. The native C++ llama-server is required for proper tool calling with Qwen models.
