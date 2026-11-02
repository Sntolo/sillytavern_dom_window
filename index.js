/**
 * DOM Window 0.4.1
 *
 * 只窗口化 ST 的消息 DOM，不改 chat 数据。
 * - chat 数组保持完整，AI 上下文、存档、消息 ID 不变。
 * - #chat 里只保留视口附近的 .mes，远处用上下占位撑住滚动高度。
 * - 最后一条消息固定挂载，保证 .last_mes 相关功能正常。
 * - 默认不启用，控制台执行 STDOMWindow.enable() 或 localStorage.STDOMWindow = '1'。
 *
 * 兼容接口：
 * - STDOMWindow.getChat() 返回完整 chat
 * - STDOMWindow.getMessageElement(mesid) 按需挂载某一层
 */
(() => {
  'use strict';

  const VERSION = '0.4.1';
  const LOG = '[DOMWindow]';
  const EXTENSION_BASE = new URL('.', import.meta.url).href;
  const STORAGE_KEY = 'STDOMWindow';
  const TRUNCATION_KEY = 'STDOMWindow.originalTruncation';
  const PRELOAD_KEY = 'STDOMWindow.preload';
  const DEFAULT_PRELOAD = 5;
  const MAX_PRELOAD = 100;
  const FALLBACK_EVENTS = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_UPDATED: 'message_updated',
    MESSAGE_SWIPED: 'message_swiped',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
  };

  const config = {
    minWindow: 5,
    maxWindow: 9,
    batch: 2,
    defaultHeight: 4800,
    nearViewportFactor: 1.5,
    manageTruncation: false,
    debug: false,
  };

  const state = {
    enabled: false,
    mounted: false,
    chatEl: null,
    topSpacer: null,
    bottomSpacer: null,
    heights: new Map(),
    start: 0,
    end: 0,
    pinnedId: null,
    scrollRaf: 0,
    applyTimer: 0,
    eventSource: null,
    eventTypes: null,
    listeners: [],
    originalTruncation: null,
    applying: false,
    syntheticIds: new Set(),
    syntheticTimer: 0,
  };

  const log = (...args) => console.debug(LOG, ...args);

  function getCtx() {
    try {
      return window.SillyTavern?.getContext?.() || null;
    } catch {
      return null;
    }
  }

  function getChat() {
    return getCtx()?.chat || [];
  }

  function getChatEl() {
    return state.chatEl || document.querySelector('#chat');
  }

  function safe(fn, label = 'task') {
    try {
      return fn();
    } catch (err) {
      console.warn(LOG, label, err);
      return undefined;
    }
  }

  function createSpacer(side) {
    const el = document.createElement('div');
    el.className = `dom-window-spacer dom-window-${side}`;
    el.setAttribute('data-dom-window', side);
    el.style.cssText = 'display:block;width:100%;flex:0 0 auto;pointer-events:none;';
    return el;
  }

  function mountMessage(id, { beforeId, afterId } = {}) {
    const ctx = getCtx();
    const mes = ctx?.chat?.[id];
    if (!mes) return null;
    const opts = { forceId: id, scroll: false };
    if (typeof beforeId === 'number') opts.insertBefore = beforeId;
    else if (typeof afterId === 'number') opts.insertAfter = afterId;
    const result = ctx.addOneMessage(mes, opts);
    return result?.[0] || result?.get?.(0) || null;
  }

  // addOneMessage 只重建正文，不会补发消息渲染事件；酒馆助手的楼层界面
  // 依赖该事件生成 iframe，所以重新挂载后要主动刷新一次。
  function hasFrontendBlock(mes) {
    const text = String(mes?.mes || '');
    return /PlaceHolder|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
  }

  function refreshMountedMessages(ids) {
    const helper = window.TavernHelper;
    const refresh = helper?.refreshOneMessage;
    if (typeof refresh !== 'function') return;

    const targets = ids.filter(id => hasFrontendBlock(getChat()[id]));
    if (!targets.length) return;

    // 刷新会补发 message_rendered，事件是异步派发的；按楼层号标记，
    // 避免 DOMWindow 把自己的补渲染当成外部更新又重排一次。
    for (const id of targets) state.syntheticIds.add(id);
    clearTimeout(state.syntheticTimer);
    state.syntheticTimer = setTimeout(() => state.syntheticIds.clear(), 1000);

    for (const id of targets) {
      safe(() => {
        const promise = refresh.call(helper, id);
        if (promise?.catch) {
          promise.catch(err => console.warn(LOG, 'refresh message', id, err));
        }
      }, 'refresh message');
    }
  }

  function refreshAllMounted() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const ids = [...chatEl.querySelectorAll(':scope > .mes')]
      .map(el => Number(el.getAttribute('mesid')))
      .filter(Number.isFinite);
    refreshMountedMessages(ids);
  }

  function measureMounted() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    for (const el of chatEl.querySelectorAll(':scope > .mes')) {
      const id = Number(el.getAttribute('mesid'));
      if (!Number.isFinite(id)) continue;
      const height = el.getBoundingClientRect().height;
      if (height > 0) state.heights.set(id, height);
    }
  }

  function sumHeights(from, to) {
    if (to < from) return 0;
    let total = 0;
    for (let i = from; i <= to; i++) total += state.heights.get(i) ?? config.defaultHeight;
    return total;
  }

  function updateSpacers() {
    if (state.topSpacer) {
      state.topSpacer.style.height = `${sumHeights(0, state.start - 1)}px`;
    }
    if (state.bottomSpacer) {
      state.bottomSpacer.style.height = `${sumHeights(state.end + 1, state.pinnedId - 1)}px`;
    }
  }

  function clearWindow() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    chatEl
      .querySelectorAll(':scope > .mes, :scope > .dom-window-spacer, #show_more_messages')
      .forEach(el => el.remove());
    state.topSpacer = null;
    state.bottomSpacer = null;
  }

  function apply() {
    if (!state.enabled || state.applying) return false;
    const ctx = getCtx();
    const chat = ctx?.chat;
    const chatEl = getChatEl();
    if (!ctx || !chat?.length || !chatEl) return false;

    state.applying = true;
    state.chatEl = chatEl;
    state.pinnedId = chat.length - 1;
    state.heights.clear();
    clearWindow();

    const start = Math.max(0, state.pinnedId - (config.minWindow - 1));
    const end = state.pinnedId - 1;
    state.start = start;
    state.end = end;

    const mountedIds = [];
    for (let i = start; i <= end; i++) {
      if (mountMessage(i)) mountedIds.push(i);
    }
    if (mountMessage(state.pinnedId)) mountedIds.push(state.pinnedId);
    refreshMountedMessages(mountedIds);

    state.topSpacer = createSpacer('top');
    chatEl.prepend(state.topSpacer);

    state.bottomSpacer = createSpacer('bottom');
    const pinnedEl = chatEl.querySelector(`.mes[mesid="${state.pinnedId}"]`);
    if (pinnedEl) pinnedEl.before(state.bottomSpacer);
    else chatEl.append(state.bottomSpacer);

    measureMounted();
    updateSpacers();
    chatEl.scrollTop = chatEl.scrollHeight;
    state.applying = false;
    state.mounted = true;
    log('applied', { chatLength: chat.length, start, end, pinnedId: state.pinnedId });
    return true;
  }

  function scheduleApply(delay = 120) {
    if (!state.enabled) return;
    clearTimeout(state.applyTimer);
    state.applyTimer = setTimeout(() => {
      state.applyTimer = 0;
      apply();
    }, delay);
  }

  function prependBatch() {
    const ctx = getCtx();
    const chatEl = getChatEl();
    if (!ctx || !chatEl) return;
    const newStart = Math.max(0, state.start - config.batch);
    if (newStart >= state.start) return;

    const firstEl = chatEl.querySelector(`.mes[mesid="${state.start}"]`);
    if (!firstEl) return;
    const beforeId = state.start;

    let estimated = 0;
    for (let i = newStart; i < state.start; i++) {
      estimated += state.heights.get(i) ?? config.defaultHeight;
    }

    const mountedIds = [];
    for (let i = newStart; i < state.start; i++) {
      if (mountMessage(i, { beforeId })) mountedIds.push(i);
    }

    state.start = newStart;
    refreshMountedMessages(mountedIds);

    let added = 0;
    for (const id of mountedIds) {
      const el = chatEl.querySelector(`.mes[mesid="${id}"]`);
      if (el) added += el.getBoundingClientRect().height;
    }
    measureMounted();
    updateSpacers();
    // 新楼层实际高度和占位估算不同时，修正滚动位置，避免视口跳动。
    if (Math.abs(added - estimated) > 4) {
      chatEl.scrollTop += added - estimated;
    }
  }

  function appendBatch() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const newEnd = Math.min(state.pinnedId - 1, state.end + config.batch);
    if (newEnd <= state.end) return;

    let afterId = state.end;
    const mountedIds = [];
    for (let i = state.end + 1; i <= newEnd; i++) {
      const el = mountMessage(i, { afterId });
      if (!el) break;
      mountedIds.push(i);
      afterId = i;
    }

    state.end = newEnd;
    refreshMountedMessages(mountedIds);
    measureMounted();
    updateSpacers();
  }

  function trim() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const viewport = chatEl.clientHeight;
    const chatTop = chatEl.getBoundingClientRect().top;
    const visibleTop = chatTop + viewport * 0.25;
    const visibleBottom = chatTop + viewport * 1.25;

    let guard = 0;
    while (state.end - state.start + 1 > config.maxWindow && guard++ < 20) {
      const topEl = chatEl.querySelector(`.mes[mesid="${state.start}"]`);
      if (!topEl) break;
      const rect = topEl.getBoundingClientRect();
      if (rect.bottom > visibleTop) break;
      state.heights.set(state.start, rect.height);
      topEl.remove();
      state.start++;
      updateSpacers();
    }

    guard = 0;
    while (state.end - state.start + 1 > config.maxWindow && guard++ < 20) {
      const bottomEl = chatEl.querySelector(`.mes[mesid="${state.end}"]`);
      if (!bottomEl) break;
      const rect = bottomEl.getBoundingClientRect();
      if (rect.top < visibleBottom) break;
      state.heights.set(state.end, rect.height);
      bottomEl.remove();
      state.end--;
      updateSpacers();
    }
  }

  function onScroll() {
    if (!state.enabled || state.applying) return;
    if (state.scrollRaf) return;
    state.scrollRaf = requestAnimationFrame(() => {
      state.scrollRaf = 0;
      const chatEl = getChatEl();
      if (!chatEl) return;
      const viewport = chatEl.clientHeight;
      const topHeight = state.topSpacer?.offsetHeight || 0;
      const bottomHeight = state.bottomSpacer?.offsetHeight || 0;
      const nearTop = chatEl.scrollTop < topHeight + viewport * config.nearViewportFactor;
      const nearBottom =
        chatEl.scrollTop + viewport >
        chatEl.scrollHeight - bottomHeight - viewport * config.nearViewportFactor;

      if (nearTop && state.start > 0) prependBatch();
      else if (nearBottom && state.end < state.pinnedId - 1) appendBatch();
      trim();
    });
  }

  function getMessageElement(mesid) {
    const id = Number(mesid);
    const chatEl = getChatEl();
    if (!chatEl || !Number.isFinite(id)) return null;
    const existing = chatEl.querySelector(`.mes[mesid="${id}"]`);
    if (existing) return existing;

    const chat = getChat();
    if (id < 0 || id >= chat.length) return null;

    if (id < state.start) {
      if (mountMessage(id, { beforeId: state.start })) refreshMountedMessages([id]);
    } else if (id > state.end && id !== state.pinnedId) {
      if (mountMessage(id, { afterId: state.end })) refreshMountedMessages([id]);
    }
    measureMounted();
    updateSpacers();
    return chatEl.querySelector(`.mes[mesid="${id}"]`);
  }

  function checkWindowIntegrity() {
    if (!state.enabled) return;
    const chatEl = getChatEl();
    if (!chatEl) return;
    if (chatEl.querySelectorAll(':scope > .mes').length > config.maxWindow + 5) {
      scheduleApply(100);
    }
  }

  function bindEvents() {
    const ctx = getCtx();
    const chatEl = getChatEl();
    if (!ctx || !chatEl) return;
    state.chatEl = chatEl;
    state.eventSource = ctx.eventSource || window.eventSource || null;
    state.eventTypes = ctx.event_types || ctx.eventTypes || {};
    if (!state.eventSource?.on) {
      console.warn(LOG, 'eventSource unavailable, window will only work on manual apply');
      return;
    }

    const on = (key, handler) => {
      const event = state.eventTypes?.[key] || FALLBACK_EVENTS[key];
      if (!event) return;
      state.eventSource.on(event, handler);
      state.listeners.push({ event, handler });
    };

    on('CHAT_CHANGED', () => scheduleApply(300));
    on('CHARACTER_MESSAGE_RENDERED', id => {
      if (!state.syntheticIds.has(Number(id))) scheduleApply(250);
    });
    on('USER_MESSAGE_RENDERED', id => {
      if (!state.syntheticIds.has(Number(id))) scheduleApply(250);
    });
    on('MESSAGE_DELETED', () => scheduleApply(250));
    on('MORE_MESSAGES_LOADED', () => scheduleApply(250));
    on('MESSAGE_UPDATED', () => {
      measureMounted();
      updateSpacers();
      checkWindowIntegrity();
    });
    on('MESSAGE_SWIPED', () => {
      measureMounted();
      updateSpacers();
      checkWindowIntegrity();
    });

    chatEl.addEventListener('scroll', onScroll, { passive: true });
  }

  function unbindEvents() {
    for (const { event, handler } of state.listeners) {
      safe(() => {
        if (typeof state.eventSource?.removeListener === 'function') {
          state.eventSource.removeListener(event, handler);
        } else if (typeof state.eventSource?.off === 'function') {
          state.eventSource.off(event, handler);
        }
      }, 'unbind');
    }
    state.listeners = [];
    safe(() => getChatEl()?.removeEventListener('scroll', onScroll), 'unbind-scroll');
  }

  function enable(options = {}) {
    if (state.enabled) return true;
    const ctx = getCtx();
    if (!ctx?.chat) {
      setTimeout(() => enable(options), 200);
      return false;
    }

    Object.assign(config, options || {});
    state.enabled = true;
    state.pinnedId = ctx.chat.length - 1;
    clearTimeout(state.syntheticTimer);
    state.syntheticIds.clear();

    if (config.manageTruncation) {
      const current = ctx.powerUserSettings?.chat_truncation ?? null;
      state.originalTruncation = current;
      if (current != null && localStorage.getItem(TRUNCATION_KEY) == null) {
        localStorage.setItem(TRUNCATION_KEY, String(current));
      }
      if (ctx.powerUserSettings) {
        ctx.powerUserSettings.chat_truncation = config.maxWindow + 10;
        ctx.saveSettingsDebounced?.();
      }
    }

    bindEvents();
    apply();
    return true;
  }

  function disable() {
    if (!state.enabled) return;
    state.enabled = false;
    clearTimeout(state.syntheticTimer);
    state.syntheticIds.clear();
    clearTimeout(state.applyTimer);
    state.applyTimer = 0;
    if (state.scrollRaf) cancelAnimationFrame(state.scrollRaf);
    state.scrollRaf = 0;
    unbindEvents();
    clearWindow();
    state.mounted = false;

    const ctx = getCtx();
    let restore = state.originalTruncation;
    if (restore == null) {
      const stored = localStorage.getItem(TRUNCATION_KEY);
      if (stored != null && Number.isFinite(Number(stored))) restore = Number(stored);
    }
    if (restore != null && ctx?.powerUserSettings) {
      ctx.powerUserSettings.chat_truncation = restore;
      ctx.saveSettingsDebounced?.();
      state.originalTruncation = null;
      localStorage.removeItem(TRUNCATION_KEY);
    }
    const printed = safe(() => ctx?.printMessages?.(), 'restore rendering');
    if (printed?.then) printed.then(refreshAllMounted);
    else refreshAllMounted();
  }

  function audit() {
    const chatEl = getChatEl();
    const chat = getChat();
    return {
      version: VERSION,
      enabled: state.enabled,
      mounted: state.mounted,
      chatLength: chat.length,
      start: state.start,
      end: state.end,
      pinnedId: state.pinnedId,
      messagesInDom: chatEl?.querySelectorAll(':scope > .mes').length ?? 0,
      topSpacer: state.topSpacer?.offsetHeight ?? 0,
      bottomSpacer: state.bottomSpacer?.offsetHeight ?? 0,
      heightCache: state.heights.size,
      domNodes: document.querySelectorAll('*').length,
      lastMes: chatEl?.querySelector('.last_mes')?.getAttribute('mesid') ?? null,
    };
  }

  const api = {
    version: VERSION,
    config,
    enable,
    disable,
    apply,
    audit,
    getChat,
    getMessageElement,
    get enabled() {
      return state.enabled;
    },
  };

  window.STDOMWindow = api;

  function getPreloadSize() {
    const raw = Number(localStorage.getItem(PRELOAD_KEY));
    if (!Number.isFinite(raw) || raw < 1) return DEFAULT_PRELOAD;
    return Math.min(MAX_PRELOAD, Math.trunc(raw));
  }

  function getAutoOptions() {
    const size = getPreloadSize();
    return { minWindow: size, maxWindow: Math.max(9, size), batch: 2, manageTruncation: true };
  }

  function isAutoEnabled() {
    return localStorage.getItem(STORAGE_KEY) === '1';
  }

  function setAutoEnabled(on) {
    localStorage.setItem(STORAGE_KEY, on ? '1' : '0');
  }

  async function confirmReload() {
    try {
      const { callGenericPopup, POPUP_TYPE } = await import('/scripts/popup.js');
      const result = await callGenericPopup('保存后刷新生效', POPUP_TYPE.CONFIRM, '', {
        okButton: '确认',
        cancelButton: '取消',
      });
      return !!result;
    } catch (err) {
      console.warn(LOG, 'popup failed', err);
      return window.confirm('保存后刷新生效');
    }
  }

  async function initSettingsPanel() {
    if (document.getElementById('dom_window_settings')) return;
    const container = document.getElementById('extensions_settings');
    if (!container) return;

    try {
      const response = await fetch(`${EXTENSION_BASE}settings.html`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      container.insertAdjacentHTML('beforeend', await response.text());

      const checkbox = document.getElementById('dom_window_autostart');
      if (!checkbox) return;
      checkbox.checked = isAutoEnabled();
      checkbox.addEventListener('change', () => {
        const on = checkbox.checked;
        setAutoEnabled(on);
        if (on) enable(getAutoOptions());
        else disable();
      });

      const preloadInput = document.getElementById('dom_window_preload');
      const saveButton = document.getElementById('dom_window_preload_save');
      if (preloadInput) preloadInput.value = String(getPreloadSize());
      if (saveButton && preloadInput) {
        saveButton.addEventListener('click', async () => {
          const raw = Number(preloadInput.value);
          const size = Number.isFinite(raw) && raw >= 1
            ? Math.min(MAX_PRELOAD, Math.trunc(raw))
            : DEFAULT_PRELOAD;
          preloadInput.value = String(size);
          localStorage.setItem(PRELOAD_KEY, String(size));
          if (await confirmReload()) {
            location.reload();
          } else {
            window.toastr?.info('已保存，刷新后生效');
          }
        });
      }
    } catch (err) {
      console.warn(LOG, 'settings panel failed', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initSettingsPanel);
  } else {
    initSettingsPanel();
  }

  const statusStartedAt = performance.now();

  function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return [hours, minutes, seconds].map(value => String(value).padStart(2, '0')).join(':');
  }

  function formatMemory(bytes) {
    if (!Number.isFinite(bytes)) return '—';
    return `${Math.round(bytes / 1048576)} MB`;
  }

  function updateStatusPanel() {
    const statusEl = document.getElementById('dom_window_status');
    if (!statusEl) return;

    const chat = getChat();
    const chatEl = getChatEl();
    const mounted = chatEl?.querySelectorAll(':scope > .mes').length ?? 0;
    const enabled = state.enabled;
    const active = enabled && state.mounted && state.pinnedId != null && state.pinnedId >= 0;
    const range = active ? `${state.start}–${state.pinnedId}（${mounted} 层）` : '—';
    const memory = performance.memory?.usedJSHeapSize;
    const nodes = document.getElementsByTagName('*').length;
    const stateText = !enabled ? '已关闭' : active ? '已开启' : '等待挂载';

    document.getElementById('dom_window_timer').textContent =
      `运行 ${formatDuration(performance.now() - statusStartedAt)}`;
    document.getElementById('dom_window_state').textContent = stateText;
    statusEl.dataset.enabled = String(enabled);
    document.getElementById('dom_window_metrics').textContent =
      `窗口 ${range} · 已加载 ${mounted}/${chat.length} 层\nDOM ${nodes} · 堆内存 ${formatMemory(memory)}`;

    const badge = document.getElementById('dom_window_header_state');
    if (badge) badge.textContent = !enabled ? '已关闭' : active ? `已开启 · ${mounted} 层` : '等待挂载';
  }

  setInterval(updateStatusPanel, 1000);
  updateStatusPanel();

  if (location.search.includes('domwindow=1') || isAutoEnabled()) {
    setTimeout(() => {
      if (location.search.includes('domwindow=1') || isAutoEnabled()) {
        enable(getAutoOptions());
      }
    }, 1200);
  }

  log('loaded', VERSION);
})();