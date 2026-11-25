import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import {
  CLI_HOOK_ALLOW_DECISION,
  DEFAULT_FOLLOW_UP_REVIEW_MODE,
  DEFAULT_MAGPIE_API_KEY,
  DEFAULT_MAGPIE_BASE_URL,
  DEFAULT_MAGPIE_PROVIDER,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL_CONTEXT_WINDOW,
  DEFAULT_REVIEW_MODE,
  DEFAULT_REVIEW_TIMEOUT_MS,
  DEFAULT_REVIEWER_MODEL,
  DEFAULT_REVIEWER_REASONING,
  DEFAULTS_ENTRY,
  FOLLOW_UP_REVIEW_MODES,
  HOOK_ALLOW_DECISION,
  MAX_CONFIGURABLE_RETRIES,
  MAX_REVIEW_TIMEOUT_MS,
  PLUGIN_ID,
  REASONING_LEVELS,
  REVIEW_MODES,
  RULE_LIST_NAMES
} from './constants.mjs';

const ANTIGRAVITY_CLI_SEGMENT_REGEX = /(?:^|[\\/])antigravity-cli(?:[\\/]|$)/i;

export function resolvePluginDataDirectory({ home = homedir(), env = process.env } = {}) {
  if (env.PLUGIN_DATA && env.PLUGIN_DATA.trim()) {
    return resolve(env.PLUGIN_DATA.trim());
  }
  const appDataDir = env.ANTIGRAVITY_APP_DATA_DIR || join(home, '.gemini', 'antigravity');
  return join(appDataDir, 'plugin_data', PLUGIN_ID);
}

export function isAntigravityCliHost(
  payload = {},
  { env = process.env, dataDirectory } = {}
) {
  const hasExplicitDataDir = typeof dataDirectory === 'string' && dataDirectory.trim().length > 0;
  const candidates = [
    ...(hasExplicitDataDir ? [dataDirectory] : [env?.PLUGIN_DATA, env?.ANTIGRAVITY_APP_DATA_DIR]),
    payload?.transcriptPath,
    payload?.artifactDirectoryPath
  ];
  return candidates.some(
    candidate =>
      typeof candidate === 'string' && ANTIGRAVITY_CLI_SEGMENT_REGEX.test(candidate.trim())
  );
}

export function resolveHookAllowDecision(
  payload = {},
  { env = process.env, dataDirectory } = {}
) {
  return isAntigravityCliHost(payload, { env, dataDirectory })
    ? CLI_HOOK_ALLOW_DECISION
    : HOOK_ALLOW_DECISION;
}

export function resolveAntigravityUserDataDirectory({
  platform = process.platform,
  env = process.env,
  home = homedir()
} = {}) {
  if (env.ANTIGRAVITY_USER_DATA_DIR) return env.ANTIGRAVITY_USER_DATA_DIR;
  const pathImpl = platform === 'win32' ? win32 : posix;
  if (platform === 'win32') {
    return pathImpl.join(env.APPDATA || pathImpl.join(home, 'AppData', 'Roaming'), 'Antigravity');
  }
  if (platform === 'darwin') {
    return pathImpl.join(home, 'Library', 'Application Support', 'Antigravity');
  }
  return pathImpl.join(env.XDG_CONFIG_HOME || pathImpl.join(home, '.config'), 'Antigravity');
}

export function resolveDevToolsActivePortFile(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const pathImpl = platform === 'win32' ? win32 : posix;
  return (
    options.portFile ||
    env.ANTIGRAVITY_CDP_PORT_FILE ||
    env.AGY_BROWSER_ACTIVE_PORT_FILE ||
    pathImpl.join(resolveAntigravityUserDataDirectory(options), 'DevToolsActivePort')
  );
}

export function normalizeBaseUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return DEFAULT_MAGPIE_BASE_URL;
  }
  let cleaned = rawUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(cleaned)) {
    cleaned = `http://${cleaned}`;
  }
  if (!/\/v\d+$/i.test(cleaned)) {
    cleaned = `${cleaned}/v1`;
  }
  return cleaned;
}

export function normalizeModelId(rawModelSpec) {
  if (typeof rawModelSpec !== 'string' || !rawModelSpec.trim()) {
    return DEFAULT_REVIEWER_MODEL;
  }
  const trimmed = rawModelSpec.trim();
  if (trimmed.toLowerCase().startsWith('magpie/')) {
    const stripped = trimmed.slice('magpie/'.length).trim();
    return stripped || DEFAULT_REVIEWER_MODEL;
  }
  return trimmed;
}

export function normalizeWorkspaceKey(workspacePath, platform = process.platform) {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) return '';
  const cleaned = workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? cleaned.toLowerCase() : cleaned;
}

