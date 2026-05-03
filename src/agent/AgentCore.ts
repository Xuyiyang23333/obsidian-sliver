import { App } from 'obsidian';
import { SessionManager } from './context';
import { checkFilePermission } from './permissions';
import * as tools from './tools';
import { getToolDefinitions } from './tools';
import { chatCompletionStream, ChatMessage, ApiError, ToolCall } from '../utils/api';
import { GlobalPermission } from '../settings';
import ObsidianAgentPlugin from '../main';

export type AgentEventCallback = {
  onThinking?: () => void;
  onReasoningChunk?: (text: string) => void;
  onToolProgress?: (toolName: string, status: 'running' | 'done' | 'error', result?: string) => void;
  onConfirmationRequest?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  /** A chunk of the assistant's response text (streamed in real-time) */
  onAssistantChunk?: (text: string) => void;
  /** The assistant's response is complete */
  onAssistantComplete?: () => void;
  onError?: (error: string) => void;
  onContextCompressed?: () => void;
  /** A system message was appended to the context (e.g. permission change, active file notice) */
  onSystemMessage?: (content: string) => void;
};

export class AgentCore {
  private app: App;
  private plugin: ObsidianAgentPlugin;
  private sessionManager: SessionManager;
  private callbacks: AgentEventCallback = {};
  private currentPermission: GlobalPermission;
  private lastActiveFilePath: string = '';
  private _isProcessing: boolean = false;
  private _cancelled: boolean = false;
  private abortController: AbortController | null = null;

  get isProcessing(): boolean { return this._isProcessing && !this._cancelled; }

  cancelCurrentRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._cancelled = true;
  }

  constructor(plugin: ObsidianAgentPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
    this.sessionManager = new SessionManager(plugin, app);
    this.currentPermission = plugin.settings.globalPermission;
  }

  setCallbacks(callbacks: AgentEventCallback) { this.callbacks = callbacks; }
  getSessionManager(): SessionManager { return this.sessionManager; }

  async initialize(): Promise<void> {
    await this.sessionManager.loadFromDisk();
  }

  getToolContext(): tools.ToolContext {
    return {
      app: this.app,
      checkPermission: (filePath, operation) =>
        checkFilePermission(filePath, operation, this.plugin.settings.pathRules, this.currentPermission),
      onConfirmRequest: async (toolName, args) =>
        this.callbacks.onConfirmationRequest?.(toolName, args) ?? false,
    };
  }

  async processUserMessage(content: string, skipAdd?: boolean): Promise<void> {
    if (this.isProcessing) return;
    this._isProcessing = true;
    this._cancelled = false;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      if (!skipAdd) await this.sessionManager.addUserMessage(content);

      // Notify model about active file (model decides whether to read it)
      // Always insert when context is fresh; otherwise only when file changed
      const activeFile = this.app.workspace.getActiveFile();
      const activePath = activeFile?.path || '';
      if (activePath) {
        const contextFresh = this.sessionManager.getCurrentContext().length <= 1;
        if (contextFresh || activePath !== this.lastActiveFilePath) {
          const notice = `用户当前正在 Obsidian 中查看: ${activePath}`;
          await this.sessionManager.appendSystemMessage(notice);
          this.callbacks.onSystemMessage?.(notice);
        }
        this.lastActiveFilePath = activePath;
      }

      const toolDefinitions = getToolDefinitions();
      const apiConfig = {
        endpoint: this.plugin.settings.apiEndpoint,
        apiKey: this.plugin.settings.apiKey,
        model: this.plugin.settings.model,
        thinkingMode: this.plugin.settings.thinkingMode,
        reasoningEffort: this.plugin.settings.reasoningEffort,
      };

      if (!apiConfig.apiKey) {
        this.callbacks.onError?.('API Key not configured.');
        this._isProcessing = false;
        return;
      }

      let iterations = 0;
      const maxIterations = 20;

      while (iterations < maxIterations) {
        iterations++;

        // Compress context if approaching token limit
        if (this.sessionManager.needsCompression()) {
          await this.sessionManager.compressContext(apiConfig);
          this.callbacks.onContextCompressed?.();
        }

        const systemPrompt = this.buildSystemPrompt();
        const messages: ChatMessage[] = [
          { role: 'system', content: systemPrompt },
          ...this.sessionManager.getCurrentContext(),
        ];

        // --- Stream from LLM ---
        const turnResult = await this.streamTurn(messages, toolDefinitions, apiConfig, signal);

        if (turnResult === null) {
          // Final text response — already saved in streamTurn
          break;
        }

        const { toolCalls, reasoningContent, responseContent } = turnResult;

        // --- Execute tools ---
        if (iterations >= maxIterations) {
          this.callbacks.onError?.('Agent reached maximum iteration limit');
          break;
        }

        // Save ONE assistant message with ALL fields (content + reasoning_content + tool_calls)
        await this.sessionManager.addAssistantMessage({
          role: 'assistant',
          content: responseContent,
          reasoning_content: reasoningContent,
          tool_calls: toolCalls,
        });

        for (const toolCall of toolCalls) {
          const { name, arguments: argsStr } = toolCall.function;
          const args = JSON.parse(argsStr);

          this.callbacks.onToolProgress?.(name, 'running');
          let result: tools.ToolResult;

          try {
            const ctx = this.getToolContext();
            switch (name) {
              case 'read_file':       result = await tools.readFile(ctx, args.path); break;
              case 'write_file':      result = await tools.writeFile(ctx, args.path, args.content); break;
              case 'edit_file':       result = await tools.editFile(ctx, args.path, args.oldText, args.newText); break;
              case 'list_files':      result = await tools.listFiles(ctx, args.path); break;
              case 'search_files':    result = await tools.searchFiles(ctx, args.query, args.path, args.maxResults, args.maxMatches); break;
              case 'delete_file':     result = await tools.deleteFile(ctx, args.path); break;
              case 'create_note':     result = await tools.createNote(ctx, args.path, args.content); break;
              case 'load_skill':      result = await this.plugin.skillManager.loadSkill(args.name); break;
              default:                result = { success: false, error: `Unknown tool: ${name}` };
            }
          } catch (e) {
            result = { success: false, error: (e as Error).message || String(e) };
          }

          const resultStr = result.success ? JSON.stringify(result.data) : `Error: ${result.error}`;
          this.callbacks.onToolProgress?.(name, result.success ? 'done' : 'error', resultStr);

          await this.sessionManager.addToolResult(toolCall.id, resultStr);
        }

        await this.sessionManager.saveToDisk();
        await this.sessionManager.saveToMarkdown();
      }

    } catch (e) {
      if (e instanceof ApiError) {
        if (e.retryable) this.callbacks.onError?.('Rate limited. Please wait and try again.');
        else this.callbacks.onError?.(e.message);
      } else {
        this.callbacks.onError?.(`Error: ${(e as Error).message || String(e)}`);
      }
    } finally {
      this._isProcessing = false;
    }
  }

  /**
   * Stream one turn from the LLM.
   *
   * - content       → onAssistantChunk (message bubble, real-time)
   * - reasoning     → onReasoningChunk (thinking section)
   * - tool_calls    → returned for execution, content stays in bubble
   * - stop          → onAssistantComplete, returns null
   */
  private async streamTurn(
    messages: ChatMessage[],
    toolDefinitions: ReturnType<typeof getToolDefinitions>,
    apiConfig: { endpoint: string; apiKey: string; model: string; thinkingMode?: boolean; reasoningEffort?: string },
    signal?: AbortSignal,
  ): Promise<{ toolCalls: ToolCall[]; reasoningContent: string; responseContent: string } | null> {
    let reasoningContent = '';
    let responseContent = '';
    const toolCallAcc: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let hasToolCalls = false;
    let gotUsage = false;

    this.callbacks.onThinking?.();

    for await (const chunk of chatCompletionStream(messages, toolDefinitions, apiConfig, signal)) {
      if (chunk.done) break;

      // Reasoning → thinking section
      if (chunk.reasoningContent) {
        reasoningContent += chunk.reasoningContent;
        this.callbacks.onReasoningChunk?.(chunk.reasoningContent);
      }

      // Content → message bubble (always streamed in real-time)
      if (chunk.contentDelta) {
        responseContent += chunk.contentDelta;
        this.callbacks.onAssistantChunk?.(chunk.contentDelta);
      }

      // Tool calls
      if (chunk.toolCallDelta) {
        hasToolCalls = true;
        const tc = chunk.toolCallDelta;
        const existing = toolCallAcc.get(tc.index) || { id: '', name: '', arguments: '' };
        if (tc.id) existing.id += tc.id;
        if (tc.name) existing.name += tc.name;
        if (tc.arguments) existing.arguments += tc.arguments;
        toolCallAcc.set(tc.index, existing);
      }

      // Finish
      if (chunk.finishReason) {
        if (chunk.usage?.prompt_tokens) {
          this.sessionManager.updateTokenCount(chunk.usage.prompt_tokens);
          gotUsage = true;
        }

        if (chunk.finishReason === 'tool_calls' && hasToolCalls) {
          if (!gotUsage) this.sessionManager.estimateTokens();
          const calls: ToolCall[] = [];
          for (const [, acc] of toolCallAcc) {
            calls.push({ id: acc.id, type: 'function', function: { name: acc.name, arguments: acc.arguments } });
          }
          return { toolCalls: calls, reasoningContent, responseContent };
        }

        if (chunk.finishReason === 'stop') {
          if (!gotUsage) this.sessionManager.estimateTokens();
          // When model puts answer in reasoning instead of content, swap them
          const finalContent = responseContent || reasoningContent || '';
          const finalReasoning = responseContent ? reasoningContent : '';
          await this.sessionManager.addAssistantMessage({
            role: 'assistant', content: finalContent, reasoning_content: finalReasoning,
          });
          await this.sessionManager.saveToDisk();
          await this.sessionManager.saveToMarkdown();
          this.callbacks.onAssistantComplete?.();
          return null;
        }

        if (chunk.finishReason === 'length') {
          this.callbacks.onError?.('Response exceeded token limit.');
          return null;
        }
      }
    }

    // Stream ended without finish_reason
    if (!gotUsage) this.sessionManager.estimateTokens();
    const finalContent = responseContent || reasoningContent || '';
    const finalReasoning = responseContent ? reasoningContent : '';
    if (finalContent) {
      await this.sessionManager.addAssistantMessage({
        role: 'assistant', content: finalContent, reasoning_content: finalReasoning,
      });
      await this.sessionManager.saveToDisk();
      await this.sessionManager.saveToMarkdown();
    }
    this.callbacks.onAssistantComplete?.();
    return null;
  }

  async updatePermission(newPermission: GlobalPermission): Promise<void> {
    const old = this.currentPermission;
    this.currentPermission = newPermission;
    if (old !== newPermission) {
      const notice = `Permission mode changed from "${old}" to "${newPermission}".`;
      await this.sessionManager.appendSystemMessage(notice);
      this.callbacks.onSystemMessage?.(notice);
    }
  }

  private buildSystemPrompt(): string {
    const s = this.plugin.settings;
    const rulesStr = s.pathRules.filter(r => r.path.length > 0)
      .map(r => `  - ${r.path} → ${r.permission}`).join('\n');
    const permBlock = `## Current Permission Mode
Global: ${this.currentPermission}
${rulesStr ? `Path Rules:\n${rulesStr}` : 'No path-specific rules configured.'}`;
    return `${s.systemPrompt}\n\n${permBlock}`;
  }
}
