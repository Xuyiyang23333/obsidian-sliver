import { App, TFile, normalizePath } from 'obsidian';
import { ChatMessage, chatCompletionStream } from '../utils/api';
import ObsidianAgentPlugin from '../main';

export interface SessionData {
  context: ChatMessage[];
  tokenCount: number;
}

export class SessionManager {
  private sessions: Map<string, SessionData> = new Map();
  private sessionOrder: string[] = [];
  private currentSession: string = '';
  private plugin: ObsidianAgentPlugin;
  private app: App;
  private saveTimer: number | null = null;

  constructor(plugin: ObsidianAgentPlugin, app: App) {
    this.plugin = plugin;
    this.app = app;
  }

  getCurrentSessionName(): string {
    return this.currentSession;
  }

  getSessionNames(): string[] {
    return [...this.sessionOrder];
  }

  /** Mark a session as recently active — moves it to top of the list */
  touchSession(name: string): void {
    if (!this.sessions.has(name)) return;
    const idx = this.sessionOrder.indexOf(name);
    if (idx > 0) {
      this.sessionOrder.splice(idx, 1);
      this.sessionOrder.unshift(name);
    }
  }

  getCurrentContext(): ChatMessage[] {
    const session = this.sessions.get(this.currentSession);
    return session ? session.context : [];
  }

  getCurrentTokenCount(): number {
    const session = this.sessions.get(this.currentSession);
    return session ? session.tokenCount : 0;
  }

  async createSession(name?: string): Promise<string> {
    const sessionName = name || this.generateDefaultName();
    if (!this.sessions.has(sessionName)) {
      this.sessions.set(sessionName, { context: [], tokenCount: 0 });
      this.sessionOrder.unshift(sessionName);
    }
    this.currentSession = sessionName;
    return sessionName;
  }

  async switchToSession(name: string): Promise<boolean> {
    if (!this.sessions.has(name)) {
      const loaded = await this.loadSession(name);
      if (!loaded) return false;
    }
    this.currentSession = name;
    return true;
  }

