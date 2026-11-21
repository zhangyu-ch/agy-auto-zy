import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CDP_COMMAND_TIMEOUT_MS,
  CDP_CONNECT_TIMEOUT_MS,
  CDP_EVALUATE_TIMEOUT_MS,
  CDP_MAX_BINDING_PAYLOAD_BYTES,
  CDP_POLL_INTERVAL_MS,
  CLIENT_INSTANCE_GLOBAL,
  CLIENT_PUSH_GLOBAL,
  CLIENT_RECEIVE_GLOBAL,
  HOST_BINDING_NAME,
  PLUGIN_VERSION,
  REVIEW_MODES
} from './constants.mjs';
import { checkMagpieGatewayHealth } from './magpie-client.mjs';
import { publicSettingsView, resolveDevToolsActivePortFile } from './settings.mjs';

const CLIENT_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'client-injected.js');

export function isAntigravityHubTarget(target) {
  try {
    const parsedUrl = new URL(target.url);
    return (
      target.type === 'page' &&
      /(?:^| - |\(\d+\) )Antigravity(?:\s*(?:\([^)]+\)|\[[^\]]+\]))?$/.test(target.title || '') &&
      parsedUrl.protocol === 'https:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)
    );
  } catch {
    return false;
  }
}

function fetchLocalCdpTargets(port) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/json/list',
        method: 'GET',
        agent: false
      },
      res => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`CDP HTTP ${res.statusCode}`));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(err);
          }
        });
        res.on('error', reject);
      }
    );
    req.setTimeout(3_000, () => req.destroy(new Error('CDP target list timeout')));
    req.on('error', reject);
    req.end();
  });
}

export function connectCdpSocket(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pendingRequests = new Map();
    const eventListeners = new Set();
    let sequence = 0;

    const connectTimer = setTimeout(() => {
      try {
        socket.close();
      } catch {}
      reject(new Error('CDP WebSocket connection timed out'));
    }, CDP_CONNECT_TIMEOUT_MS);

    const handleClose = () => {
      for (const entry of pendingRequests.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error('CDP connection closed'));
      }
      pendingRequests.clear();
    };

    socket.addEventListener('error', () => {
      clearTimeout(connectTimer);
      reject(new Error('CDP WebSocket error'));
    });
    socket.addEventListener('close', handleClose);
    socket.addEventListener('message', event => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      const pending = pendingRequests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error.message || 'CDP error'));
        } else {
          pending.resolve(message.result);
        }
      } else {
        for (const listener of eventListeners) {
          listener(message);
        }
      }
    });

    socket.addEventListener('open', () => {
      clearTimeout(connectTimer);
      resolve({
        socket,
        onEvent: fn => eventListeners.add(fn),
        send(method, params = {}) {
          if (socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP socket is closed'));
          }
          return new Promise((res, rej) => {
            const id = ++sequence;
            const timeoutMs =
              method === 'Runtime.evaluate' ? CDP_EVALUATE_TIMEOUT_MS : CDP_COMMAND_TIMEOUT_MS;
            const timer = setTimeout(() => {
              pendingRequests.delete(id);
              rej(new Error(`${method} timed out`));
            }, timeoutMs);
            pendingRequests.set(id, { resolve: res, reject: rej, timer });
            socket.send(JSON.stringify({ id, method, params }));
          });
        }
      });
    });
  });
}

export function buildInjectedScript({ origin, version = PLUGIN_VERSION, snapshot }) {
  const clientBody = readFileSync(CLIENT_SCRIPT_PATH, 'utf8');
  return `if (location.origin === ${JSON.stringify(origin)} && window === window.top) {\nglobalThis.__agyAutoZyConfig = ${JSON.stringify({ version, ...snapshot })};\n${clientBody}\n}`;
}

