import { App, TFile, TFolder, Notice } from 'obsidian';
import { PermissionResult } from './permissions';
import { ToolDefinition } from '../utils/api';

export interface ToolContext {
  app: App;
  checkPermission: (filePath: string, operation: 'read' | 'write' | 'delete') => PermissionResult;
  onConfirmRequest?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
}

export interface ToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export async function readFile(ctx: ToolContext, path: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path, 'read');
  if (!perm.allowed) return { success: false, error: perm.reason };

  const file = ctx.app.vault.getFileByPath(path);
  if (!file) return { success: false, error: `File not found: ${path}` };

  const content = await ctx.app.vault.read(file);
  return { success: true, data: content };
}

export async function writeFile(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path, 'write');
  if (!perm.allowed) return { success: false, error: perm.reason };
  if (perm.requiresConfirmation) {
    const confirmed = await ctx.onConfirmRequest?.('write_file', { path, contentLength: content.length });
    if (!confirmed) return { success: false, error: 'Operation cancelled by user' };
  }

  const existing = ctx.app.vault.getFileByPath(path);
  if (existing) {
    await ctx.app.vault.modify(existing, content);
  } else {
    await ctx.app.vault.create(path, content);
  }
  return { success: true, data: { path } };
}

export async function editFile(ctx: ToolContext, path: string, oldText: string, newText: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path, 'write');
  if (!perm.allowed) return { success: false, error: perm.reason };
  if (perm.requiresConfirmation) {
    const confirmed = await ctx.onConfirmRequest?.('edit_file', { path });
    if (!confirmed) return { success: false, error: 'Operation cancelled by user' };
  }

  const file = ctx.app.vault.getFileByPath(path);
  if (!file) return { success: false, error: `File not found: ${path}` };

  const content = await ctx.app.vault.read(file);
  if (!content.includes(oldText)) {
    return { success: false, error: `Could not find matching text in ${path}` };
  }

  const newContent = content.replace(oldText, newText);
  await ctx.app.vault.modify(file, newContent);
  return { success: true, data: { path } };
}

export async function listFiles(ctx: ToolContext, path?: string): Promise<ToolResult> {
  const targetPath = path || '';
  const perm = ctx.checkPermission(targetPath || '/', 'read');
  if (!perm.allowed) return { success: false, error: perm.reason };

  const folder = targetPath
    ? ctx.app.vault.getFolderByPath(targetPath)
    : ctx.app.vault.getRoot();

  if (!folder) return { success: false, error: `Folder not found: ${targetPath}` };

  const items = folder.children.map(child => ({
    name: child.name,
    path: child.path,
    type: child instanceof TFolder ? 'folder' : 'file',
  }));

  return { success: true, data: items };
}

export async function searchFiles(ctx: ToolContext, query: string, path?: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path || '/', 'read');
  if (!perm.allowed) return { success: false, error: perm.reason };

  const files = ctx.app.vault.getFiles();
  const results: { path: string; matches: string[] }[] = [];

  const searchPath = path ? path.replace(/\\/g, '/') : '';
  const targetFiles = searchPath
    ? files.filter(f => f.path.startsWith(searchPath))
    : files;

  const lowerQuery = query.toLowerCase();

  for (const file of targetFiles) {
    const content = await ctx.app.vault.cachedRead(file);
    const lines = content.split('\n');
    const matches = lines
      .map((line, i) => ({ line, i: i + 1 }))
      .filter(({ line }) => line.toLowerCase().contains(lowerQuery))
      .map(({ line, i }) => `L${i}: ${line.trim().substring(0, 100)}`);

    if (matches.length > 0) {
      results.push({ path: file.path, matches });
    }
  }

  return { success: true, data: results };
}

export async function deleteFile(ctx: ToolContext, path: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path, 'delete');
  if (!perm.allowed) return { success: false, error: perm.reason };
  if (perm.requiresConfirmation) {
    const confirmed = await ctx.onConfirmRequest?.('delete_file', { path });
    if (!confirmed) return { success: false, error: 'Operation cancelled by user' };
  }

  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (!file) return { success: false, error: `File not found: ${path}` };

  await ctx.app.vault.delete(file);
  return { success: true, data: { path } };
}

export async function createNote(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  const perm = ctx.checkPermission(path, 'write');
  if (!perm.allowed) return { success: false, error: perm.reason };
  if (perm.requiresConfirmation) {
    const confirmed = await ctx.onConfirmRequest?.('create_note', { path });
    if (!confirmed) return { success: false, error: 'Operation cancelled by user' };
  }

  const existing = ctx.app.vault.getFileByPath(path);
  if (existing) {
    return { success: false, error: `File already exists: ${path}. Use write_file to overwrite.` };
  }

  await ctx.app.vault.create(path, content);
  return { success: true, data: { path } };
}

export async function executeCommand(_ctx: ToolContext, _commandId: string): Promise<ToolResult> {
  return { success: false, error: 'execute_command is not available via the current Obsidian API' };
}
export async function loadSkill(ctx: ToolContext, name: string): Promise<ToolResult> {
  return { success: false, error: 'Skill loading is handled by AgentCore' };
}

export function getToolDefinitions(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the contents of a file from the vault.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault absolute path to the file' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create a new file or overwrite an existing file in the vault.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault absolute path for the file' },
            content: { type: 'string', description: 'Full content to write to the file' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: 'Replace specific text in an existing file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault absolute path to the file' },
            oldText: { type: 'string', description: 'The exact text to be replaced' },
            newText: { type: 'string', description: 'The replacement text' },
          },
          required: ['path', 'oldText', 'newText'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files and folders in a directory.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path (optional, defaults to vault root)' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_files',
        description: 'Full-text search across files in the vault.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            path: { type: 'string', description: 'Optional path to restrict search scope' },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Delete a file from the vault.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault absolute path to the file' },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_note',
        description: 'Create a new note in the vault. Fails if file already exists.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Vault absolute path for the new note' },
            content: { type: 'string', description: 'Markdown content of the note' },
          },
          required: ['path', 'content'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'execute_command',
        description: 'Execute an Obsidian command by its ID.',
        parameters: {
          type: 'object',
          properties: {
            commandId: { type: 'string', description: 'The command ID to execute' },
          },
          required: ['commandId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'load_skill',
        description: 'Load a skill by name to gain specialized knowledge (e.g. obsidian-markdown, json-canvas). Use when you need to know about Obsidian-specific syntax or formats.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'The skill name to load' },
          },
          required: ['name'],
        },
      },
    },
  ];
}
