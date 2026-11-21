import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  FIRST_RETRY_DELAY_MS,
  MAX_RETRY_DELAY_MS,
  OUTPUT_RESERVE_TOKENS,
  SESSION_AFFINITY_PREFIX
} from './constants.mjs';
import { normalizeBaseUrl, normalizeModelId } from './settings.mjs';

const THINK_BLOCK_REGEX = /<think>[\s\S]*?<\/think>/gi;
const UNCLOSED_THINK_REGEX = /<think>[\s\S]*$/i;

export function stripThinkTags(rawText) {
  if (typeof rawText !== 'string') return '';
  return rawText.replace(THINK_BLOCK_REGEX, '').replace(UNCLOSED_THINK_REGEX, '').trim();
}

export function resolveReasoningEffort(reasoningLevel, fallbackHigh = false) {
  if (!reasoningLevel || reasoningLevel === 'off' || reasoningLevel === 'minimal') {
    return undefined;
  }
  if (fallbackHigh && (reasoningLevel === 'max' || reasoningLevel === 'xhigh')) {
    return 'high';
  }
  return reasoningLevel;
}

function parseUsageBlock(rawUsage = {}) {
  const promptTokens = Number(rawUsage.prompt_tokens || 0);
  const cacheRead = Number(
    rawUsage.prompt_tokens_details?.cached_tokens ??
      rawUsage.prompt_cache_hit_tokens ??
      rawUsage.cached_tokens ??
      0
  );
  const cacheWrite = Number(rawUsage.prompt_tokens_details?.cache_write_tokens || 0);
  const input = Math.max(0, promptTokens - cacheRead - cacheWrite);
  const output = Number(rawUsage.completion_tokens || 0);
  const reasoning = Number(rawUsage.completion_tokens_details?.reasoning_tokens || 0);
  return { input, cacheRead, cacheWrite, output, reasoning };
}

function sleepWithSignal(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function streamChatCompletionOnce({
  endpointUrl,
  apiKey,
  sessionId,
  requestBody,
  timeoutMs,
  signal
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const abortErr = new Error('Operation aborted');
      abortErr.name = 'AbortError';
      reject(abortErr);
      return;
    }

    const parsedUrl = new URL(endpointUrl);
    const transport = parsedUrl.protocol === 'https:' ? https : http;
    const payloadBuffer = Buffer.from(JSON.stringify(requestBody), 'utf8');
    const affinityValue = sessionId ? `${SESSION_AFFINITY_PREFIX}${sessionId}` : undefined;

    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      Accept: 'text/event-stream, application/json',
      Authorization: `Bearer ${apiKey || 'magpie'}`,
      'Content-Length': payloadBuffer.length,
      ...(affinityValue
        ? {
            session_id: affinityValue,
            'x-client-request-id': affinityValue,
            'x-session-affinity': affinityValue
          }
        : {})
    };

    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      signal?.removeEventListener('abort', handleAbort);
      if (err) reject(err);
      else resolve(val);
    };

    const req = transport.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method: 'POST',
        agent: false,
        headers
      },
      res => {
        const statusCode = res.statusCode || 0;
        const contentType = String(res.headers['content-type'] || '').toLowerCase();
        res.setEncoding('utf8');

        if (statusCode < 200 || statusCode >= 300) {
          let errBody = '';
          res.on('data', chunk => {
            if (errBody.length < 4_096) errBody += chunk;
          });
          res.on('end', () => {
            const error = new Error(
              `HTTP ${statusCode}: ${errBody.trim().slice(0, 320) || res.statusMessage || 'Request failed'}`
            );
            error.statusCode = statusCode;
            finish(error);
          });
          res.on('error', finish);
          return;
        }

        if (!contentType.includes('text/event-stream')) {
          let rawJson = '';
          res.on('data', chunk => {
            rawJson += chunk;
          });
          res.on('end', () => {
            try {
              const parsed = JSON.parse(rawJson);
              const rawContent = parsed?.choices?.[0]?.message?.content || '';
              const finishReason = parsed?.choices?.[0]?.finish_reason || 'stop';
              const usage = parseUsageBlock(parsed?.usage);
              finish(null, {
                text: stripThinkTags(rawContent),
                finishReason,
                usage
              });
            } catch (parseErr) {
              finish(new Error(`Invalid JSON completion response: ${parseErr.message}`));
            }
          });
          res.on('error', finish);
          return;
        }

        let accumulatedContent = '';
        let finishReason = null;
        let usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
        let lineBuffer = '';

        const processSseLine = rawLine => {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) return;
          const payload = line.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          try {
            const chunk = JSON.parse(payload);
            if (chunk?.usage) {
              usage = parseUsageBlock(chunk.usage);
            }
            const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined;
            if (!choice) return;
            if (!chunk.usage && choice.usage) {
              usage = parseUsageBlock(choice.usage);
            }
            if (choice.finish_reason) {
              finishReason = choice.finish_reason;
            }
            const deltaText = choice.delta?.content ?? choice.message?.content ?? '';
            if (typeof deltaText === 'string' && deltaText.length > 0) {
              accumulatedContent += deltaText;
            }
          } catch {
            // Ignore non-JSON SSE keepalives.
          }
        };

        res.on('data', chunk => {
          lineBuffer += chunk;
          let idx;
          while ((idx = lineBuffer.indexOf('\n')) !== -1) {
            const line = lineBuffer.slice(0, idx);
            lineBuffer = lineBuffer.slice(idx + 1);
            processSseLine(line);
          }
        });

        res.on('end', () => {
          if (lineBuffer.trim()) {
            processSseLine(lineBuffer);
          }
          finish(null, {
            text: stripThinkTags(accumulatedContent),
            finishReason: finishReason || 'stop',
            usage
          });
        });

        res.on('error', finish);
      }
    );

    const handleAbort = () => {
      const abortErr = new Error('Operation aborted');
      abortErr.name = 'AbortError';
      req.destroy(abortErr);
      finish(abortErr);
    };
    signal?.addEventListener('abort', handleAbort, { once: true });

    const timeoutHandle = setTimeout(() => {
      const timeoutErr = new Error(`Attempt timed out after ${timeoutMs}ms`);
      timeoutErr.code = 'ETIMEDOUT';
      req.destroy(timeoutErr);
      finish(timeoutErr);
    }, timeoutMs);

    req.on('error', finish);
    req.write(payloadBuffer);
    req.end();
  });
}

