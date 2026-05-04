import { ItemView, WorkspaceLeaf, MarkdownRenderer, Component } from 'obsidian';
import ObsidianAgentPlugin from '../main';
import { AgentCore, AgentEventCallback } from '../agent/AgentCore';
import { ChatMessage } from '../utils/api';

export const VIEW_TYPE_AGENT = 'obsidian-agent-view';

export class AgentView extends ItemView {
  private plugin: ObsidianAgentPlugin;
  private agentCore: AgentCore;
  private messagesContainer: HTMLElement;
  private inputEl: HTMLTextAreaElement;
  private sendBtn: HTMLElement;
  private ctxBar: HTMLElement;
  private ctxFill: HTMLElement;
  private ctxLabel: HTMLElement;
  private sessionLabel: HTMLElement;
  private sessionPopup: HTMLElement | null = null;
  private sessionPopupCloser: ((e: MouseEvent) => void) | null = null;
  private mdComponent: Component;

  private currentBubble: HTMLElement | null = null;
  private bubbleText = '';
  private bubbleContentDiv: HTMLElement | null = null;
  private hasToolsAfterBubble = false;
  private toolsContainer: HTMLElement | null = null;
  private liveParaTimer: number | null = null;

  private reasoningToggle: HTMLElement | null = null;
  private reasoningContentDiv: HTMLElement | null = null;
  private pendingReasoning = '';
  private needReasoningSep = false;
  private pendingNewSession = false;
  private bubbleReceivedContent = false;
  private userHasScrolledUp = false;

  constructor(leaf: WorkspaceLeaf, plugin: ObsidianAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.agentCore = plugin.agentCore;
    this.mdComponent = new Component();
  }

  getViewType(): string { return VIEW_TYPE_AGENT; }
  getDisplayText(): string { return 'Agent'; }
  getIcon(): string { return 'bot'; }

  async onOpen(): Promise<void> {
    const container = this.containerEl;
    container.empty();
    container.addClass('agent-container');

    const headerEl = container.createDiv({ cls: 'agent-header' });
    this.sessionLabel = headerEl.createDiv({ cls: 'agent-session-label' });
    this.sessionLabel.setText('...');
    this.sessionLabel.addEventListener('click', () => this.toggleSessionPopup());

    const btns = headerEl.createDiv({ cls: 'agent-header-buttons' });
    const settingsBtn = btns.createEl('button', { cls: 'agent-header-btn' });
    settingsBtn.innerHTML = '⚙️'; settingsBtn.title = 'Settings';
    settingsBtn.addEventListener('click', () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById('obsidian-agent');
    });

    this.messagesContainer = container.createDiv({ cls: 'agent-messages' });

