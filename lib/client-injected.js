(() => {
  const bootstrap = globalThis.__agyAutoZyConfig || {};
  const pluginVersion = bootstrap.version || '1.0.0';

  if (
    globalThis.__agyAutoZy?.version === pluginVersion &&
    globalThis.__agyAutoZy?.healthy === true
  ) {
    return;
  }

  globalThis.__agyAutoZy?.dispose?.();

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PERMISSION_PRESET_TEXT_REGEX =
    /^(Request Review|请求审查|Require Review|需要审查|Default|默认|Auto|自动|Turbo|Custom|自定义)(\s|$)/i;
  const PERMISSION_ATTR_REGEX =
    /Local Permissions|Remote Permissions|Permission|本地权限|远程权限|权限预设/i;

  const MODE_ITEMS = [
    {
      id: 'auto-zy',
      title: 'auto-zy',
      isDefault: true,
      description: 'Codex Guardian 全面自动审核（含跨目录操作）。',
      iconType: 'shield-spark'
    },
    {
      id: 'auto-workspace-zy',
      title: 'auto-workspace-zy',
      isDefault: false,
      description: '工作区内自动审核；跨目录与敏感路径弹窗确认。',
      iconType: 'shield-folder'
    },
    {
      id: 'off',
      title: 'Off',
      isDefault: false,
      description: '暂停自动审核，完全遵循右侧 Local Permissions。',
      iconType: 'shield-off'
    }
  ];

  let settings = {
    mode: 'auto-zy',
    model: 'group/ds-flash',
    reasoning: 'max',
    showComposerButton: true,
    ...(bootstrap.settings || {})
  };
  let tally = {
    allow: 0,
    deny: 0,
    ask: 0,
    fastAllow: 0,
    total: 0,
    ...(bootstrap.tally || {})
  };
  let gatewayOnline = bootstrap.gatewayOnline !== false;
  let activeReviewsCount = Number(bootstrap.activeReviewsCount || 0);
  let lastDecision = bootstrap.lastDecision || null;

  let disposed = false;
  let rpcSeq = 0;
  const pendingCalls = new Map();
  const mountedRoots = new Map();
  let activePopup = null;
  let activeTriggerButton = null;

  function sendRpc(method, payload = {}) {
    return new Promise((resolve, reject) => {
      if (typeof globalThis.__agyAutoZyHost !== 'function') {
        reject(new Error('Host bridge unavailable'));
        return;
      }
      const id = ++rpcSeq;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        reject(new Error('RPC timeout'));
      }, 12000);
      pendingCalls.set(id, { resolve, reject, timer });
      globalThis.__agyAutoZyHost(JSON.stringify({ id, method, ...payload }));
    });
  }

  globalThis.__agyAutoZyReceive = (id, reply) => {
    const entry = pendingCalls.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pendingCalls.delete(id);
    if (reply?.error) entry.reject(new Error(reply.error));
    else entry.resolve(reply);
  };

  globalThis.__agyAutoZyPush = event => {
    if (disposed || !event || typeof event !== 'object') return;
    if (event.type === 'state-sync') {
      if (event.settings) settings = { ...settings, ...event.settings };
      if (event.tally) tally = { ...tally, ...event.tally };
      if (typeof event.gatewayOnline === 'boolean') gatewayOnline = event.gatewayOnline;
      if (typeof event.activeReviewsCount === 'number') activeReviewsCount = event.activeReviewsCount;
      if (event.lastDecision !== undefined) lastDecision = event.lastDecision;
      syncAllButtons();
      if (activePopup) renderPopupContents();
    }
  };

  const styleElement = document.createElement('style');
  styleElement.dataset.agyAutoZyStyle = '';
  styleElement.textContent = `
    [data-agy-auto-zy-root] {
      display: inline-flex;
      align-items: center;
      flex-shrink: 0;
    }
    .agy-auto-zy-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      height: 28px;
      padding: 0 8px;
      border-radius: 6px;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted-foreground, #9ca3af);
      font-family: inherit;
      font-size: 13px;
      line-height: 1;
      font-weight: 500;
      cursor: pointer;
      user-select: none;
      white-space: nowrap;
      transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
    }
    .agy-auto-zy-btn:hover,
    .agy-auto-zy-btn[aria-expanded="true"] {
      background: var(--secondary, rgba(255, 255, 255, 0.08));
      color: var(--foreground, #f3f4f6);
    }
    .agy-auto-zy-btn[data-mode="auto-zy"] {
      color: var(--foreground, #f3f4f6);
    }
    .agy-auto-zy-btn[data-mode="auto-zy"] .agy-auto-zy-icon {
      color: #10b981;
    }
    .agy-auto-zy-btn[data-mode="auto-workspace-zy"] {
      color: var(--foreground, #f3f4f6);
    }
    .agy-auto-zy-btn[data-mode="auto-workspace-zy"] .agy-auto-zy-icon {
      color: #38bdf8;
    }
    .agy-auto-zy-btn[data-mode="off"] {
      opacity: 0.72;
    }
    @keyframes agy-auto-zy-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.35; transform: scale(0.82); }
    }
    .agy-auto-zy-reviewing-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: #f59e0b;
      flex-shrink: 0;
      animation: agy-auto-zy-pulse 1s ease-in-out infinite;
    }
    .agy-auto-zy-popup {
      position: fixed;
      z-index: 9999;
      width: 308px;
      border-radius: 12px;
      border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
      background: var(--popover, var(--background, #18181b));
      color: var(--popover-foreground, var(--foreground, #f4f4f5));
      box-shadow: 0 14px 36px rgba(0, 0, 0, 0.45), 0 2px 8px rgba(0, 0, 0, 0.28);
      padding: 6px;
      font-family: inherit;
      animation: agy-auto-zy-fade 110ms ease-out both;
    }
    @keyframes agy-auto-zy-fade {
      from { opacity: 0; transform: translateY(4px) scale(0.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .agy-auto-zy-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px 8px;
      font-size: 12px;
      font-weight: 500;
      color: var(--muted-foreground, #a1a1aa);
    }
    .agy-auto-zy-model-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 9999px;
      background: var(--secondary, rgba(255, 255, 255, 0.07));
      color: var(--muted-foreground, #a1a1aa);
    }
    .agy-auto-zy-dot {
      width: 6px;
      height: 6px;
      border-radius: 9999px;
      background: #10b981;
    }
    .agy-auto-zy-dot[data-online="false"] {
      background: #ef4444;
    }
    .agy-auto-zy-option {
      display: flex;
      align-items: center;
      gap: 11px;
      width: 100%;
      padding: 9px 10px;
      border: none;
      border-radius: 8px;
      background: transparent;
      color: inherit;
      text-align: left;
      cursor: pointer;
      font-family: inherit;
      transition: background-color 100ms ease;
    }
    .agy-auto-zy-option:hover,
    .agy-auto-zy-option:focus-visible {
      background: var(--secondary, rgba(255, 255, 255, 0.08));
      outline: none;
    }
    .agy-auto-zy-opt-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      flex-shrink: 0;
      color: var(--muted-foreground, #a1a1aa);
    }
    .agy-auto-zy-option[data-selected="true"] .agy-auto-zy-opt-icon {
      color: var(--foreground, #ffffff);
    }
    .agy-auto-zy-opt-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1;
      min-width: 0;
    }
    .agy-auto-zy-opt-title-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 13.5px;
      font-weight: 500;
      color: var(--foreground, #f4f4f5);
      line-height: 1.25;
    }
    .agy-auto-zy-option[data-selected="true"] .agy-auto-zy-opt-title-row {
      font-weight: 600;
    }
    .agy-auto-zy-default-badge {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 500;
      background: var(--secondary, rgba(255, 255, 255, 0.1));
      color: var(--muted-foreground, #a1a1aa);
    }
    .agy-auto-zy-opt-desc {
      font-size: 12px;
      line-height: 1.35;
      color: var(--muted-foreground, #9ca3af);
    }
    .agy-auto-zy-check {
      width: 16px;
      height: 16px;
      flex-shrink: 0;
      color: var(--foreground, #f4f4f5);
      opacity: 0;
    }
    .agy-auto-zy-option[data-selected="true"] .agy-auto-zy-check {
      opacity: 1;
    }
    .agy-auto-zy-footer {
      margin-top: 4px;
      padding: 7px 10px 4px;
      border-top: 1px solid var(--border, rgba(255, 255, 255, 0.09));
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11.5px;
      color: var(--muted-foreground, #9ca3af);
    }
    .agy-auto-zy-tally-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      font-variant-numeric: tabular-nums;
    }
    .agy-auto-zy-last-row {
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: 0.86;
    }
    @container input-footer (max-width: 460px) {
      .agy-auto-zy-btn .agy-auto-zy-label {
        display: none;
      }
      .agy-auto-zy-btn {
        padding: 0 6px;
      }
    }
  `;

  function createSvgIcon(kind, size = 15, extraClass = '') {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.9');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (extraClass) svg.setAttribute('class', extraClass);

    const addPath = d => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    };

    if (kind === 'shield-spark') {
      addPath('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
      addPath('M12 8v4');
      addPath('M10 10h4');
      addPath('M9.5 14.5l2 2 3.5-3.5');
    } else if (kind === 'shield-folder') {
      addPath('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
      addPath('M8.5 10.5h2.2l1.1 1.2h3.7v4.3H8.5z');
    } else if (kind === 'shield-off') {
      addPath('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z');
      addPath('M9.5 9.5l5 5');
      addPath('M14.5 9.5l-5 5');
    } else if (kind === 'check') {
      addPath('M20 6L9 17l-5-5');
    }
    return svg;
  }

  function modeShortLabel(mode) {
    if (mode === 'auto-zy') return 'auto-zy';
    if (mode === 'auto-workspace-zy') return 'auto-workspace-zy';
    return 'auto-zy: off';
  }

  function modeIconType(mode) {
    if (mode === 'auto-zy') return 'shield-spark';
    if (mode === 'auto-workspace-zy') return 'shield-folder';
    return 'shield-off';
  }

  function updateButtonVisuals(btn) {
    if (!btn) return;
    const mode = settings.mode || 'auto-zy';
    btn.dataset.mode = mode;
    btn.setAttribute('aria-expanded', String(activePopup !== null && activeTriggerButton === btn));
    const reviewSuffix = activeReviewsCount > 0 ? ' (正在审核…)' : '';
    btn.title = `Auto-ZY 审核模式: ${mode} | 模型: ${settings.model} (${settings.reasoning})${reviewSuffix}`;

    while (btn.firstChild) btn.removeChild(btn.firstChild);
    btn.appendChild(createSvgIcon(modeIconType(mode), 15, 'agy-auto-zy-icon'));

    const labelSpan = document.createElement('span');
    labelSpan.className = 'agy-auto-zy-label';
    labelSpan.textContent = modeShortLabel(mode);
    btn.appendChild(labelSpan);

    if (activeReviewsCount > 0) {
      const dot = document.createElement('span');
      dot.className = 'agy-auto-zy-reviewing-dot';
      btn.appendChild(dot);
    }
  }

  function syncAllButtons() {
    if (!settings.showComposerButton) {
      closePopup();
      for (const [, entry] of mountedRoots) {
        entry.mount.remove();
      }
      mountedRoots.clear();
      return;
    }
    for (const [, entry] of mountedRoots) {
      updateButtonVisuals(entry.button);
    }
  }

  function positionPopup() {
    if (!activePopup || !activeTriggerButton || !activeTriggerButton.isConnected) {
      closePopup();
      return;
    }
    const rect = activeTriggerButton.getBoundingClientRect();
    const popupRect = activePopup.getBoundingClientRect();
    const margin = 8;

    let left = rect.left;
    if (left + popupRect.width > window.innerWidth - margin) {
      left = Math.max(margin, window.innerWidth - popupRect.width - margin);
    }
    left = Math.max(margin, left);

    let top = rect.top - popupRect.height - 6;
    if (top < margin) {
      top = Math.min(window.innerHeight - popupRect.height - margin, rect.bottom + 6);
    }

    activePopup.style.left = `${Math.round(left)}px`;
    activePopup.style.top = `${Math.round(top)}px`;
  }

  function closePopup() {
    if (!activePopup) return;
    activePopup.remove();
    activePopup = null;
    const prevBtn = activeTriggerButton;
    activeTriggerButton = null;
    if (prevBtn) updateButtonVisuals(prevBtn);
  }

  async function selectMode(nextMode) {
    const previousMode = settings.mode;
    settings = { ...settings, mode: nextMode };
    syncAllButtons();
    renderPopupContents();
    closePopup();
    try {
      const reply = await sendRpc('mode.set', { mode: nextMode });
      if (reply?.settings) {
        settings = { ...settings, ...reply.settings };
        syncAllButtons();
      }
    } catch {
      settings = { ...settings, mode: previousMode };
      syncAllButtons();
    }
  }

  function renderPopupContents() {
    if (!activePopup) return;
    while (activePopup.firstChild) activePopup.removeChild(activePopup.firstChild);

    const header = document.createElement('div');
    header.className = 'agy-auto-zy-header';
    const titleSpan = document.createElement('span');
    titleSpan.textContent = 'Auto-ZY Permissions';
    header.appendChild(titleSpan);

    const modelPill = document.createElement('span');
    modelPill.className = 'agy-auto-zy-model-pill';
    const dot = document.createElement('span');
    dot.className = 'agy-auto-zy-dot';
    dot.dataset.online = String(Boolean(gatewayOnline));
    modelPill.appendChild(dot);
    const modelText = document.createElement('span');
    const shortModel = String(settings.model || 'ds-flash').replace(/^group\//, '');
    modelText.textContent = `${shortModel} (${settings.reasoning || 'max'})`;
    modelPill.appendChild(modelText);
    header.appendChild(modelPill);
    activePopup.appendChild(header);

    for (const item of MODE_ITEMS) {
      const selected = (settings.mode || 'auto-zy') === item.id;
      const optBtn = document.createElement('button');
      optBtn.type = 'button';
      optBtn.className = 'agy-auto-zy-option';
      optBtn.setAttribute('role', 'menuitemradio');
      optBtn.setAttribute('aria-checked', String(selected));
      optBtn.dataset.selected = String(selected);
      optBtn.dataset.testid = `agy-auto-zy-mode-${item.id}`;

      const iconWrap = document.createElement('span');
      iconWrap.className = 'agy-auto-zy-opt-icon';
      iconWrap.appendChild(createSvgIcon(item.iconType, 17));
      optBtn.appendChild(iconWrap);

      const body = document.createElement('span');
      body.className = 'agy-auto-zy-opt-body';

      const titleRow = document.createElement('span');
      titleRow.className = 'agy-auto-zy-opt-title-row';
      const nameSpan = document.createElement('span');
      nameSpan.textContent = item.title;
      titleRow.appendChild(nameSpan);
      if (item.isDefault) {
        const badge = document.createElement('span');
        badge.className = 'agy-auto-zy-default-badge';
        badge.textContent = 'Default';
        titleRow.appendChild(badge);
      }
      body.appendChild(titleRow);

      const desc = document.createElement('span');
      desc.className = 'agy-auto-zy-opt-desc';
      desc.textContent = item.description;
      body.appendChild(desc);

      optBtn.appendChild(body);
      optBtn.appendChild(createSvgIcon('check', 16, 'agy-auto-zy-check'));

      optBtn.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void selectMode(item.id);
      });

      activePopup.appendChild(optBtn);
    }

    const footer = document.createElement('div');
    footer.className = 'agy-auto-zy-footer';

    const tallyRow = document.createElement('div');
    tallyRow.className = 'agy-auto-zy-tally-row';
    const countsText = document.createElement('span');
    countsText.textContent = `放行 ${tally.allow || 0}   拦截 ${tally.deny || 0}   询问 ${tally.ask || 0}`;
    tallyRow.appendChild(countsText);

    const gwText = document.createElement('span');
    gwText.textContent = activeReviewsCount > 0 ? '审核中…' : gatewayOnline ? 'Magpie 在线' : 'Magpie 离线';
    tallyRow.appendChild(gwText);
    footer.appendChild(tallyRow);

    if (lastDecision && lastDecision.toolName) {
      const lastRow = document.createElement('div');
      lastRow.className = 'agy-auto-zy-last-row';
      const dur = lastDecision.durationMs != null ? ` (${lastDecision.durationMs}ms)` : '';
      lastRow.textContent = `最近: ${lastDecision.toolName} -> ${lastDecision.decision}${dur}`;
      footer.appendChild(lastRow);
    }

    activePopup.appendChild(footer);
  }

  function openPopup(triggerButton) {
    if (activePopup && activeTriggerButton === triggerButton) {
      closePopup();
      return;
    }
    closePopup();
    activeTriggerButton = triggerButton;
    const popup = document.createElement('div');
    popup.className = 'agy-auto-zy-popup';
    popup.setAttribute('role', 'menu');
    popup.dataset.testid = 'agy-auto-zy-menu';
    popup.dataset.agyAutoZyPopup = 'true';
    activePopup = popup;
    renderPopupContents();
    document.body.appendChild(popup);
    updateButtonVisuals(triggerButton);
    positionPopup();

    void sendRpc('status.get')
      .then(reply => {
        if (reply?.settings) settings = { ...settings, ...reply.settings };
        if (reply?.tally) tally = { ...tally, ...reply.tally };
        if (typeof reply?.gatewayOnline === 'boolean') gatewayOnline = reply.gatewayOnline;
        if (typeof reply?.activeReviewsCount === 'number') activeReviewsCount = reply.activeReviewsCount;
        if (reply?.lastDecision !== undefined) lastDecision = reply.lastDecision;
        syncAllButtons();
        if (activePopup) {
          renderPopupContents();
          positionPopup();
        }
      })
      .catch(() => {});
  }

  function findLocalPermissionsAnchor(composerCard) {
    const candidates = [...composerCard.querySelectorAll('button')].filter(
      btn =>
        !btn.closest('[data-agy-auto-zy-root]') &&
        !btn.closest('[data-agy-powertools-root]') &&
        btn.getAttribute('data-testid') !== 'model-selector-trigger'
    );

    let matchedButton =
      candidates.find(btn => /permission/i.test(btn.getAttribute('data-testid') || '')) ||
      candidates.find(btn => {
        const aria = btn.getAttribute('aria-label') || '';
        const title = btn.getAttribute('title') || '';
        const origTitle = btn.getAttribute('data-agy-original-title') || '';
        return (
          PERMISSION_ATTR_REGEX.test(aria) ||
          PERMISSION_ATTR_REGEX.test(title) ||
          PERMISSION_ATTR_REGEX.test(origTitle)
        );
      }) ||
      candidates.find(btn => PERMISSION_PRESET_TEXT_REGEX.test((btn.textContent || '').trim()));

    if (matchedButton) {
      let anchor = matchedButton;
      while (
        anchor.parentElement &&
        anchor.parentElement !== composerCard &&
        !['flex', 'inline-flex'].includes(getComputedStyle(anchor.parentElement).display)
      ) {
        anchor = anchor.parentElement;
      }
      if (anchor.parentElement) {
        return { parent: anchor.parentElement, before: anchor };
      }
    }

    const modelBtn = composerCard.querySelector('[data-testid="model-selector-trigger"]');
    if (modelBtn) {
      let anchor = modelBtn;
      while (
        anchor.parentElement &&
        anchor.parentElement !== composerCard &&
        !['flex', 'inline-flex'].includes(getComputedStyle(anchor.parentElement).display)
      ) {
        anchor = anchor.parentElement;
      }
      if (anchor.parentElement) {
        return { parent: anchor.parentElement, before: anchor.nextSibling };
      }
    }

    return null;
  }

  function mountComposerButtons() {
    if (disposed || !document.body) return;
    if (!styleElement.isConnected && document.head) {
      document.head.appendChild(styleElement);
    }

    if (!settings.showComposerButton) {
      syncAllButtons();
      return;
    }

    const cards = [...document.querySelectorAll('.surface-composer-card')];
    const activeCards = new Set(cards);

    for (const [card, entry] of mountedRoots.entries()) {
      if (!activeCards.has(card) || !card.isConnected) {
        if (activeTriggerButton === entry.button) closePopup();
        entry.mount.remove();
        mountedRoots.delete(card);
      }
    }

    for (const card of cards) {
      const target = findLocalPermissionsAnchor(card);
      if (!target) continue;

      let entry = mountedRoots.get(card);
      if (!entry || !entry.mount.isConnected) {
        entry?.mount?.remove();
        const mount = document.createElement('span');
        mount.dataset.agyAutoZyRoot = 'composer';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agy-auto-zy-btn';
        button.dataset.testid = 'agy-auto-zy-trigger';
        button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          openPopup(button);
        });
        mount.appendChild(button);
        target.parent.insertBefore(mount, target.before || null);
        entry = { mount, button };
        mountedRoots.set(card, entry);
        updateButtonVisuals(button);
      } else if (
        target.before &&
        entry.mount.parentElement === target.parent &&
        entry.mount.nextSibling !== target.before
      ) {
        target.parent.insertBefore(entry.mount, target.before);
      } else if (entry.mount.parentElement !== target.parent) {
        target.parent.insertBefore(entry.mount, target.before || null);
      }
    }
  }

  const eventAbort = new AbortController();
  document.addEventListener(
    'pointerdown',
    event => {
      if (!activePopup) return;
      if (
        event.target?.closest?.('[data-agy-auto-zy-popup]') ||
        event.target === activeTriggerButton ||
        activeTriggerButton?.contains?.(event.target)
      ) {
        return;
      }
      closePopup();
    },
    { capture: true, signal: eventAbort.signal }
  );
  document.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape' && activePopup) {
        event.preventDefault();
        event.stopPropagation();
        closePopup();
      }
    },
    { capture: true, signal: eventAbort.signal }
  );
  window.addEventListener('resize', () => { if (activePopup) positionPopup(); }, { signal: eventAbort.signal });
  window.addEventListener('scroll', () => { if (activePopup) positionPopup(); }, { capture: true, signal: eventAbort.signal });

  let mountTimer = null;
  const domObserver = new MutationObserver(records => {
    if (
      records.every(record =>
        record.target?.closest?.('[data-agy-auto-zy-root],[data-agy-auto-zy-popup]')
      )
    ) {
      return;
    }
    clearTimeout(mountTimer);
    mountTimer = setTimeout(mountComposerButtons, 30);
  });

  function boot() {
    if (disposed) return;
    if (!document.head || !document.body) {
      setTimeout(boot, 120);
      return;
    }
    mountComposerButtons();
    domObserver.observe(document.body, { childList: true, subtree: true });
    void sendRpc('status.get')
      .then(reply => {
        if (reply?.settings) settings = { ...settings, ...reply.settings };
        if (reply?.tally) tally = { ...tally, ...reply.tally };
        if (typeof reply?.gatewayOnline === 'boolean') gatewayOnline = reply.gatewayOnline;
        if (typeof reply?.activeReviewsCount === 'number') activeReviewsCount = reply.activeReviewsCount;
        if (reply?.lastDecision !== undefined) lastDecision = reply.lastDecision;
        syncAllButtons();
      })
      .catch(() => {});
  }

  globalThis.__agyAutoZy = {
    version: pluginVersion,
    get healthy() {
      if (disposed) return false;
      const expectedCards = settings.showComposerButton
        ? document.querySelectorAll('.surface-composer-card').length
        : 0;
      const mountedCount = document.querySelectorAll('[data-testid="agy-auto-zy-trigger"]').length;
      return expectedCards === 0 || mountedCount >= expectedCards;
    },
    get stats() {
      return {
        mode: settings.mode,
        mountedButtons: document.querySelectorAll('[data-testid="agy-auto-zy-trigger"]').length,
        tally: { ...tally }
      };
    },
    dispose() {
      disposed = true;
      closePopup();
      eventAbort.abort();
      domObserver.disconnect();
      clearTimeout(mountTimer);
      for (const [, entry] of mountedRoots) {
        entry.mount.remove();
      }
      mountedRoots.clear();
      styleElement.remove();
      for (const [, call] of pendingCalls) {
        clearTimeout(call.timer);
        call.reject(new Error('Disposed'));
      }
      pendingCalls.clear();
      delete globalThis.__agyAutoZy;
      delete globalThis.__agyAutoZyReceive;
      delete globalThis.__agyAutoZyPush;
    }
  };

  boot();
})();