function isPermanentHttpError(err) {
  const status = err?.statusCode;
  return status === 401 || status === 403 || status === 404;
}

export async function completeReviewModelCall({
  settings,
  sessionId,
  systemPrompt,
  messages,
  estimatedTokens,
  parseResponse,
  requestImpl = streamChatCompletionOnce,
  signal
}) {
  const contextWindow = Number(settings.contextWindow || 400_000);
  if (estimatedTokens + OUTPUT_RESERVE_TOKENS > contextWindow) {
    return {
      ok: false,
      failure: 'input-budget-exceeded',
      usage: { input: 0, cacheRead: 0, output: 0 }
    };
  }

  const totalTimeoutMs = Number(settings.timeoutMs || 90_000);
  const configuredAttemptMs = Number(settings.attemptTimeoutMs || totalTimeoutMs);
  const maxRetries = Number(settings.maxRetries ?? 2);
  const deadline = Date.now() + totalTimeoutMs;

  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(() => deadlineController.abort(), totalTimeoutMs);
  const combinedSignals = signal
    ? AbortSignal.any([signal, deadlineController.signal])
    : deadlineController.signal;

  const endpointUrl = `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`;
  const modelId = normalizeModelId(settings.model);
  const totalUsage = { input: 0, cacheRead: 0, output: 0, reasoning: 0 };

  let useSystemRoleFallback = false;
  let useHighReasoningFallback = false;

  try {
    for (let attempt = 0; ; attempt += 1) {
      if (combinedSignals.aborted) {
        return {
          ok: false,
          failure: deadlineController.signal.aborted ? 'timeout' : 'cancelled',
          usage: totalUsage
        };
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        return { ok: false, failure: 'timeout', usage: totalUsage };
      }

      const attemptBudgetMs = Math.max(250, Math.min(configuredAttemptMs, remainingMs));
      const instructionRole = useSystemRoleFallback ? 'system' : 'developer';
      const reasoningEffort = resolveReasoningEffort(settings.reasoning, useHighReasoningFallback);

      const requestBody = {
        model: modelId,
        stream: true,
        stream_options: { include_usage: true },
        store: false,
        messages: [{ role: instructionRole, content: systemPrompt }, ...messages],
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {})
      };

      let failureCategory = 'provider-error';
      try {
        const reply = await requestImpl({
          endpointUrl,
          apiKey: settings.apiKey,
          sessionId,
          requestBody,
          timeoutMs: attemptBudgetMs,
          signal: combinedSignals
        });

        totalUsage.input += reply.usage?.input || 0;
        totalUsage.cacheRead += reply.usage?.cacheRead || 0;
        totalUsage.output += reply.usage?.output || 0;
        totalUsage.reasoning += reply.usage?.reasoning || 0;

        if (reply.finishReason === 'content_filter') {
          return { ok: false, failure: 'provider-error', usage: totalUsage };
        }

        failureCategory = 'invalid-response';
        const parsedValue = parseResponse(reply.text);
        return {
          ok: true,
          value: parsedValue,
          replyText: reply.text,
          replyUsage: reply.usage || { input: 0, cacheRead: 0, output: 0 },
          usage: totalUsage
        };
      } catch (err) {
        if (combinedSignals.aborted) {
          return {
            ok: false,
            failure: deadlineController.signal.aborted ? 'timeout' : 'cancelled',
            usage: totalUsage
          };
        }

        if (err?.statusCode === 400) {
          if (!useSystemRoleFallback) {
            useSystemRoleFallback = true;
          } else if (!useHighReasoningFallback) {
            useHighReasoningFallback = true;
          }
        }

        if (isPermanentHttpError(err)) {
          return { ok: false, failure: 'provider-error', usage: totalUsage, errorMessage: err.message };
        }

        if (attempt >= maxRetries) {
          return {
            ok: false,
            failure: err?.code === 'ETIMEDOUT' ? 'attempt-timeout' : failureCategory,
            usage: totalUsage,
            errorMessage: err?.message
          };
        }
      }

      const backoffMs = Math.min(FIRST_RETRY_DELAY_MS * 4 ** attempt, MAX_RETRY_DELAY_MS);
      await sleepWithSignal(backoffMs, combinedSignals);
    }
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function checkMagpieGatewayHealth({ baseUrl, apiKey, timeoutMs = 3_500 } = {}) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const modelsUrl = new URL(`${normalizedBase}/models`);
  const transport = modelsUrl.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    let done = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };

    const req = transport.request(
      {
        protocol: modelsUrl.protocol,
        hostname: modelsUrl.hostname,
        port: modelsUrl.port || (modelsUrl.protocol === 'https:' ? 443 : 80),
        path: `${modelsUrl.pathname}${modelsUrl.search}`,
        method: 'GET',
        agent: false,
        headers: {
          Authorization: `Bearer ${apiKey || 'magpie'}`,
          Accept: 'application/json'
        }
      },
      res => {
        res.resume();
        const ok = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
        finish({
          online: ok,
          statusCode: res.statusCode || 0,
          baseUrl: normalizedBase,
          error: ok ? null : `HTTP ${res.statusCode}`
        });
      }
    );

    const timer = setTimeout(() => {
      req.destroy();
      finish({ online: false, baseUrl: normalizedBase, error: '连接超时' });
    }, timeoutMs);

    req.on('error', err => finish({ online: false, baseUrl: normalizedBase, error: err.message }));
    req.end();
  });
}

export function locateLocalMagpieExecutable({ home = homedir(), env = process.env } = {}) {
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
  const candidates = [
    join(localAppData, 'Programs', 'magpie', 'magpie.com'),
    join(localAppData, 'Programs', 'magpie', 'magpie.exe'),
    '/usr/local/bin/magpie',
    join(home, '.local', 'bin', 'magpie')
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export async function startLocalMagpieTray({ home = homedir(), env = process.env } = {}) {
  const executablePath = locateLocalMagpieExecutable({ home, env });
  if (!executablePath) {
    return { started: false, error: '未找到本机 Magpie 可执行文件' };
  }
  try {
    const child = spawn(executablePath, ['tray'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
    return { started: true, executablePath };
  } catch (err) {
    return { started: false, error: err.message };
  }
}