    // Handle wikilink clicks — MarkdownRenderer doesn't wire these in custom views
    this.messagesContainer.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('.internal-link') as HTMLElement | null;
      if (link) {
        e.preventDefault();
        e.stopPropagation();
        const href = link.getAttribute('data-href') || link.getAttribute('href') || '';
        if (href) this.app.workspace.openLinkText(href, '', false);
      }
    });

    // Track manual scroll — user scrolling up pauses auto-scroll
    this.messagesContainer.addEventListener('scroll', () => {
      const el = this.messagesContainer;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 2;
      this.userHasScrolledUp = !atBottom;
    });

    const inputContainer = container.createDiv({ cls: 'agent-input-container' });

    this.inputEl = inputContainer.createEl('textarea', {
      cls: 'agent-input',
      attr: { placeholder: 'Type your request...', rows: '1' },
    });
    this.inputEl.addEventListener('input', () => this.autoResizeInput());
    this.autoResizeInput();
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.onSendClick(); }
    });
    this.sendBtn = inputContainer.createEl('button', { cls: 'agent-send-btn' });
    this.sendBtn.setText('Send');
    this.sendBtn.addEventListener('click', () => this.onSendClick());

    // Context usage bar (footer)
    const ctxBar = container.createDiv({ cls: 'agent-ctx-bar' });
    const ctxTrack = ctxBar.createDiv({ cls: 'agent-ctx-track' });
    const ctxFill = ctxTrack.createDiv({ cls: 'agent-ctx-fill' });
    const ctxLabel = ctxBar.createDiv({ cls: 'agent-ctx-label' });
    this.ctxBar = ctxBar;
    this.ctxFill = ctxFill;
    this.ctxLabel = ctxLabel;

    this.addChild(this.mdComponent);
    this.refreshSessionDropdown();
  }

  onClose(): Promise<void> { return Promise.resolve(); }

  private onSendClick(): void {
    if (this.agentCore.isProcessing) {
      this.agentCore.cancelCurrentRequest();
      this.sendBtn.setText('Send');
      this.sendBtn.removeClass('agent-send-cancel');
      this.finalizeBubble();
    } else {
      this.sendMessage();
    }
  }

  private async sendMessage(): Promise<void> {
    if (this.agentCore.isProcessing) return;
    const text = this.inputEl.value.trim();
    if (!text) return;

    // Reset per-turn state
    this.reasoningToggle = null;
    this.reasoningContentDiv = null;
    this.pendingReasoning = '';
    this.needReasoningSep = false;
    this.bubbleReceivedContent = false;
    this.userHasScrolledUp = false;

    // Remove stale system prompt if setting was toggled off mid-conversation
    if (!this.plugin.settings.showSystemPrompt) {
      this.messagesContainer.querySelectorAll('.agent-system-prompt').forEach(el => el.remove());
    }

    const sm = this.agentCore.getSessionManager();
    if (this.pendingNewSession || !sm.getCurrentSessionName()) {
      await sm.createSession();
      this.messagesContainer.empty();
      if (this.plugin.settings.showSystemPrompt) {
        this.addSystemMessage(this.plugin.settings.systemPrompt, 'agent-system-prompt');
      }
      this.pendingNewSession = false;
    }
    this.inputEl.value = '';
    this.addUserMessage(text);
    sm.touchSession(sm.getCurrentSessionName());
    this.sendBtn.setText('Cancel');
    this.sendBtn.addClass('agent-send-cancel');
    this.agentCore.setCallbacks(this.getCallbacks());
    await this.agentCore.processUserMessage(text);
    this.finalizeBubble();
    // If no content was streamed to the bubble (answer was in reasoning), rebuild from context
    if (this.bubbleReceivedContent) {
      this.collapseReasoning();
    } else {
      this.reloadCurrentMessages();
    }
    this.sendBtn.setText('Send');
    this.sendBtn.removeClass('agent-send-cancel');
    this.refreshSessionDropdown();
  }

  private getCallbacks(): AgentEventCallback {
    return {
      onThinking: () => {},
      onReasoningChunk: (t) => this.onReasoningChunk(t),
      onToolProgress: (n, s, r) => this.onToolProgress(n, s, r),
      onConfirmationRequest: (n, a) => new Promise(r => this.showConfirm(n, a, r)),
      onAssistantChunk: (t) => this.onAssistantChunk(t),
      onAssistantComplete: () => this.finalizeBubble(),
      onError: (e) => {
        this.sendBtn.setText('Send'); this.sendBtn.removeClass('agent-send-cancel');
        this.finalizeBubble(); this.addErrorMessage(e);
      },
      onContextCompressed: () => {
        if (this.plugin.settings.showContextNotices) this.addSystemMessage('Context compressed.');
      },
      onSystemMessage: (content) => {
        if (this.plugin.settings.showContextNotices) this.addSystemMessage(content);
      },
    };
  }

  // ---- Messages ----

  private addUserMessage(content: string): void {
    const el = this.addMsgEl(content, 'agent-message agent-message-user');
    this.addActionsBar(el, content, this.currentMsgIndex());
  }

  private addSystemMessage(content: string, extraCls?: string): void {
    const div = this.messagesContainer.createDiv({
      cls: 'agent-message agent-message-system' + (extraCls ? ' ' + extraCls : ''),
    });
    MarkdownRenderer.render(this.app, content, div, '', this.mdComponent);
    this.scrollBottom();
  }

  private addErrorMessage(content: string): void {
    const div = this.messagesContainer.createDiv({ cls: 'agent-message agent-message-error' });
    div.setText('❌ ' + content);
    this.scrollBottom();
  }

  /** Get the context index for the last user or assistant message */
  private currentMsgIndex(): number {
    const ctx = this.agentCore.getSessionManager().getCurrentContext();
    for (let i = ctx.length - 1; i >= 0; i--) {
      if (ctx[i].role === 'user' || ctx[i].role === 'assistant') return i;
    }
    return -1;
  }

  private addMsgEl(text: string, cls: string): HTMLElement {
    const el = this.messagesContainer.createDiv({ cls });
    el.setText(text);
    return el;
  }

  /** Create action bar (📋 ✏️ 🗑️) as a sibling after the message element */
  private addActionsBar(el: HTMLElement, text: string, index: number): void {
    // Always wrap the message, even if index is invalid (buttons come later on reload)
    const wrapperCls = el.hasClass('agent-message-user')
      ? 'agent-message-wrapper agent-message-wrapper-user'
      : 'agent-message-wrapper agent-message-wrapper-agent';
    const wrapper = this.messagesContainer.createDiv({ cls: wrapperCls });
    this.messagesContainer.insertBefore(wrapper, el);
    wrapper.appendChild(el);
    if (index < 0) return; // no buttons until context index is available
    const bar = wrapper.createDiv({ cls: 'agent-actions-bar' });

    // Copy button
    const copyBtn = bar.createEl('button', { cls: 'agent-action-btn' });
    copyBtn.setText('📋'); copyBtn.title = 'Copy';
    copyBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await navigator.clipboard.writeText(text);
      copyBtn.setText('✅');
      setTimeout(() => copyBtn.setText('📋'), 1500);
    });

    // Edit button
    const editBtn = bar.createEl('button', { cls: 'agent-action-btn' });
    editBtn.setText('✏️'); editBtn.title = 'Edit';
    editBtn.addEventListener('click', (e) => { e.stopPropagation(); this.startEdit(el, index); });

    // Regenerate button
    const regenBtn = bar.createEl('button', { cls: 'agent-action-btn' });
    regenBtn.setText('🔄'); regenBtn.title = 'Regenerate';
    regenBtn.addEventListener('click', (e) => { e.stopPropagation(); this.regenerate(index); });

    // Delete button
    const delBtn = bar.createEl('button', { cls: 'agent-action-btn' });
    delBtn.setText('🗑️'); delBtn.title = 'Delete';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (delBtn.getText() === '🗑️') {
        delBtn.setText('确认?'); delBtn.addClass('agent-action-confirm');
        setTimeout(() => {
          if (delBtn.getText() === '确认?') { delBtn.setText('🗑️'); delBtn.removeClass('agent-action-confirm'); }
        }, 3000);
      } else {
        this.deleteMessage(index);
      }
    });
  }

  private startEdit(el: HTMLElement, index: number): void {
    // Prevent multiple edit instances
    if (el.querySelector('.agent-edit-input')) return;

    const sm = this.agentCore.getSessionManager();
    const ctx = sm.getCurrentContext();
    const msg = ctx[index];
    if (!msg) return;

    const contentArea = el.querySelector('.agent-bubble-content') || el;
    const originalText = msg.content;
    const area = contentArea as HTMLElement | null;
    if (area && area !== el) area.style.display = 'none';

    const container = el.createDiv({ cls: 'agent-edit-container' });
    const textarea = container.createEl('textarea', { cls: 'agent-edit-input' });
    textarea.setText(originalText);

    const btnRow = container.createDiv({ cls: 'agent-edit-buttons' });
    const saveBtn = btnRow.createEl('button', { cls: 'agent-edit-save' });
    saveBtn.setText('Save');
    const cancelBtn = btnRow.createEl('button', { cls: 'agent-edit-cancel' });
    cancelBtn.setText('Cancel');

    const finish = (save: boolean) => {
      if (save) {
        const newText = textarea.value;
        if (newText && newText !== originalText) {
          sm.editMessageAt(index, newText);
          sm.saveToDisk();
          sm.saveToMarkdown();
        }
      }
      this.reloadCurrentMessages();
    };

    saveBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    textarea.focus();
  }

  private regenerate(index: number): void {
    const sm = this.agentCore.getSessionManager();
    const ctx = sm.getCurrentContext();

    // Reset per-turn state (same as sendMessage)
    this.reasoningToggle = null;
    this.reasoningContentDiv = null;
    this.pendingReasoning = '';
    this.needReasoningSep = false;
    this.bubbleReceivedContent = false;
    this.userHasScrolledUp = false;

    // Find the user message at or before this index
    let userIdx = -1;
    for (let i = index; i >= 0; i--) {
      if (ctx[i]?.role === 'user') { userIdx = i; break; }
    }
    if (userIdx < 0) return;

    const userText = ctx[userIdx].content;
    if (!userText) return;

    // Truncate context after this user message
    sm.deleteMessageFrom(userIdx + 1);

    // Rebuild UI and send message again
    this.reloadCurrentMessages();

    // Auto-send the message
    this.inputEl.value = '';
    sm.touchSession(sm.getCurrentSessionName());
    this.sendBtn.setText('Cancel');
    this.sendBtn.addClass('agent-send-cancel');
    this.agentCore.setCallbacks(this.getCallbacks());
    this.agentCore.processUserMessage(userText, true).then(() => {
      this.finalizeBubble();
      if (this.bubbleReceivedContent) {
        this.collapseReasoning();
      } else {
        this.reloadCurrentMessages();
      }
      this.sendBtn.setText('Send');
      this.sendBtn.removeClass('agent-send-cancel');
      this.refreshSessionDropdown();
    });
  }

  private deleteMessage(index: number): void {
    const sm = this.agentCore.getSessionManager();
    sm.deleteMessageFrom(index);
    sm.saveToDisk();
    sm.saveToMarkdown();
    this.reloadCurrentMessages();
  }

  private reloadCurrentMessages(): void {
    // Clean up old markdown components to prevent memory leak
    this.removeChild(this.mdComponent);
    this.mdComponent = new Component();
    this.addChild(this.mdComponent);

    this.messagesContainer.empty();
    this.userHasScrolledUp = false;
    
    // Show system prompt at top if enabled
    if (this.plugin.settings.showSystemPrompt) {
      this.addSystemMessage(this.plugin.settings.systemPrompt, 'agent-system-prompt');
    }
    
    const ctx = this.agentCore.getSessionManager().getCurrentContext();

    // Pre-scan: merge reasoning_content across assistant messages within each turn.
    // A "turn" spans from one user message to just before the next user message.
    const turnFirstReasoning: number[] = []; // first assistant index with reasoning per turn
    const turnMergedReasoning: string[] = []; // merged reasoning text per turn
    const msgTurn: number[] = new Array(ctx.length).fill(-1);
    let turn = -1;

    for (let i = 0; i < ctx.length; i++) {
      const m = ctx[i];
      if (m.role === 'user') turn++;
      msgTurn[i] = turn;

      if (turn >= 0 && m.role === 'assistant' && m.reasoning_content) {
        if (turnFirstReasoning[turn] === undefined) {
          turnFirstReasoning[turn] = i;
          turnMergedReasoning[turn] = m.reasoning_content;
        } else {
          turnMergedReasoning[turn] += '\n\n' + m.reasoning_content;
        }
      }
    }

    for (let i = 0; i < ctx.length; i++) {
      const m = ctx[i];
      const t = msgTurn[i];

      if (m.role === 'user') {
        const el = this.messagesContainer.createDiv({ cls: 'agent-message agent-message-user' });
        el.setText(m.content);
        this.addActionsBar(el, m.content, i);
      } else if (m.role === 'assistant' && !m.tool_calls) {
        const div = this.messagesContainer.createDiv({ cls: 'agent-message agent-message-agent' });
        if (turnFirstReasoning[t] === i) this.addReasoningToggle(div, turnMergedReasoning[t]);
        if (m.content) MarkdownRenderer.render(this.app, m.content, div, '', this.mdComponent);
        if (m.content) this.addActionsBar(div, m.content, i);
      } else if (m.role === 'assistant' && m.tool_calls) {
        if (m.content || m.reasoning_content) {
          const div = this.messagesContainer.createDiv({ cls: 'agent-message agent-message-agent' });
          if (turnFirstReasoning[t] === i) this.addReasoningToggle(div, turnMergedReasoning[t]);
          if (m.content) {
            MarkdownRenderer.render(this.app, m.content, div, '', this.mdComponent);
            this.addActionsBar(div, m.content, i);
          }
        }
        const toolContainer = this.messagesContainer.createDiv({ cls: 'agent-tools' });
        for (const tc of m.tool_calls) {
          const resultMsg = ctx.slice(i + 1).find((r: ChatMessage) => r.role === 'tool' && r.tool_call_id === tc.id);
          const resultStr = resultMsg?.content || '';
          const isError = resultStr.startsWith('Error:');
          const row = toolContainer.createDiv({ cls: 'agent-tool-row tool-' + (isError ? 'error' : 'done') });
          row.setAttr('data-tool', tc.function.name);
          row.setText(`${isError ? '❌' : '✅'} ${tc.function.name}`);
          if (resultStr) {
            row.addClass('agent-tool-clickable');
            const rd = row.createDiv({ cls: 'agent-tool-result' });
            rd.setText(resultStr.length > 200 ? resultStr.substring(0, 200) + '…' : resultStr);
            rd.style.display = 'none';
            row.addEventListener('click', (e) => { e.stopPropagation(); rd.style.display = rd.style.display === 'none' ? 'block' : 'none'; });
          }
        }
      } else if (m.role === 'system') {
        if (this.plugin.settings.showContextNotices) this.addSystemMessage(m.content);
      }
    }
    this.scrollBottom();
    this.updateContextBar();
  }

  // ---- Reasoning ----

  private onReasoningChunk(text: string): void {
    if (this.needReasoningSep) { this.pendingReasoning += '\n\n'; this.needReasoningSep = false; }
    this.pendingReasoning += text;
    if (!this.reasoningToggle) {
      const wrapper = this.messagesContainer.createDiv({ cls: 'agent-reasoning-wrapper' });
      this.reasoningToggle = wrapper.createDiv({ cls: 'agent-reasoning-toggle' });
      this.reasoningToggle.setText('💭 Hide reasoning');
      this.reasoningContentDiv = wrapper.createDiv({ cls: 'agent-reasoning-content' });
      this.reasoningContentDiv.style.display = 'block';
      this.reasoningToggle.addEventListener('click', () => {
        const hidden = this.reasoningContentDiv!.style.display === 'none';
        this.reasoningContentDiv!.style.display = hidden ? 'block' : 'none';
        this.reasoningToggle!.setText(hidden ? '💭 Hide reasoning' : '💭 Show reasoning');
      });
    }
    if (this.reasoningContentDiv) this.reasoningContentDiv.setText(this.pendingReasoning);
    this.smartScroll();
  }

  private collapseReasoning(): void {
    if (this.reasoningContentDiv && this.reasoningToggle) {
      this.reasoningContentDiv.style.display = 'none';
      this.reasoningToggle.setText('💭 Show reasoning');
    }
  }

  private autoResizeInput(): void {
    this.inputEl.style.height = '';
    const h = this.inputEl.scrollHeight;
    this.inputEl.style.height = Math.max(36, Math.min(h + 2, 96)) + 'px';
  }

  // ---- Tool progress ----

  private onToolProgress(toolName: string, status: 'running' | 'done' | 'error', result?: string): void {
    this.hasToolsAfterBubble = true;
    this.needReasoningSep = true;
    let container: HTMLElement;
    if (this.currentBubble) {
      const next = this.currentBubble.nextElementSibling as HTMLElement | null;
      if (next && next.hasClass('agent-tools')) { container = next; }
      else { container = this.messagesContainer.createDiv({ cls: 'agent-tools' }); this.messagesContainer.insertAfter(container, this.currentBubble); }
      this.toolsContainer = null;
    } else if (this.toolsContainer) { container = this.toolsContainer; }
    else { container = this.messagesContainer.createDiv({ cls: 'agent-tools' }); this.toolsContainer = container; }
    const icon = status === 'running' ? '⏳' : status === 'done' ? '✅' : '❌';
    const rcls = 'agent-tool-row tool-' + status;
    let row = container.querySelector(`[data-tool="${toolName}"]`) as HTMLElement | null;
    if (!row) { row = container.createDiv({ cls: rcls }); row.setAttr('data-tool', toolName); }
    row.empty(); row.className = rcls; row.setText(`${icon} ${toolName}`);
    if (result && status !== 'running') {
      row.addClass('agent-tool-clickable');
      const rd = row.createDiv({ cls: 'agent-tool-result' });
      rd.setText(result.length > 200 ? result.substring(0, 200) + '…' : result);
      rd.style.display = 'none';
      row.addEventListener('click', (e) => { e.stopPropagation(); rd.style.display = rd.style.display === 'none' ? 'block' : 'none'; });
    }
    this.smartScroll();
  }

  // ---- Streaming ----

  private onAssistantChunk(text: string): void {
    if (this.hasToolsAfterBubble) this.finalizeBubble();
    if (!this.currentBubble) {
      this.currentBubble = this.messagesContainer.createDiv({ cls: 'agent-message agent-message-agent' });
      this.bubbleText = '';
      this.bubbleContentDiv = this.currentBubble.createDiv({ cls: 'agent-bubble-content' });
    }
    this.bubbleText += text;
    this.bubbleReceivedContent = true;
    if (this.bubbleContentDiv) {
      const parts = this.splitParagraphs(this.bubbleText);
      for (let i = 0; i < parts.length - 1; i++) {
        let paraEl = this.bubbleContentDiv.children[i] as HTMLElement | undefined;
        if (!paraEl || paraEl.hasClass('agent-streaming')) {
          if (paraEl) paraEl.remove();
          const rendered = this.bubbleContentDiv.createDiv();
          MarkdownRenderer.render(this.app, parts[i], rendered, '', this.mdComponent);
        }
      }
      const liveIdx = parts.length - 1;
      let liveEl = this.bubbleContentDiv.children[liveIdx] as HTMLElement | undefined;
      if (!liveEl) liveEl = this.bubbleContentDiv.createDiv({ cls: 'agent-streaming' });
      liveEl.setText(parts[liveIdx]);
      if (this.liveParaTimer !== null) clearTimeout(this.liveParaTimer);
      // Capture element reference so timer doesn't rely on stale index
      const capturedEl = liveEl;
      const capturedText = parts[liveIdx];
      this.liveParaTimer = window.setTimeout(() => {
        this.liveParaTimer = null;
        if (capturedEl.parentElement && capturedEl.hasClass('agent-streaming') && capturedText) {
          capturedEl.empty(); capturedEl.removeClass('agent-streaming');
          MarkdownRenderer.render(this.app, capturedText, capturedEl, '', this.mdComponent);
        }
      }, 200);
      while (this.bubbleContentDiv.children.length > parts.length) this.bubbleContentDiv.lastChild?.remove();
    }
    this.smartScroll();
  }

  private finalizeBubble(): void {
    if (this.liveParaTimer !== null) { clearTimeout(this.liveParaTimer); this.liveParaTimer = null; }
    if (this.currentBubble && this.bubbleText && this.bubbleContentDiv) {
      this.bubbleContentDiv.empty();
      MarkdownRenderer.render(this.app, this.bubbleText, this.bubbleContentDiv, '', this.mdComponent);
      const idx = this.currentMsgIndex();
      if (idx >= 0) this.addActionsBar(this.currentBubble, this.bubbleText, idx);
    }
    this.currentBubble = null; this.bubbleContentDiv = null; this.bubbleText = '';
    this.hasToolsAfterBubble = false; this.toolsContainer = null;
  }

  private splitParagraphs(text: string): string[] {
    const parts = text.split('\n\n');
    if (parts.length > 1 && parts[parts.length - 1] === '') return parts.slice(0, -1);
    return parts;
  }

  private addReasoningToggle(el: HTMLElement, reasoning: string): void {
    const toggle = el.createDiv({ cls: 'agent-reasoning-toggle' });
    toggle.setText('💭 Show reasoning');
    const content = el.createDiv({ cls: 'agent-reasoning-content' });
    content.setText(reasoning); content.style.display = 'none';
    toggle.addEventListener('click', () => {
      const hidden = content.style.display === 'none';
      content.style.display = hidden ? 'block' : 'none';
      toggle.setText(hidden ? '💭 Hide reasoning' : '💭 Show reasoning');
    });
  }

  // ---- Confirmation ----

  private showConfirm(toolName: string, args: Record<string, unknown>, resolve: (v: boolean) => void): void {
    const div = this.messagesContainer.createDiv({ cls: 'agent-confirm-dialog' });
    div.createDiv({ cls: 'agent-confirm-message' }).setText(`🔒 Agent wants to: ${toolName} ${JSON.stringify(args)}`);
    const btns = div.createDiv({ cls: 'agent-confirm-buttons' });
    const mk = (text: string, cls: string, cb: () => void) => {
      const b = btns.createEl('button', { cls: 'agent-confirm-btn ' + cls });
      b.setText(text); b.addEventListener('click', () => { div.remove(); cb(); });
    };
    mk('Deny', 'agent-confirm-deny', () => resolve(false));
    mk('Allow', 'agent-confirm-allow', () => resolve(true));
    mk('Allow session', 'agent-confirm-session', async () => { await this.agentCore.updatePermission('full-access'); resolve(true); });
    this.scrollBottom();
  }

  // ---- Session ----

  private async deleteCurrentSession(): Promise<void> {
    const sm = this.agentCore.getSessionManager(); const name = sm.getCurrentSessionName();
    if (!name) return;
    if (!confirm(`Delete session "${name}"?`)) return;
    await sm.deleteSession(name); await sm.saveToDisk();
    this.messagesContainer.empty();
    const remaining = sm.getSessionNames();
    if (remaining.length > 0) await sm.switchToSession(remaining[0]);
    else await sm.createSession();
    this.reloadCurrentMessages(); this.refreshSessionDropdown();
  }

  private async createNewSession(): Promise<void> {
    this.messagesContainer.empty(); this.pendingNewSession = true; this.refreshSessionDropdown();
  }

  private async switchToSession(name: string): Promise<void> {
    this.reset();
    const ok = await this.agentCore.getSessionManager().switchToSession(name);
    if (!ok) return;
    this.reloadCurrentMessages(); this.refreshSessionDropdown();
  }

  private refreshSessionDropdown(): void {
    const cur = this.agentCore.getSessionManager().getCurrentSessionName();
    this.sessionLabel.setText(this.pendingNewSession ? 'New Chat' : (cur || 'New Chat'));
    this.updateContextBar();
  }

  private updateContextBar(): void {
    const sm = this.agentCore.getSessionManager();
    const used = sm.getCurrentTokenCount();
    const total = this.plugin.settings.contextLength;
    const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
    this.ctxFill.style.width = pct + '%';
    this.ctxLabel.setText(`${used.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`);
    const hue = pct > 80 ? 0 : pct > 50 ? 50 : 120;
    this.ctxFill.style.background = `hsl(${hue}, 70%, 45%)`;
  }

  private toggleSessionPopup(): void {
    if (this.agentCore.isProcessing) return;
    if (this.sessionPopup) { this.closeSessionPopup(); return; }
    const sm = this.agentCore.getSessionManager(); const names = sm.getSessionNames();
    const cur = this.pendingNewSession ? null : sm.getCurrentSessionName();
    const header = this.containerEl.querySelector('.agent-header'); if (!header) return;
    const popup = header.createDiv({ cls: 'agent-session-popup' }); this.sessionPopup = popup;

    // New Session at top
    const newItem = popup.createDiv({ cls: 'agent-session-item agent-session-new' });
    newItem.setText('+ New Session');
    newItem.addEventListener('click', () => { this.closeSessionPopup(); this.createNewSession(); });

    for (const name of names) {
      const item = popup.createDiv({ cls: 'agent-session-item' });
      if (name === cur) item.addClass('agent-session-active');
      item.createSpan({ cls: 'agent-session-item-name' }).setText(name);
      item.addEventListener('click', () => { this.closeSessionPopup(); this.pendingNewSession = false; this.switchToSession(name); });
      const del = item.createEl('button', { cls: 'agent-session-item-del' });
      del.setText('×');
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (del.getText() === '×') {
          del.setText('确认删除?'); del.addClass('agent-session-del-confirm');
          setTimeout(() => { if (del.getText() === '确认删除?') { del.setText('×'); del.removeClass('agent-session-del-confirm'); } }, 3000);
        } else {
          this.closeSessionPopup(); await sm.deleteSession(name); await sm.saveToDisk();
          const remaining = sm.getSessionNames();
          if (remaining.length > 0) await sm.switchToSession(remaining[0]); else await sm.createSession();
          this.reloadCurrentMessages(); this.refreshSessionDropdown();
        }
      });
    }
    const closer = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!popup.contains(t) && t !== this.sessionLabel) { this.closeSessionPopup(); }
    };
    this.sessionPopupCloser = closer;
    setTimeout(() => document.addEventListener('click', closer), 10);
  }

  private closeSessionPopup(): void {
    if (this.sessionPopupCloser) {
      document.removeEventListener('click', this.sessionPopupCloser);
      this.sessionPopupCloser = null;
    }
    if (this.sessionPopup) { this.sessionPopup.remove(); this.sessionPopup = null; }
  }

  private reset(): void {
    this.currentBubble = null; this.bubbleContentDiv = null; this.bubbleText = '';
    this.hasToolsAfterBubble = false; this.toolsContainer = null;
    if (this.liveParaTimer !== null) { clearTimeout(this.liveParaTimer); this.liveParaTimer = null; }
    this.reasoningToggle = null; this.reasoningContentDiv = null;
    this.pendingReasoning = ''; this.needReasoningSep = false; this.pendingNewSession = false;
    this.bubbleReceivedContent = false;
    this.closeSessionPopup();
  }

  private scrollBottom(): void {
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /** Only auto-scroll if user hasn't manually scrolled up. */
  private smartScroll(): void {
    if (!this.userHasScrolledUp) {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    }
  }
}