export function startCdpHostBridge({
  settingsStore,
  reviewer,
  portFilePath,
  version = PLUGIN_VERSION,
  onSettingsUpdated = () => {},
  onStatus = () => {}
}) {
  const activePortFile = resolveDevToolsActivePortFile({ portFile: portFilePath });
  const attachedClients = new Map();
  let stopped = false;
  let pollInProgress = false;
  let lastStatusMessage = '';
  let cachedGatewayOnline = true;
  let lastGatewayProbeAt = 0;

  const reportStatus = msg => {
    if (msg !== lastStatusMessage) {
      lastStatusMessage = msg;
      onStatus(`[agy-auto-zy] ${msg}`);
    }
  };

  async function probeGatewayStatus(settings, force = false) {
    if (!force && Date.now() - lastGatewayProbeAt < 15_000) {
      return cachedGatewayOnline;
    }
    lastGatewayProbeAt = Date.now();
    const health = await checkMagpieGatewayHealth({
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      timeoutMs: 2_200
    });
    cachedGatewayOnline = Boolean(health.online);
    return cachedGatewayOnline;
  }

  async function buildStateSnapshot({ probeGateway = false } = {}) {
    const currentSettings = settingsStore.get({ force: true });
    const gatewayOnline = await probeGatewayStatus(currentSettings, probeGateway);
    const { tally, recent } = reviewer.logger.readRecent(1);
    return {
      settings: publicSettingsView(currentSettings),
      tally,
      gatewayOnline,
      activeReviewsCount: reviewer.getActiveReviewsCount(),
      lastDecision: recent[0] || null
    };
  }

  function broadcastEvent(eventPayload) {
    if (stopped || attachedClients.size === 0) return;
    const expression = `globalThis.${CLIENT_PUSH_GLOBAL}?.(${JSON.stringify(eventPayload)})`;
    for (const entry of attachedClients.values()) {
      for (const contextId of entry.contexts) {
        void entry.client
          .send('Runtime.evaluate', { expression, contextId })
          .catch(() => {});
      }
    }
  }

  async function broadcastStateSync({ probeGateway = false } = {}) {
    const snapshot = await buildStateSnapshot({ probeGateway });
    for (const entry of attachedClients.values()) {
      await refreshPersistentScript(entry, snapshot).catch(() => {});
    }
    broadcastEvent({ type: 'state-sync', ...snapshot });
  }

  async function refreshPersistentScript(entry, snapshotOverride = null) {
    const snapshot = snapshotOverride || (await buildStateSnapshot());
    const source = buildInjectedScript({
      origin: entry.origin,
      version,
      snapshot
    });
    if (entry.scriptId) {
      await entry.client
        .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.scriptId })
        .catch(() => {});
    }
    const installed = await entry.client.send('Page.addScriptToEvaluateOnNewDocument', { source });
    entry.scriptId = installed.identifier;
    return source;
  }

  async function attachTarget(target) {
    const client = await connectCdpSocket(target.webSocketDebuggerUrl);
    const origin = new URL(target.url).origin;
    const frameTree = await client.send('Page.getFrameTree');
    const mainFrameId = frameTree.frameTree.frame.id;
    const contexts = new Set();

    const entry = {
      targetId: target.id,
      client,
      origin,
      endpoint: target.webSocketDebuggerUrl,
      contexts,
      scriptId: null
    };
    attachedClients.set(target.id, entry);

    client.socket.addEventListener('close', () => {
      if (attachedClients.get(target.id) === entry) {
        attachedClients.delete(target.id);
      }
    });

    client.onEvent(async event => {
      if (event.method === 'Runtime.executionContextCreated') {
        const ctx = event.params.context;
        if (ctx.origin === origin && ctx.auxData?.isDefault && ctx.auxData.frameId === mainFrameId) {
          contexts.add(ctx.id);
        }
        return;
      }
      if (event.method === 'Runtime.executionContextDestroyed') {
        contexts.delete(event.params.executionContextId);
        return;
      }
      if (event.method === 'Runtime.executionContextsCleared') {
        contexts.clear();
        return;
      }
      if (event.method !== 'Runtime.bindingCalled' || event.params.name !== HOST_BINDING_NAME) {
        return;
      }
      if (!contexts.has(event.params.executionContextId)) {
        return;
      }
      const rawPayload = event.params.payload || '';
      if (Buffer.byteLength(rawPayload, 'utf8') > CDP_MAX_BINDING_PAYLOAD_BYTES) {
        return;
      }

      let rpcReq;
      try {
        rpcReq = JSON.parse(rawPayload);
      } catch {
        return;
      }
      if (!Number.isInteger(rpcReq?.id)) return;

      let reply;
      try {
        if (rpcReq.method === 'status.get') {
          reply = await buildStateSnapshot({ probeGateway: true });
        } else if (rpcReq.method === 'mode.set') {
          if (!REVIEW_MODES.includes(rpcReq.mode)) {
            throw new Error(`Invalid mode: ${String(rpcReq.mode)}`);
          }
          settingsStore.set({ mode: rpcReq.mode });
          onSettingsUpdated();
          const snapshot = await buildStateSnapshot({ probeGateway: false });
          reply = snapshot;
          void broadcastStateSync();
        } else {
          throw new Error(`Unsupported RPC method: ${rpcReq.method}`);
        }
      } catch (err) {
        reply = { error: err.message };
      }

      await client
        .send('Runtime.evaluate', {
          expression: `globalThis.${CLIENT_RECEIVE_GLOBAL}?.(${JSON.stringify(rpcReq.id)}, ${JSON.stringify(reply)})`,
          contextId: event.params.executionContextId
        })
        .catch(() => {});
    });

    await client.send('Runtime.enable');
    await client.send('Runtime.addBinding', { name: HOST_BINDING_NAME });
    await client.send('Page.enable');

    const source = await refreshPersistentScript(entry);
    const evalRes = await client.send('Runtime.evaluate', { expression: source });
    if (evalRes.exceptionDetails) {
      throw new Error(evalRes.exceptionDetails.text || 'Injected script evaluation failed');
    }
    reportStatus('已挂载 Local Permissions 左侧切换按钮');
  }

  async function pollTargets() {
    if (stopped || pollInProgress) return;
    pollInProgress = true;
    try {
      if (!existsSync(activePortFile)) {
        throw new Error('未检测到 DevToolsActivePort');
      }
      const portNumber = Number(readFileSync(activePortFile, 'utf8').split(/\r?\n/)[0]);
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
        throw new Error('调试端口号无效');
      }

      const targets = await fetchLocalCdpTargets(portNumber);
      const hubTargets = targets.filter(isAntigravityHubTarget);

      for (const target of hubTargets) {
        let existing = attachedClients.get(target.id);
        try {
          if (
            existing &&
            (existing.origin !== new URL(target.url).origin ||
              existing.endpoint !== target.webSocketDebuggerUrl)
          ) {
            existing.client.socket.close();
            attachedClients.delete(target.id);
            existing = null;
          }
          if (!existing) {
            await attachTarget(target);
          } else {
            const checkRes = await existing.client.send('Runtime.evaluate', {
              expression: `location.origin === ${JSON.stringify(existing.origin)} && (!globalThis.${CLIENT_INSTANCE_GLOBAL} || globalThis.${CLIENT_INSTANCE_GLOBAL}.healthy !== true) && document.readyState !== 'loading'`,
              returnByValue: true
            });
            if (checkRes?.result?.value === true) {
              const source = await refreshPersistentScript(existing);
              await existing.client.send('Runtime.evaluate', { expression: source });
              reportStatus('已恢复 Local Permissions 左侧切换按钮');
            }
          }
        } catch (err) {
          attachedClients.get(target.id)?.client?.socket?.close();
          attachedClients.delete(target.id);
          reportStatus(`窗口重连: ${err.message}`);
        }
      }

      const activeIds = new Set(hubTargets.map(t => t.id));
      for (const [id, entry] of attachedClients.entries()) {
        if (!activeIds.has(id)) {
          entry.client.socket.close();
          attachedClients.delete(id);
        }
      }
      if (hubTargets.length === 0) {
        reportStatus('等待 Antigravity 聊天窗口');
      }
    } catch (err) {
      reportStatus(err.message || '等待调试端口');
    } finally {
      pollInProgress = false;
    }
  }

  const pollTimer = setInterval(pollTargets, CDP_POLL_INTERVAL_MS);
  pollTimer.unref?.();
  const initialReady = pollTargets();

  return {
    ready: initialReady,
    pollNow: pollTargets,
    broadcastStateSync,
    async getHealth() {
      await initialReady;
      let healthyWindows = 0;
      let mountedButtons = 0;
      for (const entry of attachedClients.values()) {
        try {
          const res = await entry.client.send('Runtime.evaluate', {
            expression: `({ healthy: globalThis.${CLIENT_INSTANCE_GLOBAL}?.healthy === true, version: globalThis.${CLIENT_INSTANCE_GLOBAL}?.version, stats: globalThis.${CLIENT_INSTANCE_GLOBAL}?.stats })`,
            returnByValue: true
          });
          const val = res?.result?.value;
          if (val?.healthy && val?.version === version) {
            healthyWindows += 1;
            mountedButtons += Number(val.stats?.mountedButtons || 0);
          }
        } catch {}
      }
      return {
        healthy: healthyWindows > 0,
        attachedWindows: healthyWindows,
        mountedButtons,
        lastStatus: lastStatusMessage
      };
    },
    async stop() {
      stopped = true;
      clearInterval(pollTimer);
      for (const entry of attachedClients.values()) {
        try {
          if (entry.scriptId) {
            await entry.client.send('Page.removeScriptToEvaluateOnNewDocument', {
              identifier: entry.scriptId
            });
          }
          await entry.client.send('Runtime.evaluate', {
            expression: `globalThis.${CLIENT_INSTANCE_GLOBAL}?.dispose?.()`
          });
        } catch {}
        try {
          entry.client.socket.close();
        } catch {}
      }
      attachedClients.clear();
    }
  };
}
