import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import ObsidianAgentPlugin from './main';

function parseTokenValue(input: string): number | null {
  const v = input.trim().toLowerCase();
  if (v.endsWith('k')) { const n = parseFloat(v.slice(0, -1)); return !isNaN(n) && n > 0 ? Math.round(n * 1000) : null; }
  if (v.endsWith('m')) { const n = parseFloat(v.slice(0, -1)); return !isNaN(n) && n > 0 ? Math.round(n * 1000000) : null; }
  const n = parseInt(v); return !isNaN(n) && n > 0 ? n : null;
}

export interface PathRule {
  path: string;
  permission: 'read-write' | 'read-only' | 'denied' | 'follow-global';
}

export type GlobalPermission = 'read-only' | 'ask-per-write' | 'full-access';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface AgentSettings {
  apiEndpoint: string;
  apiKey: string;
  model: string;
  contextLength: number;
  reserveSpace: number;
  globalPermission: GlobalPermission;
  pathRules: PathRule[];
  sessionDir: string;
  skillsDir: string;
  thinkingMode: boolean;
  reasoningEffort: ReasoningEffort;
  systemPrompt: string;
  showSystemPrompt: boolean;
  showContextNotices: boolean;
}

export const DEFAULT_SYSTEM_PROMPT = `You are an AI assistant integrated into Obsidian. Your purpose is to help the user manage their Obsidian vault through conversation.

## Capabilities
You can read, create, edit, delete, and search files inside the vault, and load specialized skills for Obsidian-specific formats.

## Rules
- Always tell the user what you're about to do before doing it.
- Use loaded skills for specialized knowledge about Obsidian-specific formats.
- Keep responses concise and in Chinese unless the user asks otherwise.
- Use $...$ for inline math and $$...$$ for display math. Do NOT use \(...\) or \[...\].`;

export const DEFAULT_SETTINGS: AgentSettings = {
  apiEndpoint: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-chat',
  contextLength: 32768,
  reserveSpace: 8192,
  globalPermission: 'ask-per-write',
  pathRules: [],
  sessionDir: '_agents',
  skillsDir: '_agents/skills',
  thinkingMode: true,
  reasoningEffort: 'high',
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  showSystemPrompt: false,
  showContextNotices: true,
};

export class AgentSettingTab extends PluginSettingTab {
  plugin: ObsidianAgentPlugin;

