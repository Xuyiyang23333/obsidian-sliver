import { App, normalizePath, Notice, TFolder } from 'obsidian';

export const BUILTIN_SKILLS = [
  {
    id: 'obsidian-markdown',
    description: 'Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties.',
  },
  {
    id: 'json-canvas',
    description: 'Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections.',
  },
  {
    id: 'obsidian-bases',
    description: 'Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries.',
  },
  {
    id: 'vault-qa',
    description: 'Answer user questions using vault content as the primary source with wikilink citations. Use when the user asks a knowledge question that might have relevant notes in the vault.',
  },
];

export class SkillManager {
  private app: App;
  private availableSkills: { name: string; description: string }[] = [];

  constructor(app: App) {
    this.app = app;
  }

  /** Scan vault for skill directories and parse their frontmatter */
  async discoverSkills(): Promise<void> {
    const skillsDir = '_agents/skills';
    const dir = this.app.vault.getFolderByPath(skillsDir);
    if (!dir) { this.availableSkills = []; return; }

    const skills: { name: string; description: string }[] = [];
    for (const child of dir.children) {
      if (child instanceof TFolder) {
        const skillFile = this.app.vault.getFileByPath(normalizePath(`${skillsDir}/${child.name}/SKILL.md`));
        if (skillFile) {
          const content = await this.app.vault.read(skillFile);
          const fm = this.parseFrontmatter(content);
          // Use directory name as identifier (load_skill resolves by directory)
          const description = fm.description || '';
          if (description) {
            skills.push({ name: child.name, description });
          }
        }
      }
    }
    this.availableSkills = skills;
  }

  /** Get all discovered skills (name + description) for the tool description */
  getAvailableSkills(): { name: string; description: string }[] {
    // Use filesystem results; fall back to built-in list so agent always
    // knows what's available even before Deploy Skills is clicked.
    if (this.availableSkills.length > 0) return this.availableSkills;
    return BUILTIN_SKILLS.map(s => ({ name: s.id, description: s.description }));
  }

  /** Simple YAML frontmatter parser (--- … ---).
   *  Handles single-line values and indented block continuations (|, >). */
  private parseFrontmatter(content: string): { name?: string; description?: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return {};
    const fm: { name?: string; description?: string } = {};
    const lines = match[1].split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^(\w[\w-]*):\s*(.*)/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      if (key !== 'name' && key !== 'description') continue;
      let value = m[2].trim();
      // Block scalar indicator (|, >, |-, >-) — collect indented continuation lines
      if (/^[|>][-]?$/.test(value) || value === '') {
        value = '';
        i++;
        while (i < lines.length) {
          const line = lines[i];
          if (!line.startsWith('  ') && !line.startsWith('\t') && line.trim() !== '') break;
          if (value) value += ' ';
          value += line.trim();
          i++;
        }
        i--;
      }
      fm[key] = value.trim();
    }
    return fm;
  }

  async loadSkill(name: string): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const path = `_agents/skills/${name}/SKILL.md`;
    const file = this.app.vault.getFileByPath(path);
    if (!file) return { success: false, error: `Skill not found: ${name}` };
    const content = await this.app.vault.read(file);
    return { success: true, data: content };
  }

  async deployBuiltinSkills(): Promise<void> {
    const skillsDir = '_agents/skills';
    const dir = this.app.vault.getFolderByPath(skillsDir);
    if (!dir) {
      try { await this.app.vault.createFolder(skillsDir); } catch {}
    }

    for (const skill of BUILTIN_SKILLS) {
      const skillPath = normalizePath(`${skillsDir}/${skill.id}/SKILL.md`);
      const existing = this.app.vault.getFileByPath(skillPath);
      if (!existing) {
        try { await this.app.vault.createFolder(normalizePath(`${skillsDir}/${skill.id}`)); } catch {}
        await this.app.vault.create(skillPath, SKILL_CONTENTS[skill.id as keyof typeof SKILL_CONTENTS]);
      }
    }

    new Notice(`Deployed ${BUILTIN_SKILLS.length} skills to ${skillsDir}/`);
    await this.discoverSkills();
  }
}

