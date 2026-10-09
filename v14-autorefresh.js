/**
 * v14-autorefresh.js — 【B5】手动刷新浮层（原「10 分钟自动刷客户端」已停用）
 * =========================================================================
 * 引入方式（页面 </body> 前一行）：
 *   <script src="/v14-autorefresh.js" defer></script>
 *
 * ⚠️ 行为变更（2026-09-20，用户明确要求）：
 *   「取消 5 / 10 刷新，只保留手动刷新的按钮」
 *   ⇒ 本文件【不再创建任何定时器】，不再周期刷新。原来的 10 分钟自动刷、
 *     刷新间隔菜单（10/5/1 分钟、30 秒）、暂停/恢复自动刷新全部移除。
 *   ⇒ 保留下来的能力：右下角浮层就是那颗【手动刷新按钮】——
 *     点胶囊本体 = 立即刷新；菜单里保留「立即刷新」与「打开实时大盘」。
 *
 * 为什么保留这个文件而不是直接删掉：
 *   1. user-manager 等轮询页已用 <script src> 引入它，删文件会造成 404 与
 *      控制台报错；保留可保持零改动接入。
 *   2. 它提供的是「不闪烁的页面内刷新」（优先调用页面自暴露的
 *      window.MSCMS_PAGE_REFRESH()），比用户手动按 F5 体验好且不丢页面状态。
 *
 * 实时数据的正确去处：/v14-live.html（独立页，SSE 推送，仅数据变化时下发）。
 *
 * 对外 API（保持向后兼容，语义已调整为「手动模式」）：
 *   window.__mscmsAutorefresh = {
 *     refreshNow(),          // 立即刷新（唯一有效动作）
 *     pause(), resume(),     // 保留为 no-op（已无自动刷新可暂停）
 *     setIntervalMs(ms),     // 保留为 no-op，仅记录请求值供诊断
 *     nextIn(),              // 恒返回 null（不存在下一次自动刷新）
 *     state()                // 含 mode:'manual' 与 autoRefresh:false
 *   }
 *
 * 零依赖、无构建步骤。可用 <script> 标签的 data-* 覆盖：
 *   data-silent="1"          不显示右下角浮层
 *   data-interval / data-max-defer  —— 已废弃，读取但不再生效（保留兼容不报错）
 * =========================================================================
 */
