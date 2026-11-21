import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAX_RECENT_DECISIONS_IN_UI,
  PLUGIN_ID,
  REVIEW_LOG_FIELD_MAX_WIDTH
} from './constants.mjs';
import { resolvePluginDataDirectory } from './settings.mjs';

const SECRET_BINDING_REGEX =
  /\b([A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|[^\s;|&]+)/gi;
const BEARER_HEADER_REGEX = /\b(Authorization\s*:\s*Bearer\s+)([^\s"']+)/gi;

export function maskNamedSecrets(rawString) {
  if (typeof rawString !== 'string' || !rawString) return rawString;
  return rawString
    .replace(SECRET_BINDING_REGEX, (_whole, varName) => `${varName}=[REDACTED]`)
    .replace(BEARER_HEADER_REGEX, (_whole, prefix) => `${prefix}[REDACTED]`);
}

export function clampLogField(rawValue, maxWidth = REVIEW_LOG_FIELD_MAX_WIDTH) {
  if (typeof rawValue === 'string') {
    const masked = maskNamedSecrets(rawValue);
    if (masked.length <= maxWidth) return masked;
    return `${masked.slice(0, Math.max(0, maxWidth - 1))}…`;
  }
  if (Array.isArray(rawValue)) {
    return rawValue.map(item => clampLogField(item, maxWidth));
  }
  if (rawValue && typeof rawValue === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(rawValue)) {
      if (/apiKey|token|secret|password|authorization/i.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = clampLogField(val, maxWidth);
      }
    }
    return out;
  }
  return rawValue;
}

export function createReviewLogger({
  dataDirectory = resolvePluginDataDirectory(),
  enabled = () => true,
  onDecision
} = {}) {
  assert.equal(typeof dataDirectory, 'string', 'dataDirectory must be a string');
  const logFilePath = join(dataDirectory, 'logs', 'permission-review.jsonl');

  function appendEvent(eventName, fields = {}) {
    const entry = {
      timestamp: new Date().toISOString(),
      pluginId: PLUGIN_ID,
      event: eventName,
      ...clampLogField(fields)
    };
    if (enabled()) {
      try {
        mkdirSync(dirname(logFilePath), { recursive: true });
        appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, {
          encoding: 'utf8',
          mode: 0o600
        });
      } catch {
        // Logging failure must never break permission enforcement.
      }
    }
    try {
      onDecision?.(entry);
    } catch {
      // Listener errors must never break permission enforcement.
    }
    return entry;
  }

  function readRecent(limit = MAX_RECENT_DECISIONS_IN_UI) {
    if (!existsSync(logFilePath)) {
      return {
        tally: { allow: 0, deny: 0, ask: 0, fastAllow: 0, total: 0 },
        recent: []
      };
    }
    try {
      const rawContent = readFileSync(logFilePath, 'utf8');
      const lines = rawContent.split(/\r?\n/).filter(Boolean);
      const tally = { allow: 0, deny: 0, ask: 0, fastAllow: 0, total: 0 };
      const decisionRecords = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.event === 'auto_zy.decision') {
            tally.total += 1;
            if (parsed.decision === 'allow') {
              if (parsed.decidedBy === 'fast-path') tally.fastAllow += 1;
              else tally.allow += 1;
            } else if (parsed.decision === 'deny') {
              tally.deny += 1;
            } else if (parsed.decision === 'ask' || parsed.decision === 'force_ask') {
              tally.ask += 1;
            }
            decisionRecords.push(parsed);
          }
        } catch {
          // Skip malformed log lines.
        }
      }

      return {
        tally,
        recent: decisionRecords.slice(-limit).reverse()
      };
    } catch {
      return {
        tally: { allow: 0, deny: 0, ask: 0, fastAllow: 0, total: 0 },
        recent: []
      };
    }
  }

  function clear() {
    if (!existsSync(logFilePath)) return;
    try {
      mkdirSync(dirname(logFilePath), { recursive: true });
      writeFileSync(logFilePath, '', { encoding: 'utf8', mode: 0o600 });
    } catch {
      // Ignore clear errors.
    }
  }

  return {
    logFilePath,
    appendEvent,
    readRecent,
    clear
  };
}
