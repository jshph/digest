"""
Modal app: llama-server (native C++) with Qwen3.5-9B Q4_K_M on GPU.

Must use native llama-server (not llama-cpp-python) because only the
native server parses Qwen's <tool_call> XML into structured tool_calls
via the Jinja chat template.

Usage:
  modal serve modal_llama.py
  modal deploy modal_llama.py

Then:
  OPENAI_BASE_URL=<url>/v1 OPENAI_MODEL=qwen/qwen3.5-9b npx digest
"""

import modal
import subprocess
import sys

app = modal.App("digest-llama")

MODEL_URL = "https://huggingface.co/lmstudio-community/Qwen3.5-9B-GGUF/resolve/main/Qwen3.5-9B-Q4_K_M.gguf"
MODEL_PATH = "/models/Qwen3.5-9B-Q4_K_M.gguf"

# Pre-built llama-server with CUDA from GHCR. Binary at /app/llama-server.
# .entrypoint([]) clears Docker ENTRYPOINT so Modal can manage the container.
image = (
    modal.Image.from_registry(
        "ghcr.io/ggml-org/llama.cpp:server-cuda",
        add_python="3.11",
    )
    .entrypoint([])
    .apt_install("curl")
    .run_commands(
        f"mkdir -p /models && curl -L -o {MODEL_PATH} '{MODEL_URL}'",
    )
)


@app.function(
    image=image,
    gpu="L4",
    timeout=3600,
    scaledown_window=300,
)
@modal.concurrent(max_inputs=10)
@modal.web_server(port=8080, startup_timeout=300)
def serve():
    cmd = [
        "/app/llama-server",
        "-m", MODEL_PATH,
        "-ngl", "all",
        "-np", "1",
        "-c", "32768",
        "-fa", "on",
        "--host", "0.0.0.0",
        "--port", "8080",
    ]
    print(f"Starting: {' '.join(cmd)}", flush=True)
    subprocess.Popen(cmd, stdout=sys.stdout, stderr=sys.stderr)
