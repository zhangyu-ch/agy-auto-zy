import { join } from 'node:path';
import { BUILT_IN_RULES, POLICY_REVISION } from '../lib/codex-guardian.mjs';
import { REVIEW_MODES, RULE_LIST_NAMES } from '../lib/constants.mjs';
import { checkMagpieGatewayHealth } from '../lib/magpie-client.mjs';
import { createReviewLogger } from '../lib/review-log.mjs';
import { createReviewerEngine } from '../lib/reviewer.mjs';
import { callRuntimeEndpoint, findActiveRuntime } from '../lib/runtime-control.mjs';
import {
  createSettingsStore,
  publicSettingsView,
  resolvePluginDataDirectory
} from '../lib/settings.mjs';

const args = process.argv.slice(2);
const subcommand = (args[0] || 'show').toLowerCase();

const dataDirectory = resolvePluginDataDirectory();
const runtimeDirectory = join(dataDirectory, 'runtime');
const settingsStore = createSettingsStore({ dataDirectory });
const logger = createReviewLogger({ dataDirectory });

async function notifySidecarReload() {
  await callRuntimeEndpoint(runtimeDirectory, {
    path: '/settings/reload',
    body: {},
    timeoutMs: 1_500
  });
}

if (subcommand === 'mode' || REVIEW_MODES.includes(subcommand)) {
  const targetMode = subcommand === 'mode' ? (args[1] || '').toLowerCase() : subcommand;
  if (!REVIEW_MODES.includes(targetMode)) {
    console.error(`无效模式: "${targetMode}"。可选值: ${REVIEW_MODES.join(' | ')}`);
    process.exit(1);
  }
  const updated = settingsStore.set({ mode: targetMode });
  await notifySidecarReload();
  console.log(
    JSON.stringify(
      {
        ok: true,
        mode: updated.mode,
        model: updated.model,
        reasoning: updated.reasoning,
        settingsFile: settingsStore.filePath
      },
      null,
      2
    )
  );
} else if (subcommand === 'logs') {
  const limit = Math.max(1, Math.min(100, Number(args[1] || 15)));
  console.log(JSON.stringify(logger.readRecent(limit), null, 2));
} else if (subcommand === 'defaults') {
  const summary = Object.fromEntries(
    RULE_LIST_NAMES.map(list => [
      list,
      BUILT_IN_RULES[list].map(item => item.split('\n')[0].replace(/^#+\s*/, ''))
    ])
  );
  console.log(JSON.stringify({ policyRevision: POLICY_REVISION, builtInRules: summary }, null, 2));
} else if (subcommand === 'test') {
  const engine = createReviewerEngine({ settingsStore, dataDirectory, logger });
  const result = await engine.testSampleReview();
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
} else if (subcommand === 'reset') {
  const reset = settingsStore.reset();
  await notifySidecarReload();
  console.log(JSON.stringify({ ok: true, settings: publicSettingsView(reset) }, null, 2));
} else {
  const current = settingsStore.get({ force: true });
  const [runtime, gateway] = await Promise.all([
    findActiveRuntime(runtimeDirectory),
    checkMagpieGatewayHealth({ baseUrl: current.baseUrl, apiKey: current.apiKey })
  ]);
  const { tally } = logger.readRecent(10);
  console.log(
    JSON.stringify(
      {
        policyRevision: POLICY_REVISION,
        settingsFile: settingsStore.filePath,
        logFile: logger.logFilePath,
        settings: publicSettingsView(current),
        gateway,
        sidecarRunning: Boolean(runtime),
        uiAttachedWindows: runtime?.health?.attachedWindows ?? 0,
        tally
      },
      null,
      2
    )
  );
}
