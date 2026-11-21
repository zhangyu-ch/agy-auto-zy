import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve } from 'node:path';
import { MODE_AUTO_WORKSPACE_ZY, MODE_AUTO_ZY, MODE_OFF } from './constants.mjs';

export const DELEGATION_EXCLUDED_SURFACES = new Set(['external_directory', 'path']);

const PURE_HARNESS_TOOLS = new Set([
  'ask_question',
  'ask_user_question',
  'plan_mode_question',
  'task_boundary',
  'notify_user',
  'manage_todo_list',
  'search_marketplace',
  'list_plugin_accounts',
  'manage_task',
  'manage_subagents',
  'send_message'
]);

const READ_FILE_TOOLS = new Set([
  'read_file',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'grep_search',
  'ripgrep_search',
  'codebase_search',
  'find_by_name',
  'list_dir',
  'read_url_content',
  'search_web'
]);

const WRITE_FILE_TOOLS = new Set([
  'write_file',
  'write_to_file',
  'create_file',
  'edit_file',
  'replace_file_content',
  'multi_replace_file_content',
  'delete_file'
]);

const SHELL_TOOLS = new Set(['run_command', 'bash', 'sh', 'exec_command', 'shell']);

const SAFE_ENV_TEMPLATE_SUFFIXES = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
  '.env.schema'
];

const SHELL_WRITE_VERBS = new Set([
  'rm',
  'del',
  'erase',
  'rmdir',
  'rd',
  'mv',
  'move',
  'cp',
  'copy',
  'mkdir',
  'md',
  'touch',
  'tee',
  'chmod',
  'chown',
  'icacls',
  'remove-item',
  'ri',
  'set-content',
  'sc',
  'add-content',
  'ac',
  'out-file',
  'clear-content',
  'clc',
  'new-item',
  'ni',
  'move-item',
  'mi',
  'copy-item',
  'cpi',
  'rename-item',
  'rni'
]);

const INDIRECTION_WRAPPERS = new Set([
  'eval',
  'exec',
  'sudo',
  'su',
  'runas',
  'xargs',
  'invoke-expression',
  'iex',
  'start-process',
  'saps'
]);

export function surfaceFamilyOf(surface) {
  if (typeof surface !== 'string' || !surface) return '';
  if (surface === 'external_directory' || surface.startsWith('external_directory_')) {
    return 'external_directory';
  }
  if (surface === 'path' || surface.startsWith('path_')) {
    return 'path';
  }
  return surface;
}

