import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startCdpHostBridge } from '../../lib/cdp-host.mjs';
import { PLUGIN_VERSION } from '../../lib/constants.mjs';
import {
  checkMagpieGatewayHealth,
  locateLocalMagpieExecutable,
  startLocalMagpieTray
} from '../../lib/magpie-client.mjs';
import { createReviewerEngine } from '../../lib/reviewer.mjs';
import {
  findActiveRuntime,
  servePluginRuntime,
  stopExistingRuntimes
} from '../../lib/runtime-control.mjs';
import {
  createSettingsStore,
  publicSettingsView,
  resolvePluginDataDirectory
} from '../../lib/settings.mjs';
import { startSidecarAuxServer } from '../../lib/sidecar-ui.mjs';

export async function startReviewerSidecar({
  dataDirectory = resolvePluginDataDirectory(),
  sidecarWebPort = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  sidecarUiToken = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || ''
} = {}) {
  const runtimeDirectory = join(dataDirectory, 'runtime');
  const hasOfficialWebPort = Number.isInteger(sidecarWebPort) && sidecarWebPort > 0;

  if (hasOfficialWebPort) {
    await stopExistingRuntimes(runtimeDirectory, { purge: false });
  } else {
    const existing = await findActiveRuntime(runtimeDirectory);
    if (existing && existing.version === PLUGIN_VERSION) {
      return { alreadyRunning: true, runtime: existing };
    }
    await stopExistingRuntimes(runtimeDirectory, { purge: false });
  }

  const settingsStore = createSettingsStore({ dataDirectory });
  let cdpBridge = null;

  const reviewer = createReviewerEngine({
    settingsStore,
    dataDirectory,
    onStateChange: () => {
      void cdpBridge?.broadcastStateSync({ probeGateway: false });
    }
  });

  cdpBridge = startCdpHostBridge({
    settingsStore,
    reviewer,
    version: PLUGIN_VERSION
  });

  const closeAuxServer = await startSidecarAuxServer({
    port: sidecarWebPort,
    token: sidecarUiToken,
    version: PLUGIN_VERSION,
    getStatus: async () => {
      const currentSettings = settingsStore.get({ force: true });
      const [uiHealth, gatewayHealth] = await Promise.all([
        cdpBridge.getHealth(),
        checkMagpieGatewayHealth({
          baseUrl: currentSettings.baseUrl,
          apiKey: currentSettings.apiKey
        })
      ]);
      const { tally, recent } = reviewer.logger.readRecent(25);
      return {
        version: PLUGIN_VERSION,
        settings: publicSettingsView(currentSettings),
        ui: uiHealth,
        gateway: gatewayHealth,
        magpieInstalled: Boolean(locateLocalMagpieExecutable()),
        tally,
        recent
      };
    },
    updateSettings: async patch => {
      const updated = settingsStore.set(patch);
      await cdpBridge.broadcastStateSync({ probeGateway: false });
      return publicSettingsView(updated);
    },
    testReview: async () => reviewer.testSampleReview(),
    startMagpie: async () => startLocalMagpieTray(),
    clearLogs: async () => {
      reviewer.logger.clear();
      reviewer.clearSessions();
      await cdpBridge.broadcastStateSync({ probeGateway: false });
    }
  }).catch(() => async () => {});

  const closeRuntime = await servePluginRuntime({
    directory: runtimeDirectory,
    version: PLUGIN_VERSION,
    onPreToolUse: async payload => reviewer.evaluatePreToolUse(payload),
    onPreInvocation: async payload => {
      reviewer.resetTurn(payload?.conversationId || 'default');
    },
    onSettingsReload: async () => {
      settingsStore.get({ force: true });
      await cdpBridge.broadcastStateSync({ probeGateway: false });
    },
    stop: async ({ purge = false } = {}) => {
      if (purge) {
        reviewer.logger.clear();
        reviewer.clearSessions();
      }
      await cdpBridge.stop();
      await closeAuxServer();
    },
    getHealth: async () => cdpBridge.getHealth()
  });

  const shutdown = async () => {
    await cdpBridge.stop();
    await closeAuxServer();
    await closeRuntime();
  };

  return { alreadyRunning: false, shutdown, cdpBridge, reviewer, settingsStore };
}

const currentFile = resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';

if (invokedFile && currentFile === invokedFile) {
  const instance = await startReviewerSidecar();
  if (instance.alreadyRunning) {
    process.exit(0);
  }
  for (const signalName of ['SIGINT', 'SIGTERM']) {
    process.on(signalName, async () => {
      await instance.shutdown();
      process.exit(0);
    });
  }
}
