import { App, TFile, normalizePath } from 'obsidian';
import { ChatMessage } from '../utils/api';
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

  needsCompression(): boolean {
    const session = this.sessions.get(this.currentSession);
    if (!session) return false;
    const threshold = this.plugin.settings.contextLength - this.plugin.settings.reserveSpace;
    return session.tokenCount > threshold;
  }

  async compressContext(): Promise<void> {
    const session = this.sessions.get(this.currentSession);
    if (!session || session.context.length < 6) return;

    const earlyMessages = session.context.slice(0, -5);
    const recentMessages = session.context.slice(-5);

    const summary = `[Previous conversation summarized: ${earlyMessages.length} messages compressed]`;

    session.context = [
      { role: 'system', content: summary },
      ...recentMessages,
    ];
  }

  async saveToDisk(): Promise<void> {
    const data: Record<string, SessionData> = {};
    this.sessions.forEach((sessionData, name) => {
      data[name] = sessionData;
    });

    const existing = (await this.plugin.loadData()) || {};
    (existing as Record<string, unknown>).sessions = data;
    (existing as Record<string, unknown>).sessionOrder = this.sessionOrder;
    await this.plugin.saveData(existing);
  }

  async loadFromDisk(): Promise<void> {
    const data = (await this.plugin.loadData()) as { sessions?: Record<string, SessionData>; sessionOrder?: string[] } | null;
    if (data?.sessions) {
      Object.entries(data.sessions).forEach(([name, sessionData]) => {
        this.sessions.set(name, sessionData);
      });
    }

    // Restore order from data.json, or derive from insertion order
    if (data?.sessionOrder) {
      this.sessionOrder = data.sessionOrder.filter(n => this.sessions.has(n));
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

  async saveToMarkdown(): Promise<void> {
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
        lines.push(`**User**: ${msg.content}`);
      } else if (msg.role === 'assistant' && msg.content) {
        lines.push(`**Agent**: ${msg.content}`);
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
      const userMatch = line.match(/^\*\*User\*\*:\s*(.*)/);
      const agentMatch = line.match(/^\*\*Agent\*\*:\s*(.*)/);

      if (userMatch) {
        if (currentRole && currentContent.length > 0) {
          context.push({ role: currentRole, content: currentContent.join('\n') });
        }
        currentRole = 'user';
        currentContent = [userMatch[1]];
      } else if (agentMatch) {
        if (currentRole && currentContent.length > 0) {
          context.push({ role: currentRole, content: currentContent.join('\n') });
        }
        currentRole = 'assistant';
        currentContent = [agentMatch[1]];
      } else if (currentRole && line.trim()) {
        currentContent.push(line);
      } else if (currentRole && !line.trim()) {
        // Empty line within a message
        currentContent.push('');
      }
    }

    if (currentRole && currentContent.length > 0) {
      context.push({ role: currentRole, content: currentContent.join('\n') });
    }

    this.sessions.set(name, { context, tokenCount: 0 });
    return true;
  }

  async loadSession(name: string): Promise<boolean> {
    if (this.sessions.has(name)) return true;

    const data = (await this.plugin.loadData()) as { sessions?: Record<string, SessionData> } | null;
    if (data?.sessions?.[name]) {
      this.sessions.set(name, data.sessions[name]);
      return true;
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
    session.tokenCount = 0;
  }

  /** Edit the content of a message at index */
  editMessageAt(index: number, content: string): void {
    const session = this.sessions.get(this.currentSession);
    if (!session || index < 0 || index >= session.context.length) return;
    session.context[index] = { ...session.context[index], content };
    // Truncate everything after the edited message
    session.context = session.context.slice(0, index + 1);
    session.tokenCount = 0;
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