function normalizeForComparison(targetPath, platform = process.platform) {
  const resolved = resolve(targetPath).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function tryResolveRealPath(targetPath) {
  try {
    if (existsSync(targetPath)) {
      return realpathSync(targetPath);
    }
    const parentDir = dirname(targetPath);
    if (parentDir && parentDir !== targetPath && existsSync(parentDir)) {
      return join(realpathSync(parentDir), targetPath.slice(parentDir.length));
    }
  } catch {
    // Fall back to lexical resolution when filesystem lookup is unavailable.
  }
  return resolve(targetPath);
}

export function isPathInsideDirectory(candidatePath, rootDir, platform = process.platform) {
  if (!candidatePath || !rootDir) return false;
  const normCandidate = normalizeForComparison(candidatePath, platform);
  const normRoot = normalizeForComparison(rootDir, platform);
  if (normCandidate === normRoot) return true;
  if (normCandidate.startsWith(`${normRoot}/`)) return true;

  const realCandidate = normalizeForComparison(tryResolveRealPath(candidatePath), platform);
  const realRoot = normalizeForComparison(tryResolveRealPath(rootDir), platform);
  return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}/`);
}

export function isHardProtectedHostFile(candidatePath, { home = homedir() } = {}) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return false;
  const agyConfigJson = join(home, '.gemini', 'config', 'config.json');
  const normTarget = normalizeForComparison(candidatePath);
  const normReal = normalizeForComparison(tryResolveRealPath(candidatePath));
  const normProtected = normalizeForComparison(agyConfigJson);
  return normTarget === normProtected || normReal === normProtected;
}

export function matchSensitivePathRule(
  candidatePath,
  { direction = 'read', home = homedir() } = {}
) {
  if (typeof candidatePath !== 'string' || !candidatePath.trim()) return null;

  const spellings = [
    resolve(candidatePath).replace(/\\/g, '/'),
    tryResolveRealPath(candidatePath).replace(/\\/g, '/')
  ];
  const homePosix = resolve(home).replace(/\\/g, '/').replace(/\/+$/, '');

  for (const rawSpelling of spellings) {
    const lower = rawSpelling.toLowerCase();
    const baseName = lower.split('/').pop() || '';
    const lowerHome = homePosix.toLowerCase();

    if (lower === `${lowerHome}/.gemini/config/config.json`) {
      return '~/.gemini/config/config.json';
    }

    if (
      (baseName === '.env' || baseName.startsWith('.env.')) &&
      !SAFE_ENV_TEMPLATE_SUFFIXES.some(suffix => baseName === suffix || baseName.endsWith(suffix))
    ) {
      return '*.env*';
    }

    if (
      lower.startsWith(`${lowerHome}/.ssh/`) ||
      lower === `${lowerHome}/.ssh` ||
      lower.includes('/.ssh/') ||
      /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(baseName) ||
      /\.(pem|key|pfx|p12|kdbx)$/.test(baseName)
    ) {
      return 'ssh/private-key';
    }

    if (
      lower.startsWith(`${lowerHome}/.aws/`) ||
      lower.startsWith(`${lowerHome}/.kube/`) ||
      lower === `${lowerHome}/.npmrc` ||
      lower === `${lowerHome}/.pypirc` ||
      lower === `${lowerHome}/.git-credentials` ||
      lower === `${lowerHome}/.netrc` ||
      lower === `${lowerHome}/.docker/config.json` ||
      /(?:^|\/)(?:client_secret|service[-_]?account|credentials)[^/]*\.json$/.test(lower)
    ) {
      return 'credential-store';
    }

    if (
      direction === 'write' &&
      (lower.includes('/.git/hooks/') ||
        lower.endsWith('/.git/hooks') ||
        lower.endsWith('/.git/config'))
    ) {
      return '.git/hooks-or-config';
    }
  }

  return null;
}

function expandShellHomeAndEnv(rawToken, { home = homedir(), env = process.env } = {}) {
  if (typeof rawToken !== 'string') return '';
  let token = rawToken.trim();
  if (token === '~') return home;
  if (token.startsWith('~/') || token.startsWith('~\\')) {
    return join(home, token.slice(2));
  }
  token = token
    .replace(/^\$(?:env:USERPROFILE|env:HOME|HOME|USERPROFILE)(?=[/\\]|$)/i, home)
    .replace(/^\$\{(?:HOME|USERPROFILE)\}(?=[/\\]|$)/i, home)
    .replace(/^%USERPROFILE%(?=[/\\]|$)/i, home)
    .replace(
      /^%APPDATA%(?=[/\\]|$)/i,
      env.APPDATA || join(home, 'AppData', 'Roaming')
    )
    .replace(
      /^%LOCALAPPDATA%(?=[/\\]|$)/i,
      env.LOCALAPPDATA || join(home, 'AppData', 'Local')
    );
  return token;
}

export function tokenizeCommand(commandText) {
  if (typeof commandText !== 'string' || !commandText.trim()) {
    return { tokens: [], unclosedQuote: false };
  }
  const tokens = [];
  let current = '';
  let quote = null;
  let hadQuote = false;

  const pushCurrent = () => {
    if (current.length > 0 || hadQuote) {
      tokens.push({ value: current, quoted: hadQuote });
      current = '';
      hadQuote = false;
    }
  };

  for (let i = 0; i < commandText.length; i += 1) {
    const ch = commandText[i];
    if (quote) {
      if (ch === quote) {
        if (quote === '"' && commandText[i - 1] === '\\') {
          current = `${current.slice(0, -1)}"`;
        } else {
          quote = null;
        }
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      hadQuote = true;
      continue;
    }

    if (/\s/.test(ch)) {
      pushCurrent();
      continue;
    }

    if (['|', ';', '&', '>', '<'].includes(ch)) {
      pushCurrent();
      let op = ch;
      if (commandText[i + 1] === ch && ['|', '&', '>'].includes(ch)) {
        op += commandText[i + 1];
        i += 1;
      }
      tokens.push({ value: op, operator: true });
      continue;
    }

    current += ch;
  }

  pushCurrent();
  return { tokens, unclosedQuote: quote !== null };
}