export function discoverLocalMagpieDefaults({ home = homedir() } = {}) {
  let baseUrl = DEFAULT_MAGPIE_BASE_URL;
  let apiKey = DEFAULT_MAGPIE_API_KEY;
  let model = DEFAULT_REVIEWER_MODEL;
  let reasoning = DEFAULT_REVIEWER_REASONING;
  let contextWindow = DEFAULT_MODEL_CONTEXT_WINDOW;

  const piModelsPath = join(home, '.pi', 'agent', 'models.json');
  if (existsSync(piModelsPath)) {
    try {
      const parsedModels = JSON.parse(readFileSync(piModelsPath, 'utf8'));
      const magpieProvider = parsedModels?.providers?.magpie;
      if (typeof magpieProvider?.baseUrl === 'string' && magpieProvider.baseUrl.trim()) {
        baseUrl = normalizeBaseUrl(magpieProvider.baseUrl);
      }
      if (typeof magpieProvider?.apiKey === 'string' && magpieProvider.apiKey.trim()) {
        apiKey = magpieProvider.apiKey.trim();
      }
      if (Array.isArray(magpieProvider?.models)) {
        const dsFlash = magpieProvider.models.find(item => item?.id === DEFAULT_REVIEWER_MODEL);
        if (Number.isInteger(dsFlash?.contextWindow) && dsFlash.contextWindow > 0) {
          contextWindow = dsFlash.contextWindow;
        }
      }
    } catch {
      // Fall back to safe defaults if external models.json cannot be parsed.
    }
  }

  const magpieGatewayPath = join(home, '.config', 'magpie', 'gateway.json');
  if (existsSync(magpieGatewayPath)) {
    try {
      const gatewayInfo = JSON.parse(readFileSync(magpieGatewayPath, 'utf8'));
      if (typeof gatewayInfo?.addr === 'string' && gatewayInfo.addr.trim()) {
        baseUrl = normalizeBaseUrl(gatewayInfo.addr);
      }
    } catch {
      // Ignore malformed gateway metadata.
    }
  }

  const piAutoReviewConfigPath = join(
    home,
    '.pi',
    'agent',
    'extensions',
    'pi-permission-auto-review',
    'config.json'
  );
  if (existsSync(piAutoReviewConfigPath)) {
    try {
      const piReviewCfg = JSON.parse(readFileSync(piAutoReviewConfigPath, 'utf8'));
      if (
        piReviewCfg?.provider === DEFAULT_MAGPIE_PROVIDER &&
        typeof piReviewCfg?.model === 'string' &&
        piReviewCfg.model.trim()
      ) {
        model = normalizeModelId(piReviewCfg.model);
      }
      if (typeof piReviewCfg?.reasoning === 'string' && REASONING_LEVELS.includes(piReviewCfg.reasoning)) {
        reasoning = piReviewCfg.reasoning;
      }
    } catch {
      // Ignore malformed external config.
    }
  }

  return {
    provider: DEFAULT_MAGPIE_PROVIDER,
    baseUrl,
    apiKey,
    model,
    reasoning,
    contextWindow
  };
}