  constructor(app: App, plugin: ObsidianAgentPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Agent Settings' });

    // API Configuration
    containerEl.createEl('h3', { text: 'API Configuration' });

    new Setting(containerEl)
      .setName('API Endpoint')
      .setDesc('OpenAI-compatible API endpoint')
      .addText(text => text
        .setPlaceholder('https://api.deepseek.com/v1')
        .setValue(this.plugin.settings.apiEndpoint)
        .onChange(async (value) => {
          this.plugin.settings.apiEndpoint = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('API Key')
      .setDesc('Your API key')
      .addText(text => {
        text.setPlaceholder('sk-...');
        text.setValue(this.plugin.settings.apiKey);
        text.inputEl.type = 'password';
        text.onChange(async (value) => {
          this.plugin.settings.apiKey = value;
          await this.plugin.saveSettings();
        });
      });

    let modelText: any;
    let modelDropdown: any;

    new Setting(containerEl)
      .setName('Model')
      .setDesc('Model name (e.g. deepseek-chat)')
      .addButton(button => button
        .setButtonText('获取')
        .setTooltip('Fetch available models from the API endpoint')
        .onClick(async () => {
          button.setButtonText('...');
          button.setDisabled(true);
          try {
            const endpoint = this.plugin.settings.apiEndpoint.replace(/\/+$/, '');
            const resp = await fetch(`${endpoint}/models`, {
              headers: { Authorization: `Bearer ${this.plugin.settings.apiKey}` },
            });
            if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}`);
            const json = await resp.json();
            const models: string[] = (json.data || [])
              .map((m: any) => m.id)
              .filter((id: string) => typeof id === 'string')
              .sort();
            modelDropdown.selectEl.empty();
            modelDropdown.addOption('', '— select —');
            for (const id of models) {
              modelDropdown.addOption(id, id);
            }
            modelDropdown.setValue(this.plugin.settings.model || '');
          } catch (e) {
            new Notice(`Failed to fetch models: ${(e as Error).message}`);
          }
          button.setButtonText('获取');
          button.setDisabled(false);
        }))
      .addDropdown(dropdown => {
        modelDropdown = dropdown;
        dropdown.addOption('', '— select —');
        dropdown.setValue('');
        dropdown.onChange(async (value) => {
          if (value && modelText) {
            this.plugin.settings.model = value;
            modelText.setValue(value);
            await this.plugin.saveSettings();
          }
        });
      })
      .addText(text => {
        modelText = text;
        text.setPlaceholder('deepseek-chat');
        text.setValue(this.plugin.settings.model);
        text.onChange(async (value) => {
          this.plugin.settings.model = value;
          await this.plugin.saveSettings();
        });
      });

    // Thinking Mode
    containerEl.createEl('h3', { text: 'Thinking Mode' });

    new Setting(containerEl)
      .setName('Enable Thinking Mode')
      .setDesc('Let the model show its reasoning process (chain-of-thought) before answering')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.thinkingMode)
        .onChange(async (value) => {
          this.plugin.settings.thinkingMode = value;
          await this.plugin.saveSettings();
          this.display();
        }));

    if (this.plugin.settings.thinkingMode) {
      new Setting(containerEl)
        .setName('Reasoning Effort')
        .setDesc('Controls how much effort the model spends on reasoning (low/medium map to high, xhigh maps to max)')
        .addDropdown(dropdown => dropdown
          .addOption('low', 'Low')
          .addOption('medium', 'Medium')
          .addOption('high', 'High')
          .addOption('max', 'Max')
          .setValue(this.plugin.settings.reasoningEffort)
          .onChange(async (value) => {
            this.plugin.settings.reasoningEffort = value as ReasoningEffort;
            await this.plugin.saveSettings();
          }));
    }

    // Context Management
    containerEl.createEl('h3', { text: 'Context Management' });

    new Setting(containerEl)
      .setName('Context Length')
      .setDesc('Maximum tokens for the model context window')
      .addText(text => text
        .setPlaceholder('32768 (or 32k)')
        .setValue(String(this.plugin.settings.contextLength))
        .onChange(async (value) => {
          const num = parseTokenValue(value);
          if (num !== null) {
            this.plugin.settings.contextLength = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Reserve Space')
      .setDesc('Tokens to reserve for agent responses. Compression triggers when used + reserve > context length.')
      .addText(text => text
        .setPlaceholder('8192 (or 8k)')
        .setValue(String(this.plugin.settings.reserveSpace))
        .onChange(async (value) => {
          const num = parseTokenValue(value);
          if (num !== null) {
            this.plugin.settings.reserveSpace = num;
            await this.plugin.saveSettings();
          }
        }));

    // Permission Management
    containerEl.createEl('h3', { text: 'Permission Management' });

    new Setting(containerEl)
      .setName('Global Permission Mode')
      .setDesc('Default access level for all file operations')
      .addDropdown(dropdown => dropdown
        .addOption('read-only', 'Read Only')
        .addOption('ask-per-write', 'Ask Per Write')
        .addOption('full-access', 'Full Access')
        .setValue(this.plugin.settings.globalPermission)
        .onChange(async (value) => {
          this.plugin.settings.globalPermission = value as GlobalPermission;
          await this.plugin.saveSettings();
        }));

    // Path Rules
    containerEl.createEl('h3', { text: 'Path Rules' });
    this.renderPathRules(containerEl);

    // Session Management
    containerEl.createEl('h3', { text: 'Session Management' });

    new Setting(containerEl)
      .setName('Session Directory')
      .setDesc('Directory in vault where session files are stored')
      .addText(text => text
        .setPlaceholder('_agents')
        .setValue(this.plugin.settings.sessionDir)
        .onChange(async (value) => {
          this.plugin.settings.sessionDir = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Skills Directory')
      .setDesc('Directory in vault where skill files are stored')
      .addText(text => text
        .setPlaceholder('_agents/skills')
        .setValue(this.plugin.settings.skillsDir)
        .onChange(async (value) => {
          this.plugin.settings.skillsDir = value;
          await this.plugin.saveSettings();
        }));

    // System Prompt
    containerEl.createEl('h3', { text: 'System Prompt' });

    new Setting(containerEl)
      .setName('Show system prompt in chat')
      .setDesc('Display the system prompt at the top of each conversation')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showSystemPrompt)
        .onChange(async (value) => {
          this.plugin.settings.showSystemPrompt = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show context notices')
      .setDesc('Display dynamic notices in chat (active file changes, permission changes, etc.)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showContextNotices)
        .onChange(async (value) => {
          this.plugin.settings.showContextNotices = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Custom System Prompt')
      .setDesc('The system prompt sent to the model on each request. Use this to customize the agent\'s behavior, role, or rules.')
      .addTextArea(text => text
        .setPlaceholder('Enter system prompt...')
        .setValue(this.plugin.settings.systemPrompt)
        .onChange(async (value) => {
          this.plugin.settings.systemPrompt = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Reset to Default')
      .setDesc('Restore the default system prompt')
      .addButton(button => button
        .setButtonText('Reset')
        .onClick(async () => {
          this.plugin.settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
          await this.plugin.saveSettings();
          this.display();
        }));

    // Skills
    containerEl.createEl('h3', { text: 'Skills' });

    new Setting(containerEl)
      .setName('Deploy Built-in Skills')
      .setDesc('Copy built-in skill files to the skills directory')
      .addButton(button => button
        .setButtonText('Deploy Skills')
        .onClick(async () => {
          await this.plugin.deployBuiltinSkills();
        }));
  }

  private renderPathRules(containerEl: HTMLElement) {
    const rules = this.plugin.settings.pathRules;

    rules.forEach((rule, index) => {
      new Setting(containerEl)
        .addText(text => text
          .setPlaceholder('path/to/folder')
          .setValue(rule.path)
          .onChange(async (value) => {
            this.plugin.settings.pathRules[index].path = value;
            await this.plugin.saveSettings();
          }))
        .addDropdown(dropdown => dropdown
          .addOption('read-write', 'Read/Write')
          .addOption('read-only', 'Read Only')
          .addOption('denied', 'Denied')
          .addOption('follow-global', 'Follow Global')
          .setValue(rule.permission)
          .onChange(async (value) => {
            this.plugin.settings.pathRules[index].permission = value as PathRule['permission'];
            await this.plugin.saveSettings();
          }))
        .addExtraButton(button => button
          .setIcon('trash')
          .setTooltip('Delete rule')
          .onClick(async () => {
            this.plugin.settings.pathRules.splice(index, 1);
            await this.plugin.saveSettings();
            this.display();
          }));
    });

    new Setting(containerEl)
      .addButton(button => button
        .setButtonText('Add Rule')
        .setCta()
        .onClick(async () => {
          this.plugin.settings.pathRules.push({
            path: '',
            permission: 'follow-global',
          });
          await this.plugin.saveSettings();
          this.display();
        }));
  }
}