function looksLikePathCandidate(rawValue) {
  if (!rawValue || rawValue.startsWith('-')) return false;
  if (/^https?:\/\//i.test(rawValue)) return false;
  if (/^[A-Za-z]:[/\\]/.test(rawValue)) return true;
  if (rawValue.startsWith('/') || rawValue.startsWith('~/') || rawValue.startsWith('~\\')) return true;
  if (rawValue.startsWith('./') || rawValue.startsWith('../') || rawValue.startsWith('.\\') || rawValue.startsWith('..\\')) {
    return true;
  }
  if (/^\$(?:env:USERPROFILE|env:HOME|HOME|USERPROFILE)[/\\]/i.test(rawValue)) return true;
  if (/^%(?:USERPROFILE|APPDATA|LOCALAPPDATA)%[/\\]/i.test(rawValue)) return true;
  return false;
}

function qualifiesForNothingOnDiskItem(rawToken, resolvedPath) {
  if (!rawToken || typeof rawToken !== 'string') return false;
  if (!rawToken.startsWith('/') && !/^[A-Za-z]:[/\\]/.test(rawToken)) return false;
  if (/[\*\?\[\]\{\}\$`]/.test(rawToken)) return false;
  const segments = rawToken.split(/[/\\]+/).filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some(seg => seg === '.' || seg === '..')) return false;

  const parsed = parse(resolvedPath);
  if (normalize(resolvedPath) === normalize(parsed.root)) return false;
  if (existsSync(resolvedPath)) return false;

  const firstBelowRoot = join(parsed.root, segments[0]);
  if (rawToken.startsWith('/') && !existsSync(firstBelowRoot)) {
    return true;
  }
  return false;
}

export function analyzeShellCommand(
  commandLine,
  { cwd = process.cwd(), workspaceRoots = [], home = homedir(), env = process.env } = {}
) {
  const { tokens, unclosedQuote } = tokenizeCommand(commandLine);
  let activeCwd = cwd || workspaceRoots[0] || process.cwd();
  let hasWriteIntent = false;
  let hasIndirection = unclosedQuote || /\$\(|`/.test(commandLine || '');
  const referencedPaths = [];
  let expectRedirectTarget = false;
  let atCommandStart = true;
  let currentVerb = '';

  for (let idx = 0; idx < tokens.length; idx += 1) {
    const token = tokens[idx];
    if (token.operator) {
      if (token.value === '>' || token.value === '>>') {
        hasWriteIntent = true;
        expectRedirectTarget = true;
      } else if (['|', '||', '&&', ';', '&'].includes(token.value)) {
        atCommandStart = true;
        currentVerb = '';
        expectRedirectTarget = false;
      }
      continue;
    }

    const raw = token.value;
    if (atCommandStart && /^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) {
      continue;
    }

    if (atCommandStart) {
      atCommandStart = false;
      currentVerb = (raw.split(/[/\\]/).pop() || raw).toLowerCase().replace(/\.exe$|\.cmd$|\.ps1$/, '');
      if (SHELL_WRITE_VERBS.has(currentVerb)) {
        hasWriteIntent = true;
      }
      if (INDIRECTION_WRAPPERS.has(currentVerb)) {
        hasIndirection = true;
      }
      if (
        ['bash', 'sh', 'zsh', 'cmd', 'powershell', 'pwsh'].includes(currentVerb) &&
        tokens.slice(idx + 1, idx + 4).some(t => !t.operator && /^(-c|-command|\/c|-enc|-encodedcommand)$/i.test(t.value))
      ) {
        hasIndirection = true;
      }
      if (['cd', 'set-location', 'sl', 'push-location', 'pushd'].includes(currentVerb)) {
        const nextToken = tokens[idx + 1];
        if (nextToken && !nextToken.operator && !/[\*\?\$`]/.test(nextToken.value) && nextToken.value !== '-') {
          const expanded = expandShellHomeAndEnv(nextToken.value, { home, env });
          activeCwd = isAbsolute(expanded) ? resolve(expanded) : resolve(activeCwd, expanded);
          referencedPaths.push({
            raw: nextToken.value,
            resolved: activeCwd,
            direction: 'read',
            quoted: Boolean(nextToken.quoted)
          });
          idx += 1;
        }
      }
      continue;
    }

    const strippedRaw = raw.startsWith('@')
      ? raw.slice(1)
      : /^--?[A-Za-z0-9_-]+=/.test(raw)
        ? raw.slice(raw.indexOf('=') + 1)
        : raw;
    const expanded = expandShellHomeAndEnv(strippedRaw, { home, env });
    if (
      expectRedirectTarget ||
      looksLikePathCandidate(strippedRaw) ||
      looksLikePathCandidate(expanded) ||
      (strippedRaw !== raw && (strippedRaw.endsWith('.env') || strippedRaw.includes('.env.')))
    ) {
      const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(activeCwd, expanded);
      const direction = expectRedirectTarget || SHELL_WRITE_VERBS.has(currentVerb) ? 'write' : 'read';
      referencedPaths.push({
        raw: strippedRaw,
        resolved,
        direction,
        quoted: Boolean(token.quoted)
      });
      expectRedirectTarget = false;
      continue;
    }

    if (SHELL_WRITE_VERBS.has(currentVerb) && !raw.startsWith('-') && !/^[0-9]+$/.test(raw)) {
      const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(activeCwd, expanded);
      referencedPaths.push({
        raw,
        resolved,
        direction: 'write',
        quoted: Boolean(token.quoted)
      });
    }
  }

  return {
    unclosedQuote,
    hasWriteIntent,
    hasIndirection,
    referencedPaths
  };
}

function extractFileToolPaths(toolName, args = {}, baseCwd) {
  const candidates = [];
  const keys = [
    'Path',
    'path',
    'TargetFile',
    'targetFile',
    'AbsolutePath',
    'absolutePath',
    'File',
    'file',
    'SearchPath',
    'searchPath',
    'DirectoryPath',
    'directoryPath',
    'TargetDirectory',
    'targetDirectory',
    'SearchDirectory',
    'searchDirectory'
  ];

  for (const key of keys) {
    const val = args?.[key];
    if (typeof val === 'string' && val.trim()) {
      const expanded = expandShellHomeAndEnv(val.trim());
      candidates.push(isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded));
    } else if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string' && item.trim()) {
          const expanded = expandShellHomeAndEnv(item.trim());
          candidates.push(isAbsolute(expanded) ? resolve(expanded) : resolve(baseCwd, expanded));
        }
      }
    }
  }

  return [...new Set(candidates)];
}

function buildHarnessReadRoots(home) {
  return [
    join(home, '.gemini', 'antigravity', 'builtin', 'skills'),
    join(home, '.gemini', 'config', 'skills'),
    join(home, '.gemini', 'config', 'plugins')
  ];
}

function isAllowedInWorkspaceOrArtifact(
  targetPath,
  { direction, workspaceRoots, artifactDirectoryPath, harnessReadRoots }
) {
  if (workspaceRoots.some(root => isPathInsideDirectory(targetPath, root))) {
    return true;
  }
  if (artifactDirectoryPath && isPathInsideDirectory(targetPath, artifactDirectoryPath)) {
    const logsSubdir = join(artifactDirectoryPath, '.system_generated', 'logs');
    if (direction === 'write' && isPathInsideDirectory(targetPath, logsSubdir)) {
      return false;
    }
    return true;
  }
  if (direction === 'read' && harnessReadRoots.some(root => isPathInsideDirectory(targetPath, root))) {
    return true;
  }
  return false;
}

export function classifyToolCall(payload = {}, settings = {}, { home = homedir(), env = process.env } = {}) {
  const toolCall = payload?.toolCall || {};
  const rawName = typeof toolCall.name === 'string' ? toolCall.name.trim() : 'unknown';
  const toolName = rawName.toLowerCase();
  const args = toolCall.args && typeof toolCall.args === 'object' ? toolCall.args : {};

  const rawWorkspacePaths = Array.isArray(payload.workspacePaths) ? payload.workspacePaths.filter(Boolean) : [];
  const cwd = typeof payload.cwd === 'string' && payload.cwd.trim()
    ? resolve(payload.cwd.trim())
    : rawWorkspacePaths[0]
      ? resolve(rawWorkspacePaths[0])
      : process.cwd();
  const workspaceRoots =
    rawWorkspacePaths.length > 0 ? rawWorkspacePaths.map(p => resolve(p)) : [cwd];
  const artifactDirectoryPath =
    typeof payload.artifactDirectoryPath === 'string' && payload.artifactDirectoryPath.trim()
      ? resolve(payload.artifactDirectoryPath.trim())
      : null;
  const harnessReadRoots = buildHarnessReadRoots(home);

  if (PURE_HARNESS_TOOLS.has(toolName)) {
    return {
      fastDecision: 'allow',
      decidedBy: 'fast-path',
      surface: 'harness',
      details: null
    };
  }

  if (toolName === 'search_web' || toolName === 'read_url_content') {
    return {
      fastDecision: 'allow',
      decidedBy: 'fast-path',
      surface: 'web_read',
      details: null
    };
  }

  if (READ_FILE_TOOLS.has(toolName) || WRITE_FILE_TOOLS.has(toolName)) {
    const direction = WRITE_FILE_TOOLS.has(toolName) ? 'write' : 'read';
    const targetPaths = extractFileToolPaths(toolName, args, cwd);

    for (const targetPath of targetPaths) {
      if (direction === 'write' && isHardProtectedHostFile(targetPath, { home })) {
        return {
          fastDecision: 'deny',
          decidedBy: 'hard-gate',
          reason: 'Modifying ~/.gemini/config/config.json is prohibited to protect host settings and permissions.',
          surface: 'path_write',
          details: null
        };
      }
    }

    const matchedSensitive = targetPaths
      .map(p => ({ path: p, rule: matchSensitivePathRule(p, { direction, home }) }))
      .find(item => item.rule !== null);

    const externalPaths = targetPaths.filter(
      p =>
        !isAllowedInWorkspaceOrArtifact(p, {
          direction,
          workspaceRoots,
          artifactDirectoryPath,
          harnessReadRoots
        })
    );

    if (!matchedSensitive && externalPaths.length === 0) {
      if (direction === 'read' || !settings.reviewWorkspaceWrites) {
        return {
          fastDecision: 'allow',
          decidedBy: 'fast-path',
          surface: direction === 'read' ? 'workspace_read' : 'workspace_write',
          details: null
        };
      }
    }

    const surface = matchedSensitive
      ? `path_${direction}`
      : externalPaths.length > 0
        ? `external_directory_${direction}`
        : toolName;

    return {
      fastDecision: null,
      surface,
      details: {
        requestId: `perm-${toolCall.id || Date.now()}`,
        source: 'tool_call',
        toolCallId: toolCall.id || undefined,
        toolName: rawName,
        surface,
        path: matchedSensitive?.path || externalPaths[0] || targetPaths[0] || cwd,
        accessIntent: {
          surface,
          direction,
          matchedSensitiveRule: matchedSensitive?.rule || undefined,
          externalPaths: externalPaths.length > 0 ? externalPaths : undefined
        }
      },
      toolInput: args
    };
  }

  if (SHELL_TOOLS.has(toolName)) {
    const commandLine = String(
      args.CommandLine ?? args.command ?? args.cmd ?? ''
    );
    const commandCwd =
      typeof (args.Cwd ?? args.cwd ?? args.workdir) === 'string' &&
      (args.Cwd ?? args.cwd ?? args.workdir).trim()
        ? resolve((args.Cwd ?? args.cwd ?? args.workdir).trim())
        : cwd;

    const analysis = analyzeShellCommand(commandLine, {
      cwd: commandCwd,
      workspaceRoots,
      home,
      env
    });

    for (const ref of analysis.referencedPaths) {
      if (ref.direction === 'write' && isHardProtectedHostFile(ref.resolved, { home })) {
        return {
          fastDecision: 'deny',
          decidedBy: 'hard-gate',
          reason: 'Modifying ~/.gemini/config/config.json via shell command is prohibited.',
          surface: 'path_write',
          details: null
        };
      }
    }

    const sensitiveHit = analysis.referencedPaths
      .map(ref => ({
        ...ref,
        rule: matchSensitivePathRule(ref.resolved, { direction: ref.direction, home })
      }))
      .find(item => item.rule !== null);

    const cwdIsExternal = !isAllowedInWorkspaceOrArtifact(commandCwd, {
      direction: analysis.hasWriteIntent ? 'write' : 'read',
      workspaceRoots,
      artifactDirectoryPath,
      harnessReadRoots
    });

    const externalRefs = analysis.referencedPaths.filter(
      ref =>
        !isAllowedInWorkspaceOrArtifact(ref.resolved, {
          direction: ref.direction,
          workspaceRoots,
          artifactDirectoryPath,
          harnessReadRoots
        })
    );

    let surface = 'bash';
    let delegationLicense = undefined;

    if (sensitiveHit) {
      surface = `path_${sensitiveHit.direction}`;
    } else if (cwdIsExternal || externalRefs.length > 0) {
      const anyWrite = cwdIsExternal ? analysis.hasWriteIntent : externalRefs.some(r => r.direction === 'write');
      surface = anyWrite ? 'external_directory_write' : 'external_directory_read';

      if (
        !cwdIsExternal &&
        !anyWrite &&
        !analysis.hasIndirection &&
        !analysis.unclosedQuote &&
        externalRefs.length > 0 &&
        externalRefs.every(ref => !ref.quoted && qualifiesForNothingOnDiskItem(ref.raw, ref.resolved))
      ) {
        delegationLicense = 'nothing-on-disk';
      }
    }

    return {
      fastDecision: null,
      surface,
      details: {
        requestId: `perm-${toolCall.id || Date.now()}`,
        source: 'tool_call',
        toolCallId: toolCall.id || undefined,
        toolName: rawName,
        surface,
        command: commandLine,
        path: sensitiveHit?.resolved || externalRefs[0]?.resolved || (cwdIsExternal ? commandCwd : undefined),
        accessIntent: {
          surface,
          cwd: commandCwd,
          hasWriteIntent: analysis.hasWriteIntent,
          hasIndirection: analysis.hasIndirection,
          ...(sensitiveHit ? { matchedSensitiveRule: sensitiveHit.rule } : {}),
          ...(externalRefs.length > 0 ? { externalPaths: externalRefs.map(r => r.resolved) } : {}),
          ...(delegationLicense ? { delegationLicense } : {})
        }
      },
      toolInput: args
    };
  }

  const isMcp = toolName.startsWith('mcp_') || toolName.includes(':') || toolName === 'mcp';
  const surface = isMcp ? 'mcp' : 'tool';

  return {
    fastDecision: null,
    surface,
    details: {
      requestId: `perm-${toolCall.id || Date.now()}`,
      source: 'tool_call',
      toolCallId: toolCall.id || undefined,
      toolName: rawName,
      surface,
      accessIntent: {
        surface
      }
    },
    toolInput: args
  };
}

export function encloseInDelegationEnvelope(mode, details, reviewerVerdict) {
  assert.ok(reviewerVerdict && typeof reviewerVerdict === 'object', 'reviewerVerdict is required');
  if (mode === MODE_OFF) {
    return { kind: 'passthrough' };
  }
  if (mode === MODE_AUTO_ZY) {
    return reviewerVerdict;
  }
  assert.equal(mode, MODE_AUTO_WORKSPACE_ZY, `Unexpected mode: ${mode}`);

  if (reviewerVerdict.kind !== 'allow') {
    return reviewerVerdict;
  }

  const surface = details?.accessIntent?.surface ?? details?.surface;
  const family = surfaceFamilyOf(surface);
  const isExcluded = !surface || DELEGATION_EXCLUDED_SURFACES.has(family);
  if (!isExcluded) {
    return reviewerVerdict;
  }

  if (
    family === 'external_directory' &&
    details?.accessIntent?.delegationLicense === 'nothing-on-disk'
  ) {
    return {
      ...reviewerVerdict,
      licensedBy: 'nothing-on-disk'
    };
  }

  return {
    kind: 'defer',
    cappedFromAllow: true,
    cappedSurface: surface || 'unknown',
    reason: `[auto-workspace-zy] 跨工作区或敏感路径访问（${surface || 'boundary'}）需人工确认。`,
    fields: reviewerVerdict.fields
  };
}