export function writeJsonAtomically(filePath, dataObject) {
  assert.equal(typeof filePath, 'string', 'filePath must be a string');
  mkdirSync(dirname(filePath), { recursive: true });
  const tempFilePath = join(dirname(filePath), `.tmp-${randomUUID()}.json`);
  try {
    writeFileSync(tempFilePath, `${JSON.stringify(dataObject, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    renameSync(tempFilePath, filePath);
  } finally {
    if (existsSync(tempFilePath)) {
      try {
        unlinkSync(tempFilePath);
      } catch {
        // Best-effort temporary file cleanup.
      }
    }
  }
}

function sanitizeRuleList(rawList) {
  if (!Array.isArray(rawList)) {
    return [DEFAULTS_ENTRY];
  }
  const normalized = rawList
    .filter(item => typeof item === 'string')
    .map(item => item.trim())
    .filter(item => item.length > 0);
  return normalized;
}

function sanitizeAutoMode(rawAutoMode = {}, fallbackAutoMode = {}) {
  const result = {};
  for (const listName of RULE_LIST_NAMES) {
    if (Array.isArray(rawAutoMode?.[listName])) {
      result[listName] = sanitizeRuleList(rawAutoMode[listName]);
    } else if (Array.isArray(fallbackAutoMode?.[listName])) {
      result[listName] = sanitizeRuleList(fallbackAutoMode[listName]);
    } else {
      result[listName] = [DEFAULTS_ENTRY];
    }
  }
  return result;
}

function sanitizeWorkspaceModes(rawMap = {}) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) {
    return {};
  }
  const cleaned = {};
  for (const [rawKey, rawMode] of Object.entries(rawMap)) {
    const key = normalizeWorkspaceKey(rawKey);
    if (key && REVIEW_MODES.includes(rawMode)) {
      cleaned[key] = rawMode;
    }
  }
  return cleaned;
}

function clampBoundedInt(rawValue, minValue, maxValue, fallbackValue) {
  if (!Number.isSafeInteger(rawValue)) return fallbackValue;
  if (rawValue < minValue || rawValue > maxValue) return fallbackValue;
  return rawValue;
}

export function sanitizeSettings(rawSettings = {}, defaults = null) {
  const baseDefaults = defaults || {
    mode: DEFAULT_REVIEW_MODE,
    workspaceModes: {},
    provider: DEFAULT_MAGPIE_PROVIDER,
    baseUrl: DEFAULT_MAGPIE_BASE_URL,
    apiKey: DEFAULT_MAGPIE_API_KEY,
    model: DEFAULT_REVIEWER_MODEL,
    reasoning: DEFAULT_REVIEWER_REASONING,
    contextWindow: DEFAULT_MODEL_CONTEXT_WINDOW,
    timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
    attemptTimeoutMs: null,
    maxRetries: DEFAULT_MAX_RETRIES,
    followUpReviews: DEFAULT_FOLLOW_UP_REVIEW_MODE,
    reviewWorkspaceWrites: false,
    showComposerButton: true,
    permissionReviewLog: true,
    autoMode: {
      environment: [DEFAULTS_ENTRY],
      allow: [DEFAULTS_ENTRY],
      soft_deny: [DEFAULTS_ENTRY],
      hard_deny: [DEFAULTS_ENTRY]
    }
  };

  const attemptTimeoutMs = Number.isSafeInteger(rawSettings.attemptTimeoutMs)
    ? clampBoundedInt(rawSettings.attemptTimeoutMs, 1_000, MAX_REVIEW_TIMEOUT_MS, null)
    : baseDefaults.attemptTimeoutMs;

  return {
    mode: REVIEW_MODES.includes(rawSettings.mode) ? rawSettings.mode : baseDefaults.mode,
    workspaceModes:
      rawSettings.workspaceModes !== undefined
        ? sanitizeWorkspaceModes(rawSettings.workspaceModes)
        : sanitizeWorkspaceModes(baseDefaults.workspaceModes),
    provider:
      typeof rawSettings.provider === 'string' && rawSettings.provider.trim()
        ? rawSettings.provider.trim()
        : baseDefaults.provider,
    baseUrl:
      typeof rawSettings.baseUrl === 'string' && rawSettings.baseUrl.trim()
        ? normalizeBaseUrl(rawSettings.baseUrl)
        : baseDefaults.baseUrl,
    apiKey:
      typeof rawSettings.apiKey === 'string' && rawSettings.apiKey.trim()
        ? rawSettings.apiKey.trim()
        : baseDefaults.apiKey,
    model:
      typeof rawSettings.model === 'string' && rawSettings.model.trim()
        ? normalizeModelId(rawSettings.model)
        : baseDefaults.model,
    reasoning: REASONING_LEVELS.includes(rawSettings.reasoning)
      ? rawSettings.reasoning
      : baseDefaults.reasoning,
    contextWindow: clampBoundedInt(
      rawSettings.contextWindow,
      16_385,
      2_000_000,
      baseDefaults.contextWindow
    ),
    timeoutMs: clampBoundedInt(
      rawSettings.timeoutMs,
      1_000,
      MAX_REVIEW_TIMEOUT_MS,
      baseDefaults.timeoutMs
    ),
    attemptTimeoutMs,
    maxRetries: clampBoundedInt(
      rawSettings.maxRetries,
      0,
      MAX_CONFIGURABLE_RETRIES,
      baseDefaults.maxRetries
    ),
    followUpReviews: FOLLOW_UP_REVIEW_MODES.includes(rawSettings.followUpReviews)
      ? rawSettings.followUpReviews
      : baseDefaults.followUpReviews,
    reviewWorkspaceWrites:
      typeof rawSettings.reviewWorkspaceWrites === 'boolean'
        ? rawSettings.reviewWorkspaceWrites
        : baseDefaults.reviewWorkspaceWrites,
    showComposerButton:
      typeof rawSettings.showComposerButton === 'boolean'
        ? rawSettings.showComposerButton
        : baseDefaults.showComposerButton,
    permissionReviewLog:
      typeof rawSettings.permissionReviewLog === 'boolean'
        ? rawSettings.permissionReviewLog
        : baseDefaults.permissionReviewLog,
    autoMode: sanitizeAutoMode(rawSettings.autoMode, baseDefaults.autoMode)
  };
}

export function resolveEffectiveMode(settings, workspacePaths = [], cwd = '') {
  assert.ok(settings && typeof settings === 'object', 'settings object is required');
  const candidates = [
    ...(Array.isArray(workspacePaths) ? workspacePaths : []),
    ...(cwd ? [cwd] : [])
  ];
  for (const candidate of candidates) {
    const key = normalizeWorkspaceKey(candidate);
    if (key && settings.workspaceModes?.[key]) {
      return settings.workspaceModes[key];
    }
  }
  return REVIEW_MODES.includes(settings.mode) ? settings.mode : DEFAULT_REVIEW_MODE;
}

export function computePolicyFingerprint(settings) {
  const fingerprintTarget = {
    mode: settings.mode,
    provider: settings.provider,
    model: settings.model,
    reasoning: settings.reasoning,
    followUpReviews: settings.followUpReviews,
    reviewWorkspaceWrites: settings.reviewWorkspaceWrites,
    autoMode: settings.autoMode
  };
  return createHash('sha256').update(JSON.stringify(fingerprintTarget), 'utf8').digest('hex');
}

export function publicSettingsView(settings) {
  const { apiKey: _redacted, ...rest } = settings;
  return {
    ...rest,
    policyFingerprint: computePolicyFingerprint(settings)
  };
}

export function createSettingsStore({
  dataDirectory = resolvePluginDataDirectory(),
  home = homedir()
} = {}) {
  const settingsFilePath = join(dataDirectory, 'settings.json');
  const discovered = discoverLocalMagpieDefaults({ home });
  const defaultSettings = sanitizeSettings(
    {},
    {
      mode: DEFAULT_REVIEW_MODE,
      workspaceModes: {},
      provider: discovered.provider,
      baseUrl: discovered.baseUrl,
      apiKey: discovered.apiKey,
      model: discovered.model,
      reasoning: DEFAULT_REVIEWER_REASONING,
      contextWindow: discovered.contextWindow,
      timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
      attemptTimeoutMs: null,
      maxRetries: DEFAULT_MAX_RETRIES,
      followUpReviews: DEFAULT_FOLLOW_UP_REVIEW_MODE,
      reviewWorkspaceWrites: false,
      showComposerButton: true,
      permissionReviewLog: true,
      autoMode: {
        environment: [DEFAULTS_ENTRY],
        allow: [DEFAULTS_ENTRY],
        soft_deny: [DEFAULTS_ENTRY],
        hard_deny: [DEFAULTS_ENTRY]
      }
    }
  );

  let cachedSettings = null;
  let lastMtimeMs = -1;

  function loadFromDisk({ force = false } = {}) {
    if (!existsSync(settingsFilePath)) {
      cachedSettings = { ...defaultSettings, autoMode: sanitizeAutoMode(defaultSettings.autoMode) };
      lastMtimeMs = -1;
      return cachedSettings;
    }
    try {
      const mtimeMs = statSync(settingsFilePath).mtimeMs;
      if (!force && cachedSettings && mtimeMs === lastMtimeMs) {
        return cachedSettings;
      }
      const parsed = JSON.parse(readFileSync(settingsFilePath, 'utf8'));
      cachedSettings = sanitizeSettings(parsed, defaultSettings);
      lastMtimeMs = mtimeMs;
      return cachedSettings;
    } catch {
      cachedSettings = { ...defaultSettings, autoMode: sanitizeAutoMode(defaultSettings.autoMode) };
      return cachedSettings;
    }
  }

  return {
    filePath: settingsFilePath,
    defaults: defaultSettings,
    get({ force = false } = {}) {
      const active = loadFromDisk({ force });
      return {
        ...active,
        workspaceModes: { ...active.workspaceModes },
        autoMode: sanitizeAutoMode(active.autoMode)
      };
    },
    set(partialPatch = {}) {
      const current = loadFromDisk({ force: true });
      const mergedAutoMode =
        partialPatch.autoMode && typeof partialPatch.autoMode === 'object'
          ? { ...current.autoMode, ...partialPatch.autoMode }
          : current.autoMode;
      const mergedWorkspaceModes =
        partialPatch.workspaceModes && typeof partialPatch.workspaceModes === 'object'
          ? partialPatch.replaceWorkspaceModes === true
            ? partialPatch.workspaceModes
            : { ...current.workspaceModes, ...partialPatch.workspaceModes }
          : current.workspaceModes;

      const updated = sanitizeSettings(
        {
          ...current,
          ...partialPatch,
          workspaceModes: mergedWorkspaceModes,
          autoMode: mergedAutoMode
        },
        defaultSettings
      );
      writeJsonAtomically(settingsFilePath, updated);
      cachedSettings = updated;
      try {
        lastMtimeMs = statSync(settingsFilePath).mtimeMs;
      } catch {
        lastMtimeMs = Date.now();
      }
      return { ...updated };
    },
    reset() {
      if (existsSync(settingsFilePath)) {
        try {
          unlinkSync(settingsFilePath);
        } catch {
          // Ignore if already removed.
        }
      }
      cachedSettings = { ...defaultSettings };
      lastMtimeMs = -1;
      return { ...cachedSettings };
    }
  };
}
