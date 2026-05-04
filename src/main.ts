import { Plugin } from 'obsidian';
import { AgentView, VIEW_TYPE_AGENT } from './views/AgentView';
import { AgentSettings, AgentSettingTab, DEFAULT_SETTINGS } from './settings';
import { SkillManager } from './skills/SkillManager';
import { AgentCore } from './agent/AgentCore';

export default class ObsidianAgentPlugin extends Plugin {
  settings: AgentSettings;
  skillManager: SkillManager;
  agentCore: AgentCore;

  async onload() {
    await this.loadSettings();

    this.skillManager = new SkillManager(this.app);
    this.agentCore = new AgentCore(this, this.app);
    await this.agentCore.initialize();

    // Register the custom view
    this.registerView(VIEW_TYPE_AGENT, (leaf) => new AgentView(leaf, this));

    // Add ribbon icon
    this.addRibbonIcon('bot', 'Obsidian Agent', () => {
      this.activateView();
    });

    // Add command
    this.addCommand({
      id: 'open-agent',
      name: 'Open Agent Chat',
      callback: () => this.activateView(),
    });

    // Register settings tab
    this.addSettingTab(new AgentSettingTab(this.app, this));

    // Activate view on layout ready
    this.app.workspace.onLayoutReady(() => {
      this.activateView();
    });
  }

  async onunload() {
    if (this.agentCore) {
      await this.agentCore.getSessionManager().flushSaves();
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGENT);
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_AGENT).first();
    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (rightLeaf) {
        leaf = rightLeaf;
        await leaf.setViewState({ type: VIEW_TYPE_AGENT, active: true });
      }
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  async deployBuiltinSkills(): Promise<void> {
    await this.skillManager.deployBuiltinSkills();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    // Flush pending session saves to avoid race condition
    await this.agentCore.getSessionManager().flushSaves();
    // Merge with existing data to preserve sessions
    const data = { ...(await this.loadData()), ...this.settings };
    await this.saveData(data);
  }
}