const SKILL_CONTENTS = {
  'obsidian-markdown': `---
name: obsidian-markdown
description: Create and edit Obsidian Flavored Markdown with wikilinks, embeds, callouts, properties, and other Obsidian-specific syntax.
---

# Obsidian Flavored Markdown Skill

## Internal Links (Wikilinks)

\`\`\`markdown
[[Note Name]]                          Link to note
[[Note Name|Display Text]]             Custom display text
[[Note Name#Heading]]                  Link to heading
[[Note Name#^block-id]]                Link to block
\`\`\`

## Embeds

\`\`\`markdown
![[Note Name]]                         Embed full note
![[image.png]]                         Embed image
![[image.png|300]]                     Embed image with width
![[document.pdf#page=3]]               Embed PDF page
\`\`\`

## Callouts

\`\`\`markdown
> [!note] Title
> Content here.
> [!warning] Custom Title
> Warning callout.
> [!faq]- Collapsed by default
> Foldable callout (- collapsed, + expanded).
\`\`\`

Types: note, tip, warning, info, example, quote, bug, danger, success, failure, question, abstract, todo.

## Properties (Frontmatter)

\`\`\`yaml
---
title: My Note
date: 2024-01-15
tags:
  - project
aliases:
  - Alternative Name
cssclasses:
  - custom-class
---
\`\`\`

## Tags

\`\`\`markdown
#tag                    Inline tag
#nested/tag             Nested tag
\`\`\`

## Math (LaTeX)

\`\`\`markdown
Inline: $e^{i\\\\pi} + 1 = 0$
Block:
$$
\\\\frac{a}{b} = c
$$
\`\`\`
`,

  'json-canvas': `---
name: json-canvas
description: Create and edit JSON Canvas files (.canvas) with nodes, edges, groups, and connections.
---

# JSON Canvas Skill

## Structure

\`\`\`json
{
  "nodes": [
    {
      "id": "node1",
      "type": "text",
      "text": "Hello",
      "x": 100, "y": 200,
      "width": 200, "height": 100
    }
  ],
  "edges": [
    {
      "id": "edge1",
      "fromNode": "node1", "toNode": "node2",
      "fromSide": "bottom", "toSide": "top",
      "label": "connects to"
    }
  ]
}
\`\`\`

## Node Types

- \`text\` — Plain text node
- \`file\` — Reference to a vault file
- \`link\` — External URL
- \`group\` — Group container with optional label and background color
`,

  'obsidian-bases': `---
name: obsidian-bases
description: Create and edit Obsidian Bases (.base files) with views, filters, formulas, and summaries.
---

# Obsidian Bases Skill

## Schema

Base files use the .base extension and contain valid YAML:

\`\`\`yaml
scope:
  folder: Projects
  tags:
    - active
views:
  - type: table
    name: All Tasks
    columns:
      - name
      - status
filters:
  - field: status
    operator: is
    value: active
formulas:
  priority: 'count(tasks)'
\`\`\`

## View Types

- \`table\` — spreadsheet-like view
- \`cards\` — card layout
- \`list\` — simple list
- \`map\` — location-based view

## Formula Examples

- \`count(tasks)\` — count items in a relation property
- \`date(today) + 7\` — date arithmetic
`,

  'vault-qa': `---
name: vault-qa
description: Answer user questions using vault content as the primary source, with wikilink citations. Use when the user asks a knowledge question that might have relevant notes in the vault.
---

# Vault-Aware Q&A

## When to Use

The user asks something you don't know the answer to, or that might have related notes in their vault.

## Workflow

1. **Search** — Call \`search_files\` with keywords from the question
2. **Read** — Call \`read_file\` on the 2–3 most relevant results
3. **Answer** — Prioritize vault content over your own knowledge
4. **Cite** — Every claim sourced from the vault gets a wikilink: \`[[path/to/note]]\`
5. **Disclose** — If supplementing with general knowledge, make it clear which parts come from the vault and which don't

## Conflict Resolution

Vault content takes priority over your training knowledge. If they disagree, point it out and follow the vault.
`,
};
