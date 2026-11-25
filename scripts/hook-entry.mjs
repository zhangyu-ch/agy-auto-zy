import { join } from 'node:path';
import { MODE_OFF } from '../lib/constants.mjs';
import { classifyToolCall } from '../lib/gate.mjs';
import { createReviewerEngine } from '../lib/reviewer.mjs';
import { callRuntimeEndpoint } from '../lib/runtime-control.mjs';
import {
  createSettingsStore,
  resolveEffectiveMode,
  resolveHookAllowDecision,
  resolvePluginDataDirectory
} from '../lib/settings.mjs';

async function readStdinText() {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    raw += chunk;
  }
  return raw;
}

async function runHook() {
  const eventArg = process.argv[2] || '';
  const rawStdin = await readStdinText();
  const payload = rawStdin.trim() ? JSON.parse(rawStdin) : {};
  const eventName = eventArg || payload.hookEventName || 'PreToolUse';

  const dataDirectory = resolvePluginDataDirectory();
  const runtimeDirectory = join(dataDirectory, 'runtime');
  const settingsStore = createSettingsStore({ dataDirectory });
  const settings = settingsStore.get({ force: true });

  if (eventName === 'PreInvocation') {
    const rpcRes = await callRuntimeEndpoint(runtimeDirectory, {
      path: '/hook/pre-invocation',
      body: { conversationId: payload.conversationId || 'default' },
      timeoutMs: 1_500
    });
    if (!rpcRes.ok) {
      const localEngine = createReviewerEngine({ settingsStore, dataDirectory });
      localEngine.resetTurn(payload.conversationId || 'default');
    }
    process.stdout.write('{}\n');
    return;
  }

  const effectiveMode = resolveEffectiveMode(settings, payload.workspacePaths, payload.cwd);
  if (effectiveMode === MODE_OFF) {
    process.stdout.write('{}\n');
    return;
  }

  // Fast-path workspace reads/harness tools in-process for sub-2ms latency
  const quickCheck = classifyToolCall(payload, settings);
  if (quickCheck.fastDecision === 'allow') {
    const allowDecision = resolveHookAllowDecision(payload, { dataDirectory });
    process.stdout.write(`${JSON.stringify({ decision: allowDecision })}\n`);
    return;
  }

  const rpcTimeoutMs = Math.max(5_000, Number(settings.timeoutMs || 90_000) + 5_000);
  const rpcRes = await callRuntimeEndpoint(runtimeDirectory, {
    path: '/hook/pre-tool-use',
    body: payload,
    timeoutMs: rpcTimeoutMs
  });

  if (rpcRes.ok && rpcRes.body?.hookOutput) {
    process.stdout.write(`${JSON.stringify(rpcRes.body.hookOutput)}\n`);
    return;
  }

  const localEngine = createReviewerEngine({ settingsStore, dataDirectory });
  const result = await localEngine.evaluatePreToolUse(payload);
  process.stdout.write(`${JSON.stringify(result.hookOutput || {})}\n`);
}

runHook().catch(err => {
  process.stderr.write(`[agy-auto-zy] Hook error: ${err?.message || String(err)}\n`);
  if ((process.argv[2] || '') === 'PreInvocation') {
    process.stdout.write('{}\n');
  } else {
    process.stdout.write(
      `${JSON.stringify({
        decision: 'ask',
        reason: '[agy-auto-zy] 自动审核异常，已回退人工确认。'
      })}\n`
    );
  }
});
