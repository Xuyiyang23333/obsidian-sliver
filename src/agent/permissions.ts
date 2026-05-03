import { PathRule, GlobalPermission } from '../settings';

export interface PermissionResult {
  allowed: boolean;
  reason?: string;
  requiresConfirmation: boolean;
}

export function checkFilePermission(
  filePath: string,
  operation: 'read' | 'write' | 'delete',
  pathRules: PathRule[],
  globalPermission: GlobalPermission
): PermissionResult {
  // Check path-specific rules first (most specific path wins)
  const sortedRules = [...pathRules]
    .filter(r => r.path.length > 0)
    .sort((a, b) => b.path.length - a.path.length);

  const normalizedPath = filePath.replace(/\\/g, '/');

  for (const rule of sortedRules) {
    const rulePath = rule.path.replace(/\\/g, '/').replace(/\/+$/, '');
    const matched = normalizedPath.startsWith(rulePath) &&
      (normalizedPath.length === rulePath.length || normalizedPath[rulePath.length] === '/');
    if (matched) {
      switch (rule.permission) {
        case 'denied':
          return { allowed: false, reason: `Access denied to path: ${rulePath}`, requiresConfirmation: false };
        case 'read-only':
          if (operation === 'read') {
            return { allowed: true, requiresConfirmation: false };
          }
          return { allowed: false, reason: `Read-only path: ${rulePath}`, requiresConfirmation: false };
        case 'read-write':
          return { allowed: true, requiresConfirmation: false };
        case 'follow-global':
          break;
      }
      break;
    }
  }

  // Fall back to global permission
  switch (globalPermission) {
    case 'read-only':
      if (operation === 'read') {
        return { allowed: true, requiresConfirmation: false };
      }
      return { allowed: false, reason: 'Global mode is read-only', requiresConfirmation: false };
    case 'ask-per-write':
      if (operation === 'read') {
        return { allowed: true, requiresConfirmation: false };
      }
      return { allowed: true, requiresConfirmation: true };
    case 'full-access':
      return { allowed: true, requiresConfirmation: false };
  }
}
