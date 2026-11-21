import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { REASONING_LEVELS, REVIEW_MODES } from './constants.mjs';

function findSidecarPreloadJs(env = process.env) {
  const candidates = [
    env.ANTIGRAVITY_APP_DATA_DIR &&
      join(env.ANTIGRAVITY_APP_DATA_DIR, 'lib', 'node_modules', 'sidecar_sdk', 'preload.js'),
    join(homedir(), '.gemini', 'antigravity', 'lib', 'node_modules', 'sidecar_sdk', 'preload.js')
  ].filter(Boolean);
  for (const filePath of candidates) {
    if (existsSync(filePath)) {
      try {
        return readFileSync(filePath, 'utf8');
      } catch {}
    }
  }
  return '';
}

function readJsonBody(req, maxBytes = 65_536) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) {
        req.destroy(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function renderSidecarAuxHtml({ version }) {
  const reasoningJson = JSON.stringify(REASONING_LEVELS);
  const modesJson = JSON.stringify(REVIEW_MODES);
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Auto-ZY 权限自动审核</title>
  <script src="/preload.js"></script>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 14px;
      background: var(--background, #0d1117);
      color: var(--foreground, #e6edf3);
      font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .card {
      border: 1px solid var(--border, rgba(127, 127, 127, 0.24));
      background: var(--card, rgba(127, 127, 127, 0.06));
      border-radius: 10px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .mode-grid { display: flex; flex-direction: column; gap: 6px; }
    .mode-item {
      border: 1px solid var(--border, rgba(127, 127, 127, 0.25));
      border-radius: 8px;
      padding: 9px 11px;
      cursor: pointer;
      background: transparent;
      color: inherit;
      text-align: left;
      font: inherit;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .mode-item[data-active="true"] {
      border-color: #10b981;
      background: rgba(16, 185, 129, 0.09);
    }
    .mode-item-head { font-weight: 600; display: flex; justify-content: space-between; }
    .mode-item-desc { font-size: 12px; opacity: 0.78; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
    .field { display: flex; flex-direction: column; gap: 4px; }
    .field label { font-size: 12px; opacity: 0.85; }
    input[type="text"], select, textarea {
      width: 100%;
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
      background: var(--background, rgba(0, 0, 0, 0.2));
      color: inherit;
      font: inherit;
    }
    textarea { min-height: 58px; resize: vertical; font-size: 12px; }
    .btn-row { display: flex; gap: 8px; flex-wrap: wrap; }
    button.action {
      padding: 6px 11px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
      background: var(--secondary, rgba(127, 127, 127, 0.16));
      color: inherit;
      cursor: pointer;
      font: 12px/1.2 inherit;
    }
    button.action:hover { opacity: 0.9; }
    .log-list { display: flex; flex-direction: column; gap: 6px; max-height: 260px; overflow-y: auto; }
    .log-entry {
      font-size: 11.5px;
      padding: 7px 9px;
      border-radius: 6px;
      border: 1px solid var(--border, rgba(127, 127, 127, 0.2));
      display: flex;
      flex-direction: column;
      gap: 3px;
    }
    .badge { padding: 1px 6px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge-allow { background: rgba(16, 185, 129, 0.18); color: #10b981; }
    .badge-deny { background: rgba(239, 68, 68, 0.18); color: #ef4444; }
    .badge-ask { background: rgba(245, 158, 11, 0.18); color: #f59e0b; }
    .hint { font-size: 11.5px; opacity: 0.78; }
  </style>
</head>
<body>
  <div class="stack">
    <div class="card">
      <h2 class="card-title">
        <span>Auto-ZY 审核模式</span>
        <span id="ver" class="hint">v${version || '1.0.0'}</span>
      </h2>
      <div class="mode-grid" id="modeGrid"></div>
    </div>

    <div class="card">
      <h2 class="card-title">
        <span>运行状态与本机 Magpie</span>
        <span id="gwBadge" class="hint">检测中…</span>
      </h2>
      <div class="row"><span>聊天底部左侧按钮</span><span id="uiState">-</span></div>
      <div class="row"><span>累计统计</span><span id="tallyState">-</span></div>
      <div class="field">
        <label>Magpie 接口地址</label>
        <input id="baseUrlInput" type="text" />
      </div>
      <div class="row">
        <div class="field" style="flex:1">
          <label>审核模型</label>
          <input id="modelInput" type="text" />
        </div>
        <div class="field" style="width:110px">
          <label>思考等级</label>
          <select id="reasoningSelect"></select>
        </div>
      </div>
      <div class="btn-row">
        <button class="action" id="saveModelBtn" type="button">保存模型配置</button>
        <button class="action" id="testReviewBtn" type="button">实测 ds-flash (max)</button>
        <button class="action" id="startMagpieBtn" type="button">启动 Magpie</button>
      </div>
      <div id="testResult" class="hint"></div>
    </div>

    <div class="card">
      <h2 class="card-title">
        <span>最近审核记录</span>
        <button class="action" id="clearLogBtn" type="button">清空记录</button>
      </h2>
      <div class="log-list" id="logList"></div>
    </div>
  </div>

  <script>
    const LEVELS = ${reasoningJson};
    const MODES = ${modesJson};
    const MODE_META = {
      'auto-zy': ['auto-zy (默认)', 'Codex Guardian 全面自动审核（含跨工作区目录操作）'],
      'auto-workspace-zy': ['auto-workspace-zy', '工作区内自动审核；跨目录与敏感路径强制回退人工确认'],
      'off': ['Off (关闭接管)', '暂停自动审核，完全遵循原生 Local Permissions']
    };

    const urlToken = new URLSearchParams(location.search).get('token') || '';
    async function api(path, method = 'GET', body = null) {
      const headers = { 'Accept': 'application/json' };
      if (urlToken) headers['x-sidecar-token'] = urlToken;
      if (body) headers['Content-Type'] = 'application/json';
      const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : null });
      return res.json();
    }

    const sel = document.getElementById('reasoningSelect');
    for (const lvl of LEVELS) {
      const opt = document.createElement('option');
      opt.value = lvl;
      opt.textContent = lvl;
      sel.appendChild(opt);
    }

    function renderModes(activeMode) {
      const grid = document.getElementById('modeGrid');
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      for (const m of MODES) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'mode-item';
        btn.dataset.active = String(m === activeMode);
        const head = document.createElement('div');
        head.className = 'mode-item-head';
        const title = document.createElement('span');
        title.textContent = MODE_META[m][0];
        const mark = document.createElement('span');
        mark.textContent = m === activeMode ? '✓' : '';
        head.append(title, mark);
        const desc = document.createElement('div');
        desc.className = 'mode-item-desc';
        desc.textContent = MODE_META[m][1];
        btn.append(head, desc);
        btn.onclick = async () => {
          await api('/api/settings', 'POST', { mode: m });
          await refresh();
        };
        grid.appendChild(btn);
      }
    }

    function renderLogs(items) {
      const list = document.getElementById('logList');
      while (list.firstChild) list.removeChild(list.firstChild);
      if (!items || items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'hint';
        empty.textContent = '暂无自动审核记录';
        list.appendChild(empty);
        return;
      }
      for (const item of items) {
        const row = document.createElement('div');
        row.className = 'log-entry';
        const top = document.createElement('div');
        top.className = 'row';
        const left = document.createElement('strong');
        left.textContent = (item.toolName || 'tool') + ' (' + (item.surface || '-') + ')';
        const badge = document.createElement('span');
        const dec = item.decision || 'ask';
        badge.className = 'badge badge-' + (dec === 'allow' ? 'allow' : dec === 'deny' ? 'deny' : 'ask');
        badge.textContent = dec + (item.durationMs != null ? ' ' + item.durationMs + 'ms' : '');
        top.append(left, badge);
        row.appendChild(top);
        if (item.target) {
          const tgt = document.createElement('div');
          tgt.className = 'hint';
          tgt.textContent = item.target;
          row.appendChild(tgt);
        }
        if (item.rationale || item.reason) {
          const rat = document.createElement('div');
          rat.textContent = item.rationale || item.reason;
          row.appendChild(rat);
        }
        list.appendChild(row);
      }
    }

    let initializedInputs = false;
    async function refresh() {
      try {
        const data = await api('/api/status');
        renderModes(data.settings?.mode || 'auto-zy');
        document.getElementById('gwBadge').textContent = data.gateway?.online ? 'Magpie 在线' : 'Magpie 离线';
        document.getElementById('uiState').textContent = data.ui?.healthy
          ? '已挂载 (' + data.ui.attachedWindows + ' 个窗口)'
          : (data.ui?.lastStatus || '等待连接');
        const t = data.tally || {};
        document.getElementById('tallyState').textContent =
          '放行 ' + (t.allow || 0) + '  拦截 ' + (t.deny || 0) + '  询问 ' + (t.ask || 0);
        if (!initializedInputs && data.settings) {
          document.getElementById('baseUrlInput').value = data.settings.baseUrl || '';
          document.getElementById('modelInput').value = data.settings.model || '';
          sel.value = data.settings.reasoning || 'max';
          initializedInputs = true;
        }
        renderLogs(data.recent || []);
      } catch {}
    }

    document.getElementById('saveModelBtn').onclick = async () => {
      await api('/api/settings', 'POST', {
        baseUrl: document.getElementById('baseUrlInput').value,
        model: document.getElementById('modelInput').value,
        reasoning: sel.value
      });
      await refresh();
    };

    document.getElementById('testReviewBtn').onclick = async () => {
      const box = document.getElementById('testResult');
      box.textContent = '正在请求 Magpie ds-flash (max) 进行 Codex Guardian 测试裁决…';
      const res = await api('/api/test-review', 'POST');
      box.textContent = res.ok
        ? '测试通过: outcome=' + res.outcome + ', risk=' + res.riskLevel + ', auth=' + res.userAuthorization + ' (' + res.elapsedMs + 'ms)'
        : '测试失败: ' + (res.error || '未知错误');
      await refresh();
    };

    document.getElementById('startMagpieBtn').onclick = async () => {
      const box = document.getElementById('testResult');
      const res = await api('/api/start-magpie', 'POST');
      box.textContent = res.started ? '已启动本机 Magpie 托盘服务' : (res.error || '启动失败');
      setTimeout(refresh, 1500);
    };

    document.getElementById('clearLogBtn').onclick = async () => {
      await api('/api/clear-logs', 'POST');
      await refresh();
    };

    refresh();
    setInterval(refresh, 4000);
  </script>
</body>
</html>`;
}

export function startSidecarAuxServer({
  port = Number(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || 0),
  token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '',
  version,
  getStatus,
  updateSettings,
  testReview,
  startMagpie,
  clearLogs,
  env = process.env
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return Promise.resolve(async () => {});
  }

  const preloadScript = findSidecarPreloadJs(env);
  const isAuthorized = (req, parsedUrl) => {
    if (parsedUrl.pathname === '/preload.js') return true;
    if (!token) return true;
    return (req.headers['x-sidecar-token'] || parsedUrl.searchParams.get('token')) === token;
  };

  const server = createServer(async (req, res) => {
    const parsedUrl = new URL(req.url || '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && parsedUrl.pathname === '/preload.js') {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(preloadScript);
      return;
    }
    if (req.method === 'GET' && parsedUrl.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderSidecarAuxHtml({ version }));
      return;
    }
    if (!isAuthorized(req, parsedUrl)) {
      res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    try {
      if (req.method === 'GET' && parsedUrl.pathname === '/api/status') {
        const status = await getStatus();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(status));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/settings') {
        const patch = await readJsonBody(req);
        const updated = await updateSettings(patch);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, settings: updated }));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/test-review') {
        const result = await testReview();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/start-magpie') {
        const result = await startMagpie();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
        return;
      }
      if (req.method === 'POST' && parsedUrl.pathname === '/api/clear-logs') {
        await clearLogs();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: error.message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve(() => new Promise(done => server.close(() => done())));
    });
  });
}
