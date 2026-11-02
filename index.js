/**
 * DOM Window 0.4.2
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

  const VERSION = '0.4.2';
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
    // 回收视口外楼层时需要留出的安全距离（视口高度的倍数）。
    // 太小会让刚挂上的楼层立刻被回收，形成反复重建。
    trimFactor: 2,
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
    forceApply: false,
    tailRef: null,
    // 自己刷新补发的 message_rendered：楼层号 -> 过期时刻。
    // 用一个固定时长的总计时器靠不住——机器忙、iframe 多时事件会晚到，
    // 漏判一次就会重排，重排又刷新，形成源码/渲染来回闪的死循环。
    selfRenders: new Map(),
    sweepTimer: 0,
  };

  const SELF_RENDER_TTL = 20000;
  const SWEEP_INTERVAL = 5000;

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

  // 记下由本插件亲手挂上去的楼层元素：这些才需要补发渲染事件。
  // 酒馆自己渲染的新楼层已经完整拉过一次界面，再刷新就是白白闪一次。
  const mountedByUs = new WeakSet();

  function mountMessage(id, { beforeId, afterId } = {}) {
    const ctx = getCtx();
    const mes = ctx?.chat?.[id];
    if (!mes) return null;
    // 酒馆可能已经把这一层挂上去了（新消息就是它自己渲染的），
    // 再 addOneMessage 一次会出两个同 mesid 的楼层。
    const existing = getChatEl()?.querySelector(`:scope > .mes[mesid="${id}"]`);
    if (existing) return { el: existing, created: false };
    const opts = { forceId: id, scroll: false };
    if (typeof beforeId === 'number') opts.insertBefore = beforeId;
    else if (typeof afterId === 'number') opts.insertAfter = afterId;
    const result = ctx.addOneMessage(mes, opts);
    const el = result?.[0] || result?.get?.(0) || null;
    if (el) mountedByUs.add(el);
    return el ? { el, created: true } : null;
  }

  // addOneMessage 只重建正文，不会补发消息渲染事件；酒馆助手的楼层界面
  // 依赖该事件生成 iframe，所以重新挂载后要主动刷新一次。
  function hasFrontendBlock(mes) {
    const text = String(mes?.mes || '');
    return /PlaceHolder|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
  }

  function refreshMountedMessages(ids, { force = false } = {}) {
    const helper = window.TavernHelper;
    const refresh = helper?.refreshOneMessage;
    if (typeof refresh !== 'function') return;

    // 默认只刷新自己挂上去的楼层。酒馆自己渲染的新楼层界面是完整的，
    // 再刷一次等于让用户多看见一闪。
    // force 用于关闭窗口后的全量恢复：那时楼层已被 printMessages 重印，
    // 不出自本插件，但界面确实需要补回来。
    const targets = ids.filter(id => {
      if (!hasFrontendBlock(getChat()[id])) return false;
      if (force) return true;
      const el = getChatEl()?.querySelector(`:scope > .mes[mesid="${id}"]`);
      return el ? mountedByUs.has(el) : false;
    });
    if (!targets.length) return;

    // 刷新会补发 message_rendered，事件是异步派发的；按楼层号记下过期时刻，
    // 避免 DOMWindow 把自己的补渲染当成外部更新又重排一次。
    const expires = Date.now() + SELF_RENDER_TTL;
    for (const id of targets) state.selfRenders.set(Number(id), expires);
    armSweep();

    for (const id of targets) {
      safe(() => {
        const promise = refresh.call(helper, id);
        if (promise?.catch) {
          promise.catch(err => console.warn(LOG, 'refresh message', id, err));
        }
      }, 'refresh message');
    }
  }

  // 每条自刷新独立记时（不是整批共用一个定时器），过期后清掉，避免长期占用内存。
  function armSweep() {
    if (state.sweepTimer) return;
    state.sweepTimer = setInterval(() => {
      const now = Date.now();
      let alive = 0;
      for (const [key, expires] of state.selfRenders) {
        if (expires > now) alive++;
        else state.selfRenders.delete(key);
      }
      if (!alive) {
        clearInterval(state.sweepTimer);
        state.sweepTimer = 0;
      }
    }, SWEEP_INTERVAL);
  }

  function isSelfRender(id) {
    const key = Number(id);
    const expires = state.selfRenders.get(key);
    if (expires == null) return false;
    if (expires < Date.now()) {
      state.selfRenders.delete(key);
      return false;
    }
    return true;
  }

  function clearSelfRenders() {
    state.selfRenders.clear();
    clearInterval(state.sweepTimer);
    state.sweepTimer = 0;
  }

  function refreshAllMounted() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const ids = [...chatEl.querySelectorAll(':scope > .mes')]
      .map(el => Number(el.getAttribute('mesid')))
      .filter(Number.isFinite);
    refreshMountedMessages(ids, { force: true });
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

  // 未挂载楼层用实测均值估高。写死的 defaultHeight（4800）和这张卡的实际
  // 楼层高度差得远，估出来的占位会让滚动位置一跳一跳，落回去又触发新一轮加载。
  function estimateHeight() {
    if (!state.heights.size) return config.defaultHeight;
    let total = 0;
    for (const height of state.heights.values()) total += height;
    return total / state.heights.size;
  }

  function sumHeights(from, to) {
    if (to < from) return 0;
    const fallback = estimateHeight();
    let total = 0;
    for (let i = from; i <= to; i++) total += state.heights.get(i) ?? fallback;
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

  // 窗口内容已和 chat 对齐时直接返回，避免进场时 ST 的两次渲染事件各掀一次整窗重建。
  // 光比楼层号不够：换聊天后楼层号可能刚好一样，必须认消息对象本身。
  // 同一份 chat 里消息对象不会换，换聊天/重载会整批换成新对象。
  function windowMatchesChat() {
    const chatEl = getChatEl();
    const chat = getChat();
    if (!state.mounted || !chatEl || !chat.length) return false;
    if (!state.topSpacer?.isConnected || !state.bottomSpacer?.isConnected) return false;
    if (state.pinnedId !== chat.length - 1) return false;
    if (chat[state.pinnedId] !== state.tailRef) return false;

    const ids = [...chatEl.querySelectorAll(':scope > .mes')]
      .map(el => Number(el.getAttribute('mesid')))
      .filter(Number.isFinite);
    const expected = state.end - state.start + 2; // 窗口内 + 固定的最后一层
    if (ids.length !== expected) return false;
    for (let i = state.start; i <= state.end; i++) {
      if (!ids.includes(i)) return false;
    }
    return ids.includes(state.pinnedId);
  }

  function apply(force = false) {
    if (!state.enabled || state.applying) return false;
    const ctx = getCtx();
    const chat = ctx?.chat;
    const chatEl = getChatEl();
    if (!ctx || !chat?.length || !chatEl) return false;
    if (!force && windowMatchesChat()) return false;

    state.applying = true;
    state.chatEl = chatEl;
    state.pinnedId = chat.length - 1;
    state.heights.clear();
    clearWindow();

    const start = Math.max(0, state.pinnedId - (config.minWindow - 1));
    const end = state.pinnedId - 1;
    state.start = start;
    state.end = end;

    // created=false 的是酒馆已经挂好的楼层，界面完整，不需要再刷新
    const mountedIds = [];
    const collect = (id) => {
      const res = mountMessage(id);
      if (res?.created) mountedIds.push(id);
      return !!res;
    };
    for (let i = start; i <= end; i++) collect(i);
    collect(state.pinnedId);
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
    state.tailRef = chat[state.pinnedId] ?? null;
    log('applied', { chatLength: chat.length, start, end, pinnedId: state.pinnedId });
    return true;
  }

  function scheduleApply(delay = 120, force = false) {
    if (!state.enabled) return;
    state.forceApply = state.forceApply || force;
    clearTimeout(state.applyTimer);
    state.applyTimer = setTimeout(() => {
      state.applyTimer = 0;
      const forced = state.forceApply;
      state.forceApply = false;
      apply(forced);
    }, delay);
  }

  // 追加新楼层时只补挂尾部，不整窗重建。
  // 整窗重建会先删掉所有 .mes 再逐个 addOneMessage，画面就是「源码 → 渲染」闪一次；
  // 每来一条回复都闪一次太难看，所以窗口完好、只多了几层时走这条路。
  function syncTail() {
    const chatEl = getChatEl();
    const chat = getChat();
    if (!chatEl || !state.mounted || state.applying) return false;
    if (!state.topSpacer?.isConnected || !state.bottomSpacer?.isConnected) return false;

    const newPinned = chat.length - 1;
    if (newPinned <= state.pinnedId) return false;

    const mountedIds = [];
    let afterId = state.pinnedId;
    for (let id = state.pinnedId + 1; id <= newPinned; id++) {
      const res = mountMessage(id, { afterId });
      if (!res) {
        // 中途失败就退回去走整窗重建，别留半截窗口
        for (const done of mountedIds) {
          chatEl.querySelector(`.mes[mesid="${done}"]`)?.remove();
        }
        return false;
      }
      if (res.created) mountedIds.push(id);
      afterId = id;
    }

    state.end = newPinned - 1;
    state.pinnedId = newPinned;
    state.tailRef = chat[newPinned] ?? null;
    const pinnedEl = chatEl.querySelector(`.mes[mesid="${newPinned}"]`);
    if (!pinnedEl) return false;
    pinnedEl.before(state.bottomSpacer);
    refreshMountedMessages(mountedIds);
    measureMounted();
    updateSpacers();
    trim();
    return true;
  }

  // 外部真的渲染了某层（不是我们刷新的）时才动窗口。
  // 楼层号在窗口外的渲染不需要重排，否则任何无关楼层的事件都会掀起一次整窗重建。
  function handleExternalRender(id) {
    if (!state.mounted) {
      scheduleApply(250);
      return;
    }
    const length = getChat().length;
    if (length > state.pinnedId + 1) {
      if (!syncTail()) scheduleApply(250);
      return;
    }
    if (length < state.pinnedId + 1) {
      scheduleApply(250);
      return;
    }
    if (Number(id) < state.start) return;
    measureMounted();
    updateSpacers();
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
    // 记住锚点楼层和它在视口里的位置，挂完新楼层后把它挪回原位，
    // 这样占位估得准不准都不会让画面跳。
    const anchorTop = firstEl.getBoundingClientRect().top;

    const mountedIds = [];
    for (let i = newStart; i < state.start; i++) {
      const res = mountMessage(i, { beforeId });
      if (res?.created) mountedIds.push(i);
    }

    state.start = newStart;
    // trim() 只回收视口外太远的楼层，且受 maxWindow 约束；这里先不回收，
    // 让锚点位移修正跑完再统一 trim，避免刚挂上就被删。
    refreshMountedMessages(mountedIds);
    measureMounted();
    updateSpacers();

    const anchorEl = chatEl.querySelector(`.mes[mesid="${beforeId}"]`);
    if (anchorEl) chatEl.scrollTop += anchorEl.getBoundingClientRect().top - anchorTop;
  }

  function appendBatch() {
    const chatEl = getChatEl();
    if (!chatEl) return;
    const newEnd = Math.min(state.pinnedId - 1, state.end + config.batch);
    if (newEnd <= state.end) return;

    let afterId = state.end;
    const mountedIds = [];
    for (let i = state.end + 1; i <= newEnd; i++) {
      const res = mountMessage(i, { afterId });
      if (!res) break;
      if (res.created) mountedIds.push(i);
      afterId = i;
    }

    state.end = newEnd;
    refreshMountedMessages(mountedIds);
    measureMounted();
    updateSpacers();
  }

  // 回收视口外的楼层。
  // 关键点：只能回收「离视口很远」的楼层。原来的判据是 0.25 个视口，
  // 上滚时刚补上的楼层正好落在这个范围里，删掉后下一帧又补回来，
  // 同一层反复重建，画面就在源码和渲染之间来回闪。
  function removeEdge(side) {
    const chatEl = getChatEl();
    if (!chatEl) return false;
    const id = side === 'top' ? state.start : state.end;
    if (side === 'top' && state.start > state.end) return false;

    const el = chatEl.querySelector(`:scope > .mes[mesid="${id}"]`);
    if (!el) {
      // 已经不在 DOM 里，只同步指针
      if (side === 'top') state.start++;
      else state.end--;
      return true;
    }

    const rect = el.getBoundingClientRect();
    const chatRect = chatEl.getBoundingClientRect();
    const margin = chatEl.clientHeight * config.trimFactor;
    const far = side === 'top'
      ? rect.bottom < chatRect.top - margin
      : rect.top > chatRect.bottom + margin;
    if (!far) return false;

    state.heights.set(id, rect.height);
    el.remove();
    if (side === 'top') state.start++;
    else state.end--;
    return true;
  }

  function countWindow() {
    return state.end - state.start + 1;
  }

  function trim() {
    let guard = 0;
    while (countWindow() > config.maxWindow && guard++ < 40) {
      if (!removeEdge('top') && !removeEdge('bottom')) break;
    }
    updateSpacers();
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
      const res = mountMessage(id, { beforeId: state.start });
      if (res?.created) refreshMountedMessages([id]);
      state.start = Math.min(state.start, id);
    } else if (id > state.end && id !== state.pinnedId) {
      const res = mountMessage(id, { afterId: state.end });
      if (res?.created) refreshMountedMessages([id]);
      state.end = Math.max(state.end, id);
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

    // 进入聊天时 ST 也会发 CHAT_CHANGED，但那时挂的就是这份 chat；
    // 只有最后一层换了对象才是真的换聊天，才值得强制重建。
    on('CHAT_CHANGED', () => {
      const ctx = getCtx();
      const last = ctx?.chat?.[ctx.chat.length - 1] ?? null;
      scheduleApply(300, last !== state.tailRef);
    });
    on('CHARACTER_MESSAGE_RENDERED', id => {
      if (!isSelfRender(id)) handleExternalRender(id);
    });
    on('USER_MESSAGE_RENDERED', id => {
      if (!isSelfRender(id)) handleExternalRender(id);
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
    clearSelfRenders();

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
    clearSelfRenders();
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