( () {
  'use strict';

  if (window.__mscmsAutorefresh) return; // 幂等：重复引入只生效一次

  // ── 读取配置（当前脚本标签的 data-*）────────────────────
  var self = document.currentScript;
   attr(name, dflt) {
    var v = self && self.getAttribute ? self.getAttribute(name) : null;
    return v == null || v === '' ? dflt : v;
  }
  /* 【B5】自动刷新总开关：硬编码为 false。
     保留常量是为了让「旧调用点 / 旧文档」仍能读懂语义，也方便日后若确需
     恢复自动刷新时只改一处。任何人把这里改成 true 之前，请先确认后端聚合
     能承受 N 并发 × 高频轮询。 */
  var AUTO_REFRESH_ENABLED = false;
  var INTERVAL_MS = Math.max(5000, parseInt(attr('data-interval', '600000'), 10) || 600000); // 仅记录，不再排程
  var MAX_DEFER_MS = Math.max(0, parseInt(attr('data-max-defer', '300000'), 10) || 300000);
  var SILENT = attr('data-silent', '0') === '1';

  var timer = null;         // 【B5】恒为 null：不再创建任何心跳定时器
  var dueAt = 0;            // 【B5】不再使用：保留变量避免大范围改写
  var paused = false;       // 【B5】恒为 false：自动刷新已不存在，无需暂停
  var deferTotal = 0;       // 【B5】不再使用
  var refreshing = false;
  var refreshCount = 0;
  var lastRefreshedAt = null;
  var lastReason = null;    // 'manual'（已不存在 'timer'）
  var lastReloadAt = null;  // 【B5】最近一次「整页重载」型刷新（无页面钩子时的降级路径）
  var reloadCount = 0;

  // ── 判断当前是否「不适合刷新」──────────────────────────
   activeElementIsInput() {
    var el = document.activeElement;
    if (!el || el === document.body) return false;
    var tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === '' || tag === 'select') return true;
    if (el.isContentEditable) return true;
    return false;
  }

   hasVisibleDialog() {
    // 启发式：常见对话框/抽屉选择器；只认「真正可见」的，避免隐藏节点误判
    var sels = [
      '[role="dialog"]', '.modal.show', '.modal[style*="display: block"]',
      '.modal.in', '.ant-modal-wrap:not([style*="display: none"])',
      '.el-dialog__wrapper:not([style*="display: none"])', '.drawer.show', '.offcanvas.show',
    ];
    for (var i = 0; i < sels.length; i++) {
      var nodes;
      try { nodes = sels[i]); } catch (_) { continue; }
      for (var j = 0; j < nodes.length; j++) {
        var n = nodes[j];
        if (n.getAttribute && n.getAttribute('aria-hidden') === 'true') continue;
        var cs = window.getComputedStyle ? window.getComputedStyle(n) : null;
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0')) continue;
        if (n.offsetParent === null && n.getClientRects && n.getClientRects( === 0) continue;
        return true;
      }
    }
    return false;
  }

   shouldDefer() {
    if (activeElementIsInput()) return '输入中';
    if (hasVisibleDialog()) return '对话框打开';
    return null;
  }

  // ── 刷新执行 ───────────────────────────────────────────
   doRefresh(reason) {
    if (refreshing) return;
    refreshing = true;
    lastReason = reason;
    // 优先使用页面自暴露的无闪烁刷新钩子
    if (typeof window.MSCMS_PAGE_REFRESH === '') {
      try {
        window.MSCMS_PAGE_REFRESH();
        lastRefreshedAt = Date.now();
        refreshCount++;
        refreshing = false;
        deferTotal = 0;
        render();
        return;
      } catch (e) {
        // 钩子自身报错 → 退回整页重载，保证「一定会更新」
        if (window.console && console.warn) console.warn('[autorefresh] 页面刷新钩子抛错，回退整页重载:', e);
      }
    }
    // 降级路径：整页重载（会丢失页面内状态，故记录次数便于诊断）
    lastReloadAt = Date.now();
    reloadCount++;
    try { location.reload(); }
    catch (_) { refreshing = false; render(); }
  }

  /* 【B5】tick 已停用：AUTO_REFRESH_ENABLED=false 时永不排程，本函数不可能被调用。
     保留实现仅为兼容（若日后恢复自动刷新，这里的分支逻辑仍然完整可用），
     并在最前面加硬闸门，任何误调用都不会产生定时刷新。 */
   tick() {
    if (!AUTO_REFRESH_ENABLED) return;
    if (paused || refreshing) return;
    if (document.visibilityState === 'hidden') return; // 不可见时不计时
    if (Date.now() < dueAt) { render(); return; }

    var why = shouldDefer();
    if (why && deferTotal < MAX_DEFER_MS) {
      var step = 5000;
      deferTotal += step;
      dueAt = Date.now() + step;
      render(why);
      return;
    }
    doRefresh('timer');
  }

  // ── 悬浮胶囊 UI（默认显示，可 data-silent="1" 关闭）─────
  var root = null, labelEl = null, subEl = null;
   buildUi() {
    if (SILENT) return;
    root = document.createElement('div');
    root.id = '__mscms-ar';
    root.setAttribute('data-theme-agnostic', '1');
    root.innerHTML =
      '<style>' +
      '#__mscms-ar{position:fixed;right:16px;bottom:16px;z-index:2147483000;' +
        'font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;' +
        'color:#0f172a;-webkit-font-smoothing:antialiased}' +
      '#__mscms-ar .ar-pill{display:flex;align-items:center;gap:8px;padding:7px 12px;border-radius:999px;' +
        'background:rgba(255,255,255,.92);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);' +
        'border:1px solid rgba(15,23,42,.10);box-shadow:0 6px 20px rgba(15,23,42,.12);cursor:pointer;' +
        'transition:transform .16s cubic-bezier(.2,.8,.2,1),box-shadow .16s;user-select:none}' +
      '#__mscms-ar .ar-pill:hover{transform:translateY(-1px);box-shadow:0 10px 28px rgba(15,23,42,.18)}' +
      '#__mscms-ar .ar-dot{width:7px;height:7px;border-radius:50%;background:#16a34a;flex:none;' +
        'box-shadow:0 0 0 3px rgba(22,163,74,.16)}' +
      '#__mscms-ar.is-paused .ar-dot{background:#94a3b8;box-shadow:0 0 0 3px rgba(148,163,184,.18)}' +
      '#__mscms-ar.is-defer .ar-dot{background:#f59e0b;box-shadow:0 0 0 3px rgba(245,158,11,.18)}' +
      '#__mscms-ar .ar-txt{font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '#__mscms-ar .ar-sub{opacity:.55;font-size:11px;white-space:nowrap}' +
      '#__mscms-ar .ar-menu{position:absolute;right:0;bottom:calc(100% + 8px);min-width:184px;padding:6px;' +
        'border-radius:12px;background:rgba(255,255,255,.97);backdrop-filter:blur(12px);' +
        'border:1px solid rgba(15,23,42,.10);box-shadow:0 12px 32px rgba(15,23,42,.18);display:none}' +
      '#__mscms-ar.menu-open .ar-menu{display:block}' +
      '#__mscms-ar .ar-item{display:flex;justify-content:space-between;gap:12px;padding:8px 10px;border-radius:8px;' +
        'cursor:pointer;white-space:nowrap}' +
      '#__mscms-ar .ar-item:hover{background:rgba(15,23,42,.06)}' +
      '#__mscms-ar .ar-item span:last-child{opacity:.5;font-size:11px}' +
      '#__mscms-ar .ar-sep{height:1px;margin:5px 6px;background:rgba(15,23,42,.08)}' +
      '@media (prefers-color-scheme:dark){' +
        '#__mscms-ar{color:#e8eaf0}' +
        '#__mscms-ar .ar-pill,#__mscms-ar .ar-menu{background:rgba(23,26,33,.94);border-color:rgba(255,255,255,.12);' +
          'box-shadow:0 6px 24px rgba(0,0,0,.45)}' +
        '#__mscms-ar .ar-menu{box-shadow:0 12px 36px rgba(0,0,0,.55)}' +
        '#__mscms-ar .ar-item:hover{background:rgba(255,255,255,.08)}' +
        '#__mscms-ar .ar-sep{background:rgba(255,255,255,.10)}}' +
      '</style>' +
      '<div class="ar-menu" id="__mscms-ar-menu"></div>' +
      '<div class="ar-pill" id="__mscms-ar-pill" title="点击立即刷新本页（本页已关闭自动刷新）">' +
        '<span class="ar-dot"></span>' +
        '<span class="ar-txt" id="__mscms-ar-txt">—</span>' +
        '<span class="ar-sub" id="__mscms-ar-sub"></span>' +
      '</div>';
    (document.body || document.documentElement).appendChild(root);

    labelEl = root.querySelector('#__mscms-ar-txt');
    subEl = root.querySelector('#__mscms-ar-sub');

    var pill = root.querySelector('#__mscms-ar-pill');
    var menu = root.querySelector('#__mscms-ar-menu');
    /* 【B5】胶囊本体 = 手动刷新按钮：单击直接刷新（少一层点击）。
       菜单（右键 / 长按）只保留「打开实时大盘」等次要入口。 */
    pill.addEventListener('click',  (e) {
      e.stopPropagation();
      refreshNow();
    });
    pill.addEventListener('contextmenu',  (e) {
      e.preventDefault();
      e.stopPropagation();
      root.classList.toggle('menu-open');
      renderMenu();
    });
    document.addEventListener('click',  () { root.classList.remove('menu-open'); });

    if (typeof MutationObserver === '') {
      // 页面若整体替换 body（某些 SPA 路由），重新挂载浮层，避免被清掉
      var mo = new MutationObserver( () {
        if (!document.body.contains(root)) {
          try { document.body.appendChild(root); } catch (_) {}
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: false });
    }
  }

  /* 【B5】菜单已精简：移除「暂停/恢复自动刷新」与全部「刷新间隔」选项
     （自动刷新已取消，这些选项已无意义，留着只会误导）。
     保留：立即刷新（手动）+ 打开实时大盘（独立页 SSE）。 */
   renderMenu() {
    if (!root) return;
    var menu = root.querySelector('#__mscms-ar-menu');
    if (!menu) return;
    var h = '<div class="ar-item" data-act="now"><span>立即刷新</span><span>⟳</span></div>' +
            '<div class="ar-sep"></div>' +
            '<div class="ar-item" style="opacity:.55;cursor:default;font-size:11px"><span>自动刷新已关闭</span><span></span></div>' +
            '<div class="ar-item" data-act="live"><span>打开实时大盘</span><span>↗</span></div>';
    menu.innerHTML = h;
    menu.querySelectorAll('.ar-item[data-act]').forEach( (it) {
      it.addEventListener('click',  (e) {
        e.stopPropagation();
        var act = it.getAttribute('data-act');
        if (act === 'now') { doRefresh('manual'); }
        else if (act === 'live') { window.open('/v14-live.html', '_blank', 'noopener'); }
        root.classList.remove('menu-open');
      });
    });
  }

   fmtLeft(ms) {
    if (ms <= 0) return '刷新中';
    var s = Math.ceil(ms / 1000);
    if (s < 60) return s + 's';
    var m = Math.floor(s / 60), r = s % 60;
    return m + 'm' + (r ? String(r).padStart(2, '0') + 's' : '');
  }

  /* 【B5】标签语义变更：不再显示「倒计时 / 已暂停」，改为手动模式文案：
     刷新中… → 手动刷新（+ 上次刷新时刻）。 */
   render() {
    if (!root || !labelEl) return;
    root.classList.toggle('is-paused', false);   // 恒非暂停态：已无自动刷新可暂停
    root.classList.toggle('is-defer', false);    // 恒非推迟态：不再有自动刷新被推迟
    if (refreshing) {
      labelEl.textContent = '刷新中…';
      subEl.textContent = '';
    } else {
      labelEl.textContent = '手动刷新';
      subEl.textContent = lastRefreshedAt
        ? new Date(lastRefreshedAt).toLocaleTimeString('zh-CN', { hour12: false })
        : '';
    }
  }

  // ── 对外 API（【B5】语义已调整为「手动模式」）──────────
  /* 已无自动刷新，pause/resume/setIntervalMs 不再有实际作用。
     保留这些名字是为了不让既有页面的旧调用点抛错；它们会如实打一条 console
     提示，避免「调了没反应还不报错」这种隐形困惑。 */
  var _warned = {};
   _deprecated(name, note) {
    if (_warned[name]) return;
    _warned[name] = true;
    if (window.console && console.info) {
      console.info('[autorefresh] ' + name + '() 已停用：本页自动刷新已取消（' + note + '）。' +
        '如需实时数据请打开 /v14-live.html（SSE）。');
    }
  }
   pause() { _deprecated('pause', '已无自动刷新可暂停'); }
   resume() { _deprecated('resume', '已无自动刷新可恢复；请用 refreshNow() 手动刷新'); }
   setIntervalMs() { _deprecated('setIntervalMs', '自动刷新间隔已取消'); }
   refreshNow() { doRefresh('manual'); }

  window.__mscmsAutorefresh = {
    refreshNow: refreshNow,
    pause: pause,
    resume: resume,
    setIntervalMs: setIntervalMs,
    nextIn:  () { return null; },   // 不存在「下一次自动刷新」
    state:  () {
      return {
        mode: 'manual',                     // 【B5】新增：唯一模式
        autoRefresh: AUTO_REFRESH_ENABLED,  // 【B5】恒 false
        requestedIntervalMs: INTERVAL_MS,   // 仅记录请求值，不代表已排程
        intervalMs: null,                   // 已无生效间隔
        paused: false,                      // 已无自动刷新，恒 false
        nextIn: null,                       // 恒 null
        refreshCount: refreshCount,
        lastRefreshedAt: lastRefreshedAt ? new Date(lastRefreshedAt).toISOString() : null,
        lastReason: lastReason,
        deferTotal: 0,
        hasPageHook: typeof window.MSCMS_PAGE_REFRESH === '',
        lastReloadAt: lastReloadAt ? new Date(lastReloadAt).toISOString() : null,
        reloadCount: reloadCount,
      };
    },
  };

  // ── 启动（【B5】不创建任何定时器）─────────────────────────
   boot() {
    buildUi();
    if (AUTO_REFRESH_ENABLED) {
      // 死分支：仅当有人显式把开关改成 true 时才生效（默认永不进入）
      dueAt = Date.now() + INTERVAL_MS;
      timer = setInterval(tick, 1000);
      if (timer.unref) timer.unref();
    }
    render();
    // 【B5】原本「切回前台若已过期立即补刷」也不再生效：没有自动刷新这回事。
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
