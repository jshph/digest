# Qwen + llama.cpp

Qwen models on llama.cpp have specific behaviors that affect agent design. These were discovered through iterative testing and are documented here so they don't have to be rediscovered.

## Jinja chat template

Qwen's chat template (embedded in the GGUF) has behaviors you need to know:

### Tool definitions change the system prompt

When `tools` are provided in the API request, the template injects XML into the system message:

```
<|im_start|>system
Your system prompt here

# Tools
You may call one or more functions...
<tools>
[tool definitions as JSON]
</tools>
<|im_end|>
```

When no tools are provided, this XML is absent. **This means the system prompt tokens are different depending on whether tools are included.** On llama.cpp, where KV cache is strictly prefix-based, switching between tools/no-tools between turns breaks the cache.

**Fix**: always include tool definitions on every turn.

### tool_choice is not supported

The `tool_choice` parameter (`"none"`, `"required"`, `"auto"`) is not part of the Jinja template logic. It has no effect. The template always renders tool instructions when tools are provided, and the model decides whether to call them.

### Tool results become user messages

Messages with `role: "tool"` are wrapped as `<tool_response>` inside a `<|im_start|>user` block. The model sees them as user messages, not a separate role.

### multi_step_tool detection

The template walks backwards through messages looking for a "real" user message (not a `<tool_response>`). If none found, it raises: `"No user query found in messages"`.

**Fix**: warmup requests must include at least one user message.

### enable_thinking blocks assistant prefill

Conversations ending with an assistant message fail with `"Assistant response prefill is incompatible with enable_thinking"`.

**Fix**: warmup appends a dummy user message when conversation ends with assistant.

## <tool_call> XML as text

Qwen's native tool-call format is `<tool_call>` XML emitted as text content. The model produces both:
- Structured `delta.tool_calls` (parsed by llama.cpp)
- `<tool_call>` XML in `delta.content` (text)

These are duplicates. The provider strips XML from stored text when structured tool calls are also present.

During streaming, text_deltas are suppressed on tool-calling turns (since the XML would be visible to the user). If no tool calls are detected, the suppressed text is re-emitted from the stored response.

## 9B model limitations

- **Won't synthesize with tools available**: when tools are offered, 9B models always call them instead of responding from context. This is why the synthesis directive is needed after tool execution.
- **Ignores "don't re-search" prompting**: unless maxToolRounds limits the number of attempts, the model spirals into repeated searches with slight query variations.
- **Doesn't distinguish tags from concepts**: TextSearch was removed because the model used it for concept searches (`TextSearch("reason")`) instead of vault entities (`TextSearch("enzyme/pmf")`).

## llama.cpp server flags

For best results with Qwen on llama.cpp:

```bash
llama-server -m model.gguf \
  -np 1       # single slot (avoids scheduling mismatches)
  -fa on      # flash attention
  -c 32768    # context size
```

`-np 1` is important: with multiple slots, the tool-calling turn and synthesis turn can land on different slots with different cache states.

## llama-cpp-python does NOT work

The Python `llama-cpp-python[server]` doesn't parse Qwen's `<tool_call>` XML into structured `delta.tool_calls`. All tool calls come through as text. Use the native C++ `llama-server` for proper tool calling.
