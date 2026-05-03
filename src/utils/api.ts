export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;  // Deepseek thinking mode CoT
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ChatCompletionResponse {
  id: string;
  choices: {
    index: number;
    finish_reason: 'stop' | 'tool_calls' | 'length';
    message: ChatMessage;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ApiConfig {
  endpoint: string;
  apiKey: string;
  model: string;
  thinkingMode?: boolean;
  reasoningEffort?: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
    public retryable: boolean = false
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Parsed SSE chunk from a streaming response */
export interface StreamChunk {
  /** Model's chain-of-thought / reasoning (if thinking mode enabled) */
  reasoningContent?: string;
  /** Final answer text delta */
  contentDelta?: string;
  /** Partial tool call being built up across chunks */
  toolCallDelta?: { index: number; id: string; name: string; arguments: string };
  /** True when the stream is done */
  done: boolean;
  /** finish_reason if present in this chunk */
  finishReason?: 'stop' | 'tool_calls' | 'length';
  /** Usage data (only in final chunk for some providers) */
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** Build the request body with optional thinking mode params */
function buildRequestBody(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ApiConfig,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream,
  };

  // Only send tools if there are any (sending empty array can cause 400 on some API versions)
  if (tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  if (config.thinkingMode) {
    body.extra_body = { thinking: { type: 'enabled' } };
    body.reasoning_effort = config.reasoningEffort || 'high';
  }

  return body;
}

/** Non-streaming call — returns the full response at once */
export async function chatCompletion(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ApiConfig,
): Promise<ChatCompletionResponse> {
  const url = `${config.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const body = buildRequestBody(messages, tools, config, false);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    if (response.status === 401) throw new ApiError('Invalid API key.', 401, false);
    if (response.status === 429) throw new ApiError('Rate limited.', 429, true);
    throw new ApiError(`API error: ${response.status}`, response.status, false);
  }

  return await response.json() as ChatCompletionResponse;
}

/**
 * Streaming call — yields parsed chunks as they arrive.
 *
 * When thinking mode is enabled:
 *   - chunk.reasoningContent carries the model's chain-of-thought
 *   - chunk.contentDelta carries the final answer (usually after reasoning)
 * When thinking mode is disabled:
 *   - chunk.contentDelta carries the full response text
 * Tool call deltas arrive in separate chunks regardless of mode.
 */
export async function* chatCompletionStream(
  messages: ChatMessage[],
  tools: ToolDefinition[],
  config: ApiConfig,
  signal?: AbortSignal,
): AsyncGenerator<StreamChunk> {
  const url = `${config.endpoint.replace(/\/+$/, '')}/chat/completions`;
  const body = buildRequestBody(messages, tools, config, true);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    if (response.status === 401) throw new ApiError('Invalid API key.', 401, false);
    if (response.status === 429) throw new ApiError('Rate limited.', 429, true);
    let detail = `API error: ${response.status}`;
    try {
      const err = await response.json();
      if (err.error?.message) detail += ` - ${err.error.message}`;
    } catch {}
    throw new ApiError(detail, response.status, false);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new ApiError('Stream not available', 0, false);

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') {
        yield { done: true };
        return;
      }

      try {
        const parsed = JSON.parse(data);
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta || {};
        const chunk: StreamChunk = { done: false };

        // Reasoning content (Deepseek thinking mode)
        if (delta.reasoning_content) {
          chunk.reasoningContent = delta.reasoning_content;
        }

        // Regular content
        if (delta.content) {
          chunk.contentDelta = delta.content;
        }

        // Tool calls
        if (delta.tool_calls) {
          const tc = delta.tool_calls[0];
          if (tc) {
            chunk.toolCallDelta = {
              index: tc.index ?? 0,
              id: tc.id || '',
              name: tc.function?.name || '',
              arguments: tc.function?.arguments || '',
            };
          }
        }

        if (choice.finish_reason) {
          chunk.finishReason = choice.finish_reason;
        }

        if (parsed.usage) {
          chunk.usage = parsed.usage;
        }

        yield chunk;
      } catch {
        // Skip malformed JSON
      }
    }
  }

  yield { done: true };
}
