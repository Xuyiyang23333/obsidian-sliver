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
};

export class AgentCore {
  private app: App;
  private plugin: ObsidianAgentPlugin;
  private sessionManager: SessionManager;
  private callbacks: AgentEventCallback = {};
  private currentPermission: GlobalPermission;
  private _isProcessing: boolean = false;
  private abortController: AbortController | null = null;

  get isProcessing(): boolean { return this._isProcessing; }

  cancelCurrentRequest(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this._isProcessing = false;
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
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      if (!skipAdd) await this.sessionManager.addUserMessage(content);

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

        // Build next-turn messages (include tool results)
        const nextMessages = [
          { role: 'system' as const, content: this.buildSystemPrompt() },
          ...this.sessionManager.getCurrentContext(),
        ];

        nextMessages.push({
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
              case 'search_files':    result = await tools.searchFiles(ctx, args.query, args.path); break;
              case 'delete_file':     result = await tools.deleteFile(ctx, args.path); break;
              case 'create_note':     result = await tools.createNote(ctx, args.path, args.content); break;
              case 'execute_command': result = await tools.executeCommand(ctx, args.commandId || ''); break;
              case 'load_skill':      result = await this.loadSkillContent(args.name); break;
              default:                result = { success: false, error: `Unknown tool: ${name}` };
            }
          } catch (e) {
            result = { success: false, error: (e as Error).message || String(e) };
          }

          const resultStr = result.success ? JSON.stringify(result.data) : `Error: ${result.error}`;
          this.callbacks.onToolProgress?.(name, result.success ? 'done' : 'error', resultStr);

          await this.sessionManager.addToolResult(toolCall.id, resultStr);
          nextMessages.push({ role: 'tool', content: resultStr, tool_call_id: toolCall.id });
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
        }

        if (chunk.finishReason === 'tool_calls' && hasToolCalls) {
          const calls: ToolCall[] = [];
          for (const [, acc] of toolCallAcc) {
            calls.push({ id: acc.id, type: 'function', function: { name: acc.name, arguments: acc.arguments } });
          }
          return { toolCalls: calls, reasoningContent, responseContent };
        }

        if (chunk.finishReason === 'stop') {
          await this.sessionManager.addAssistantMessage({
            role: 'assistant', content: responseContent, reasoning_content: reasoningContent,
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
    if (responseContent) {
      await this.sessionManager.addAssistantMessage({
        role: 'assistant', content: responseContent, reasoning_content: reasoningContent,
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
      await this.sessionManager.appendSystemMessage(
        `Permission mode changed from "${old}" to "${newPermission}".`
      );
    }
  }

  private async loadSkillContent(name: string): Promise<tools.ToolResult> {
    const path = `_agents/skills/${name}/SKILL.md`;
    const file = this.app.vault.getFileByPath(path);
    if (!file) return { success: false, error: `Skill not found: ${name}` };
    const content = await this.app.vault.read(file);
    return { success: true, data: content };
  }

  private buildSystemPrompt(): string {
    const s = this.plugin.settings;
    const rulesStr = s.pathRules.filter(r => r.path.length > 0)
      .map(r => `  - ${r.path} → ${r.permission}`).join('\n');

    return `You are an AI assistant integrated into Obsidian...

## Current Permission Mode
Global: ${this.currentPermission}
${rulesStr ? `Path Rules:\n${rulesStr}` : 'No path-specific rules configured.'}

## Rules
- If the permission mode is "read-only", you cannot modify any files.
- If the permission mode is "ask-per-write", file modifications require user confirmation.
- If the permission mode is "full-access", you can execute file operations autonomously.
- Always tell the user what you're about to do before doing it.
- Use loaded skills for specialized knowledge about Obsidian-specific formats.
- Keep responses concise and in Chinese unless the user asks otherwise.
- Use $...$ for inline math and $$...$$ for display math. Do NOT use \(...\) or \[...\].`;
  }
}