  async addUserMessage(content: string): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;
    session.context.push({ role: 'user', content });
  }

  async addAssistantMessage(message: ChatMessage): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;
    session.context.push(message);
  }

  async addToolResult(toolCallId: string, content: string): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;
    session.context.push({ role: 'tool', content, tool_call_id: toolCallId });
  }

  async appendSystemMessage(content: string): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;
    session.context.push({ role: 'system', content });
  }

  updateTokenCount(promptTokens: number): void {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;
    session.tokenCount = promptTokens;
  }

  /** Estimate token count from context when API doesn't return usage (~4 chars per token) */
  estimateTokens(): number {
    const session = this.sessions.get(this.currentSession);
    if (!session) return 0;
    let chars = 0;
    for (const msg of session.context) {
      chars += msg.content.length;
      if (msg.reasoning_content) chars += msg.reasoning_content.length;
      if (msg.tool_calls) chars += JSON.stringify(msg.tool_calls).length;
    }
    return Math.max(1, Math.ceil(chars / 4));
  }

  needsCompression(): boolean {
    const session = this.sessions.get(this.currentSession);
    if (!session) return false;
    const threshold = this.plugin.settings.contextLength - this.plugin.settings.reserveSpace;
    return session.tokenCount > threshold;
  }

  async compressContext(apiConfig: { endpoint: string; apiKey: string; model: string }): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session || session.context.length <= 5) return;

    const keepCount = 5;
    const toCompress = session.context.slice(0, -keepCount);
    const recent = session.context.slice(-keepCount);

    const conversationText = toCompress.map(msg => this.formatMessageForSummary(msg)).join('\n\n');

    const messages: ChatMessage[] = [
      { role: 'system', content: 'Summarize the following conversation. Keep all key facts, decisions, file operations, and important context. Be concise but complete. Output only the summary.' },
      { role: 'user', content: `Conversation:\n\n${conversationText}\n\nProvide a concise summary.` },
    ];

    try {
      let summary = '';
      for await (const chunk of chatCompletionStream(messages, [], {
        endpoint: apiConfig.endpoint,
        apiKey: apiConfig.apiKey,
        model: apiConfig.model,
        thinkingMode: false,
      })) {
        if (chunk.contentDelta) summary += chunk.contentDelta;
        if (chunk.done) break;
      }
      session.context = [
        { role: 'system', content: `[Previous conversation summary:]\n${summary.trim()}` },
        ...recent,
      ];
    } catch {
      // Fallback: simple summary if LLM call fails
      session.context = [
        { role: 'system', content: `[Previous conversation summarized: ${toCompress.length} messages compressed]` },
        ...recent,
      ];
    }
  }

  private formatMessageForSummary(msg: ChatMessage): string {
    switch (msg.role) {
      case 'user':
        return `User: ${msg.content}`;
      case 'assistant': {
        let text = msg.content || '';
        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            text += `\n[Tool call: ${tc.function.name}(${tc.function.arguments})]`;
          }
        }
        return `Agent: ${text}`;
      }
      case 'tool':
        return `[Tool result: ${msg.content.substring(0, 500)}]`;
      case 'system':
        return `[System: ${msg.content}]`;
    }
  }

  async saveToDisk(): Promise<void> {
    this.schedulePersist();
  }

  async saveToMarkdown(): Promise<void> {
    this.schedulePersist();
  }

  /** Cancel pending debounce and write immediately (call on plugin unload) */
  async flushSaves(): Promise<void> {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDiskNow();
    await this.saveToMarkdownNow();
  }

  private schedulePersist(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveToDiskNow();
      this.saveToMarkdownNow();
    }, 2000);
  }

  private async saveToDiskNow(): Promise<void> {
    try {
      const sessionsObj: Record<string, SessionData> = {};
      this.sessions.forEach((sessionData, name) => {
        sessionsObj[name] = sessionData;
      });
      await this.plugin.saveData({
        sessions: sessionsObj,
        sessionOrder: this.sessionOrder,
      });
    } catch {
      console.warn('obsidian-sliver: failed to save data.json');
    }
  }

  async loadFromDisk(): Promise<void> {
    const raw = await this.plugin.loadData().catch(() => {
      console.warn('obsidian-sliver: data.json is corrupted, starting with empty sessions');
      return null;
    });
    if (!raw) return; // keep running with empty state, don't overwrite the corrupted file
    const data = raw as { sessions?: Record<string, SessionData>; sessionOrder?: string[] };
    if (data.sessions) {
      Object.entries(data.sessions).forEach(([name, sessionData]) => {
        this.sessions.set(name, sessionData);
      });
    }

    // Restore order from data.json, or derive from insertion order
    if (data.sessionOrder) {
      this.sessionOrder = data.sessionOrder.filter((n: string) => this.sessions.has(n));
    }
    // Add any sessions not in the restored order
    for (const name of this.sessions.keys()) {
      if (!this.sessionOrder.includes(name)) {
        this.sessionOrder.push(name);
      }
    }

    await this.scanMarkdownSessions();
  }

  /** Scan _agents/ for .md files and load any sessions not already in memory */
  private async scanMarkdownSessions(): Promise<void> {
    const dir = this.plugin.settings.sessionDir;
    const folder = this.app.vault.getFolderByPath(dir);
    if (!folder) return;

    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        const name = child.name.replace(/\.md$/, '');
        if (!this.sessions.has(name)) {
          // Try to derive original name — if name contains underscores from sanitization,
          // we use the file name as-is (it's already sanitized)
          // The session name in the Map is the file's display name
          this.sessions.set(name, { context: [], tokenCount: 0 });
          const loaded = await this.loadFromMarkdown(name);
          if (loaded) {
            this.sessionOrder.push(name);
          } else {
            this.sessions.delete(name);
          }
        }
      }
    }
  }

  private async saveToMarkdownNow(): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session) return;

    const dir = this.plugin.settings.sessionDir;
    const safeName = this.sanitizeFileName(this.currentSession);
    const filePath = normalizePath(`${dir}/${safeName}.md`);

    const folder = this.app.vault.getFolderByPath(dir);
    if (!folder) {
      try {
        await this.app.vault.createFolder(dir);
      } catch {}
    }

    const lines: string[] = [];
    for (const msg of session.context) {
      if (msg.role === 'user') {
        lines.push('## User');
        lines.push(msg.content);
      } else if (msg.role === 'assistant' && msg.content) {
        lines.push('## Agent');
        lines.push(msg.content);
      }
      lines.push('');
    }

    const text = lines.join('\n');
    const existing = this.app.vault.getFileByPath(filePath);
    if (existing) {
      await this.app.vault.modify(existing, text);
    } else {
      try {
        await this.app.vault.create(filePath, text);
      } catch {}
    }
  }

  async loadFromMarkdown(name: string): Promise<boolean> {
    const dir = this.plugin.settings.sessionDir;
    const safeName = this.sanitizeFileName(name);
    const filePath = normalizePath(`${dir}/${safeName}.md`);
    const file = this.app.vault.getFileByPath(filePath);
    if (!file) return false;

    const content = await this.app.vault.read(file);
    const context: ChatMessage[] = [];
    const lines = content.split('\n');

    let currentRole: 'user' | 'assistant' | null = null;
    let currentContent: string[] = [];

    for (const line of lines) {
      const userMatch = line.match(/^## User$/);
      const agentMatch = line.match(/^## Agent$/);

      if (userMatch) {
        if (currentRole && currentContent.length > 0) {
          context.push({ role: currentRole, content: currentContent.join('\n').trimEnd() });
        }
        currentRole = 'user';
        currentContent = [];
      } else if (agentMatch) {
        if (currentRole && currentContent.length > 0) {
          context.push({ role: currentRole, content: currentContent.join('\n').trimEnd() });
        }
        currentRole = 'assistant';
        currentContent = [];
      } else if (currentRole) {
        currentContent.push(line);
      }
    }

    if (currentRole && currentContent.length > 0) {
      context.push({ role: currentRole, content: currentContent.join('\n').trimEnd() });
    }

    this.sessions.set(name, { context, tokenCount: 0 });
    return true;
  }

  async loadSession(name: string): Promise<boolean> {
    if (this.sessions.has(name)) return true;

    try {
      const data = (await this.plugin.loadData()) as { sessions?: Record<string, SessionData> } | null;
      if (data?.sessions?.[name]) {
        this.sessions.set(name, data.sessions[name]);
        return true;
      }
    } catch {
      // Corrupted data.json — fall through to Markdown recovery
    }

    return this.loadFromMarkdown(name);
  }

  async deleteSession(name: string): Promise<void> {
    this.sessions.delete(name);
    const idx = this.sessionOrder.indexOf(name);
    if (idx !== -1) this.sessionOrder.splice(idx, 1);

    const dir = this.plugin.settings.sessionDir;
    const safeName = this.sanitizeFileName(name);
    const filePath = normalizePath(`${dir}/${safeName}.md`);
    const file = this.app.vault.getFileByPath(filePath);
    if (file) {
      await this.app.vault.delete(file);
    }

    if (this.currentSession === name) {
      this.currentSession = '';
    }
  }

  async renameSession(oldName: string, newName: string): Promise<void> {
    const session = this.sessions.get(oldName);
    if (!session) return;

    this.sessions.set(newName, session);
    this.sessions.delete(oldName);

    const dir = this.plugin.settings.sessionDir;
    const oldSafe = this.sanitizeFileName(oldName);
    const newSafe = this.sanitizeFileName(newName);
    const oldPath = normalizePath(`${dir}/${oldSafe}.md`);
    const newPath = normalizePath(`${dir}/${newSafe}.md`);
    const file = this.app.vault.getFileByPath(oldPath);
    if (file) {
      await this.app.vault.rename(file, newPath);
    }

    if (this.currentSession === oldName) {
      this.currentSession = newName;
    }
  }

  async clearCurrentSession(): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (session) {
      session.context = [];
      session.tokenCount = 0;
    }
  }

  getAllSessionsList(): { name: string; messageCount: number }[] {
    return Array.from(this.sessions.entries()).map(([name, data]) => ({
      name,
      messageCount: data.context.length,
    }));
  }

  /** Delete a message at index and all messages after it */
  deleteMessageFrom(index: number): void {
    const session = this.sessions.get(this.currentSession);
    if (!session || index < 0 || index >= session.context.length) return;
    session.context = session.context.slice(0, index);
    session.tokenCount = this.estimateTokens();
  }

  /** Edit the content of a message at index */
  editMessageAt(index: number, content: string): void {
    const session = this.sessions.get(this.currentSession);
    if (!session || index < 0 || index >= session.context.length) return;
    session.context[index] = { ...session.context[index], content };
    // Truncate everything after the edited message
    session.context = session.context.slice(0, index + 1);
    session.tokenCount = this.estimateTokens();
  }

  private generateDefaultName(): string {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}-${pad(now.getMinutes())}`;
  }

  /** Replace characters unsafe for file names */
  private sanitizeFileName(name: string): string {
    return name.replace(/[<>:"\/\\|?*\n\r]/g, '_').substring(0, 200);
  }
}
