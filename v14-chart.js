/**
 * v14-chart.js — B5 统一图表组件（零依赖 · UMD · 可脱网单测）
 * =========================================================================
 * 依据升级方案 §3.4「可视化与时间维度（全站统一）」：
 *   · 统一时间维度控件（右上角，所有图表/列表共享）：今日 | 本周 | 本月 | 本年 | 自定义
 *   · 粒度自动映射：日→小时 · 周→日 · 月→日 · 年→月
 *   · 统一图表组件（折线/柱/环/漏斗），列表统一带「迷你趋势列」
 *   · 图表任意元素点击 → 抽屉明细
 *
 * 数据来源唯一：GET /api/v14/metrics/timeseries（服务端分桶聚合 + keyed 缓存）。
 * 本组件【绝不】在前端对原始记录做时间分桶 —— 那正是 §3.4 要消灭的
 * 「把 4 万条记录推给前端」模式（B5 之前 v14-dash.html 有两处仍在这么干）。
 *
 * ── 七条零伪造硬约束 ────────────────────────────────────────────────────
 *   1. 不生成任何合成点：无外推、无平滑、无随机抖动、无「按比例补齐」。
 *   2. 空桶 ≠ 无数据。空桶是「该时段确实 0 条」（真实事实，可以画）；
 *      只有 meta.datasetEmpty === true 才是「根本没有可用数据」→ 必须渲染
 *      「暂无数据」占位，不得画一条贴地直线冒充趋势。
 *   3. 服务端 meta.dropped / meta.coverage 必须原样展示在图表脚注，
 *      绝不用「看起来更漂亮」的数字覆盖它。
 *   4. avg/sum 模式下，某桶内没有一条记录带该字段时服务端返回 null，
 *      前端必须【断线】（gap）或画「—」，绝不当成 0 参与折线。
 *   5. 请求失败/接口报错 → 渲染错误占位并原样显示错误信息，不退回演示数据。
 *   6. 自定义时间窗 from >= to 时拒绝请求并在控件内报错，绝不静默改写窗口。
 *   7. 本文件不含任何 Math.random()、不含任何硬编码的演示数值。
 *
 * ── 时间口径 ────────────────────────────────────────────────────────────
 *   按 UTC+8（Asia/Shanghai）本地日历切桶，与服务端 MSCMS_TZ_OFFSET_MIN 默认一致。
 *   若按 UTC 切桶，「今日」会比用户认知偏移 8 小时（凌晨 0-8 点算到前一天）。
 *   周起点 = 周一（中国习惯，非周日）。
 *
 * ── 趋势颜色约定（本文件刻意采用「运维看板约定」，非股票约定）────────────
 *   本组件服务于运维/运营看板（账号数、发布数、访问数），不是行情工具，
 *   因此沿用本仓库 v14-dash.html 既有约定：上升=绿(--grn) 下降=红(--red)，
 *   与同文件 kpiCard(...,'up') / 闭环率 minibar 的颜色语义保持一致。
 *   如需行情约定（涨红跌绿），调用方传 opts.upColor / opts.downColor 覆盖。
 * =========================================================================
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MSCMSChart = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';

  // ── 常量：与服务端 v14-timeseries.js 同源语义，前端不得另行发明 ─────────
  var RANGES = ['today', 'week', 'month', 'year', 'custom'];
  var RANGE_LABEL = { today: '今日', week: '本周', month: '本月', year: '本年', custom: '自定义' };
  var GRANULARITIES = ['hour', 'day', 'week', 'month', 'year'];
  var GRANULARITY_LABEL = { hour: '小时', day: '日', week: '周', month: '月', year: '年' };
  // 必须与服务端 RANGE_GRANULARITY_MAP 逐字一致（服务端只会把粒度往粗了调，不会往细了调）
  var RANGE_GRANULARITY_MAP = { today: 'hour', week: 'day', month: 'day', year: 'month' };
  var API_PATH = '/api/v14/metrics/timeseries';
  var STORE_KEY = 'mscms.timedim';
  var TZ_OFFSET_MIN = 480;              // UTC+8，与服务端 MSCMS_TZ_OFFSET_MIN 默认值一致
  var MAX_LABELS = 8;                   // x 轴最多显示多少个标签（采样，不伪造数据）
  var MAX_EXACT_LABEL_CELLS = 240;      // 桶数超过此值时 x 轴改用等分采样布局
  var NO_DATA_TEXT = '暂无数据';
  var COLORS = ['#3b82f6', '#2ea043', '#a371f7', '#d29922', '#39c5cf', '#f85149', '#db61a2', '#e3b341'];

  var _uid = 0;
  function uid(p) { return p + (++_uid); }

  // ══════════════════════════════════════════════════════════════════════
  // 通用工具
  // ══════════════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]);
    });
  }
  function r2(n) { return Math.round(n * 100) / 100; }
  function fmt(n) {
    if (n === null || n === undefined) return '—';
    var v = Number(n);
    if (!isFinite(v)) return '—';
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v * 1000) / 1000);
  }
  /** 数值化：非数字/空一律返回 null（绝不把空值当 0 —— 见约束 4） */
  function numeric(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'boolean') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  // ── 本地日历（UTC+8）────────────────────────────────────────────────
  function localDateKey(ms) {
    var d = new Date((ms === undefined || ms === null ? Date.now() : ms) + TZ_OFFSET_MIN * 60000);
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
  }
  function daysAgoKey(n) { return localDateKey(Date.now() - Number(n) * 86400000); }

  /** 解析时间值 → epoch ms；无法解析返回 null（与内核 parseTime 同语义，前端只用于窗口计算） */
  function parseMs(v) {
    if (v === null || v === undefined || v === '') return null;
    if (v instanceof Date) { var t = v.getTime(); return isNaN(t) ? null : t; }
    if (typeof v === 'number') return isFinite(v) && v > 0 ? (v < 1e11 ? v * 1000 : v) : null;
    var s = String(v).trim();
    if (!s) return null;
    if (/^\d{10}$|^\d{13}$/.test(s)) return parseMs(Number(s));
    // 无时区标记的 <date|datetime> → 按本地(UTC+8)解释；带 Z / ±HH:MM 的交给 Date.parse
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/);
    if (m) {
      var y = +m[1], mo = +m[2], da = +m[3], hh = +(m[4] || 0), mi = +(m[5] || 0);
      if (mo < 1 || mo > 12 || da < 1 || da > 31 || hh > 23 || mi > 59) return null;
      return Date.UTC(y, mo - 1, da, hh, mi, +(m[6] || 0), +(m[7] || 0)) - TZ_OFFSET_MIN * 60000;
    }
    var p = Date.parse(s);
    return isNaN(p) ? null : p;
  }

  /**
   * 窗口 → 粒度。**必须与服务端 resolveRange 的判定完全一致**：
   *   custom：≤1.5 天→hour · ≤92 天→day · ≤800 天→week · 否则→month
   * 前端算这个只用于「提前把粒度显示给用户」，真实请求仍发 range 由服务端裁定；
   * 服务端另有「不得细于窗口所需」的守护，二者取更粗的结果。
   */
  function rangeGranularity(range, from, to) {
    if (range !== 'custom') return RANGE_GRANULARITY_MAP[range] || 'day';
    var f = parseMs(from), t = parseMs(to);
    if (f === null || t === null || !(f < t)) return 'day';
    var spanD = (t - f) / 86400000;
    if (spanD <= 1.5) return 'hour';
    if (spanD <= 92) return 'day';
    if (spanD <= 800) return 'week';
    return 'month';
  }

  // ══════════════════════════════════════════════════════════════════════
  // 响应归一化（纯函数，可脱网单测）
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 从响应里取出「模块数据段」。
   *
   * 【必须防的坑】单模块时服务端把数据段【平铺】到顶层，而顶层【同样有 series 字段】
   *   （内容是 {count:[...]}，不是「模块 → 数据段」的映射）。若不先判断，
   *   `payload.series[第一个 key]` 会把 `series.count` 这个数组当成一个模块取出来，
   *   labels/count 全部读空 —— 图上什么都没有，还不会报错。
   *   故判据顺序：顶层有 labels 数组 ⇒ 一定是平铺；否则看 multi 标记 / series 形状。
   */
  function pickModuleData(payload, moduleName) {
    if (!payload || typeof payload !== 'object') return null;
    var flat = Array.isArray(payload.labels);
    var looksMulti = payload.series && typeof payload.series === 'object' &&
      !Array.isArray(payload.series) && !Array.isArray(payload.series.count);
    var isMulti = !flat && (payload.multi === true || looksMulti);
    if (isMulti && payload.series) {
      var keys = Object.keys(payload.series);
      var k = (moduleName && payload.series[moduleName]) ? moduleName : keys[0];
      return k ? payload.series[k] : null;
    }
    return payload;
  }

  /** 归一化成 {ok, module, labels, buckets, series, total, meta, ...}；失败绝不抛异常 */
  function normalizePayload(payload, moduleName) {
    if (!payload || typeof payload !== 'object') return { ok: false, error: '空响应' };
    if (payload.ok === false) return { ok: false, error: payload.error || '接口返回失败' };
    var one = pickModuleData(payload, moduleName);
    if (!one) return { ok: false, error: '响应缺少模块数据' };
    return {
      ok: true,
      module: one.module || moduleName || '',
      range: one.range || payload.range || null,
      from: one.from || payload.from || null,
      to: one.to || payload.to || null,
      labels: Array.isArray(one.labels) ? one.labels : [],
      buckets: Array.isArray(one.buckets) ? one.buckets : [],
      series: one.series && typeof one.series === 'object' ? one.series : { count: [] },
      total: typeof one.total === 'number' ? one.total : null,
      records: typeof one.records === 'number' ? one.records : null,
      granularity: one.granularity || (one.meta && one.meta.granularity) || null,
      meta: one.meta && typeof one.meta === 'object' ? one.meta : null,
      cache: payload._cache || null,
    };
  }

  /**
   * 是否「根本没有可用数据」。判据唯一：meta.datasetEmpty === true
   * （服务端语义 = resolved === 0）。**不使用** total === 0 作判据 ——
   * total===0 且 resolved>0 表示「有数据但全在窗口外」，那是另一回事。
   */
  function datasetEmpty(d) {
    return !!(d && d.meta && d.meta.datasetEmpty === true);
  }

  /** 选要画的序列：sum/avg 模式画 series.value，count 模式画 series.count */
  function seriesValues(d, spec) {
    var s = (d && d.series) || {};
    var want = (spec && spec.plot) || (Array.isArray(s.value) ? 'value' : 'count');
    if (!Array.isArray(s[want])) want = Array.isArray(s.count) ? 'count' : want;
    return { key: want, vals: Array.isArray(s[want]) ? s[want] : [] };
  }

  /**
   * 口径脚注：把服务端 meta 如实翻译成人话（约束 3）。
   * 任何一项缺失都显示为「—」，绝不用默认值假装知道。
   */
  function describeMeta(meta) {
    if (!meta || typeof meta !== 'object') return '口径未知';
    var parts = [];
    var chain = Array.isArray(meta.fieldChain) ? meta.fieldChain : [];
    parts.push('口径 ' + (meta.field || '—') + (chain.length > 1 ? '（链 ' + chain.join(' → ') + '）' : ''));
    parts.push('粒度 ' + (GRANULARITY_LABEL[meta.granularity] || meta.granularity || '—'));
    if (meta.coarsened) parts.push('已按桶上限粗化');
    var cov = (meta.coverage === null || meta.coverage === undefined) ? null : meta.coverage;
    parts.push('覆盖 ' + (cov === null ? '—' : cov + '%') +
      '（' + (meta.resolved === undefined ? '—' : meta.resolved) + '/' + (meta.scanned === undefined ? '—' : meta.scanned) + '）');
    if (meta.dropped > 0) parts.push('丢弃 ' + meta.dropped + ' 条无可用时间字段');
    if (meta.outOfRange > 0) parts.push('窗口外 ' + meta.outOfRange + ' 条');
    parts.push('时区 ' + (meta.timezone || 'UTC+8'));
    return parts.join(' · ');
  }

  // ══════════════════════════════════════════════════════════════════════
  // 几何（纯函数，可脱网单测）
  // ══════════════════════════════════════════════════════════════════════

  /** 最大值（至少 1，避免除零）；全 0 序列返回 1 → 贴基线，属真实事实 */
  function scaleMax(vals) {
    var m = 0;
    for (var i = 0; i < (vals || []).length; i++) {
      var n = numeric(vals[i]);
      if (n !== null && n > m) m = n;
    }
    return m > 0 ? m : 1;
  }

  /**
   * 折线几何。null 值【断开】折线（约束 4），不连线、不补 0。
   * @returns {{line:string, area:string, segs:Array, max:number, points:number}}
   */
  function lineGeometry(vals, w, h, opts) {
    var o = opts || {};
    var pad = typeof o.pad === 'number' ? o.pad : 4;
    var list = Array.isArray(vals) ? vals : [];
    var n = list.length;
    var max = typeof o.max === 'number' && o.max > 0 ? o.max : scaleMax(list);
    var X = function (i) { return n > 1 ? (i / (n - 1)) * w : w / 2; };
    var Y = function (v) { return h - pad - (v / max) * Math.max(1, h - pad * 2); };

    var segs = [], cur = [], points = 0;
    for (var i = 0; i < n; i++) {
      var v = numeric(list[i]);
      if (v === null) { if (cur.length) segs.push(cur); cur = []; continue; }
      cur.push([X(i), Y(v)]);
      points++;
    }
    if (cur.length) segs.push(cur);

    var line = segs.map(function (s) {
      return s.map(function (p, i) { return (i ? 'L' : 'M') + r2(p[0]) + ' ' + r2(p[1]); }).join(' ');
    }).join(' ');
    // 面积只对「长度 ≥2 的连续段」闭合 —— 单点段不画面积，缺口不跨接
    var area = segs.filter(function (s) { return s.length > 1; }).map(function (s) {
      return 'M' + r2(s[0][0]) + ' ' + h + ' ' +
        s.map(function (p) { return 'L' + r2(p[0]) + ' ' + r2(p[1]); }).join(' ') +
        ' L' + r2(s[s.length - 1][0]) + ' ' + h + ' Z';
    }).join(' ');
    return { line: line, area: area, segs: segs, max: max, points: points, X: X, Y: Y };
  }

  /**
   * 迷你趋势线几何（固定尺寸，不会变形）。
   * 返回 null 表示「一个可画的点都没有」→ 调用方必须显示「—」而不是空图。
   */
  function sparkPath(vals, w, h, pad) {
    var list = Array.isArray(vals) ? vals : [];
    var geo = lineGeometry(list, w, h, { pad: typeof pad === 'number' ? pad : 2 });
    if (geo.points === 0) return null;          // 约束 1/4：没有真实点就不画
    return { line: geo.line, area: geo.area, max: geo.max, points: geo.points };
  }

  /** 趋势方向：以首尾【真实】非空点比较；点不足 2 个返回 null（不猜） */
  function trendDirection(vals) {
    var list = Array.isArray(vals) ? vals : [];
    var nums = [];
    for (var i = 0; i < list.length; i++) { var n = numeric(list[i]); if (n !== null) nums.push(n); }
    if (nums.length < 2) return null;
    var a = nums[0], b = nums[nums.length - 1];
    if (b > a) return 'up';
    if (b < a) return 'down';
    return 'flat';
  }

  /** 采样出要显示的标签下标（等距，不改变数据，只是少画几个字） */
  function pickLabelIdx(n, maxLabels) {
    var mx = maxLabels > 0 ? maxLabels : MAX_LABELS;
    if (n <= 0) return [];
    if (n <= mx) { var all = []; for (var i = 0; i < n; i++) all.push(i); return all; }
    var step = Math.ceil(n / mx), out = [];
    for (var j = 0; j < n; j += step) out.push(j);
    if (out[out.length - 1] !== n - 1) out[out.length - 1] = n - 1;
    return out;
  }

  /** x 轴标签行（HTML，不是 SVG —— 避免 preserveAspectRatio="none" 把文字拉变形） */
  function xLabelsHtml(labels, opts) {
    var list = Array.isArray(labels) ? labels : [];
    if (!list.length) return '';
    var idx = pickLabelIdx(list.length, opts && opts.maxLabels);
    if (list.length <= MAX_EXACT_LABEL_CELLS) {
      var set = {};
      idx.forEach(function (i) { set[i] = 1; });
      return '<div class="msc-xlab">' + list.map(function (l, i) {
        return '<span>' + (set[i] ? esc(l) : '') + '</span>';
      }).join('') + '</div>';
    }
    return '<div class="msc-xlab msc-xlab-approx">' + idx.map(function (i) {
      return '<span>' + esc(list[i]) + '</span>';
    }).join('') + '</div>';
  }

  /** 桶数轴标签（值标签行，画在柱/线之上） */
  function valueLabelsHtml(vals, opts) {
    var list = Array.isArray(vals) ? vals : [];
    if (!list.length || list.length > 32) return '';
    return '<div class="msc-vlab">' + list.map(function (v) {
      return '<span>' + (numeric(v) === null ? '—' : esc(fmt(v))) + '</span>';
    }).join('') + '</div>';
  }

  // ══════════════════════════════════════════════════════════════════════
  // 规范化 HTML 片段（占位/错误/脚注）
  // ══════════════════════════════════════════════════════════════════════

  function noDataHtml(reason) {
    return '<div class="msc-nodata"><div style="font-size:13px">' + NO_DATA_TEXT + '</div>' +
      (reason ? '<div>' + esc(reason) + '</div>' : '') + '</div>';
  }
  function errorHtml(msg) {
    // 约束 5：错误原样暴露，不退回演示数据
    return '<div class="msc-err">数据获取失败：' + esc(msg || '未知错误') + '</div>';
  }
  function footHtml(d, extra) {
    var bits = [];
    if (d && d.meta) bits.push(describeMeta(d.meta));
    if (d && d.total !== null && d.total !== undefined) bits.push('窗口内 ' + d.total + ' 条');
    if (extra) bits.push(extra);
    if (!bits.length) return '';
    return '<div class="msc-foot">' + esc(bits.join(' · ')) + '</div>';
  }

  // ══════════════════════════════════════════════════════════════════════
  // 图表渲染（返回 HTML 字符串）
  // ══════════════════════════════════════════════════════════════════════

  function hitRects(vals, labels, w, h, opts) {
    var o = opts || {};
    var n = vals.length;
    if (!n || n > (o.maxHits || 1500)) return '';
    var bw = w / n, out = '';
    for (var i = 0; i < n; i++) {
      var v = numeric(vals[i]);
      out += '<rect class="msc-hit" data-msc-i="' + i + '" x="' + r2(i * bw) + '" y="0" width="' + r2(bw) + '" height="' + h + '" fill="transparent">' +
        '<title>' + esc((labels[i] || '') + ' · ' + (v === null ? '无数据' : fmt(v))) + '</title></rect>';
    }
    return out;
  }

  function svgLine(vals, labels, spec) {
    var o = spec || {};
    var W = o.width || 560, H = o.height || 150, col = o.color || COLORS[0];
    var g = lineGeometry(vals, W, H, { pad: 4 });
    var gid = uid('msc-lg-');
    var grid = '';
    for (var k = 0; k <= 2; k++) {
      var y = 4 + (H - 8) * k / 2;
      grid += '<line x1="0" y1="' + r2(y) + '" x2="' + W + '" y2="' + r2(y) + '" stroke="' + (o.grid || '#2a3342') + '" stroke-width="1" opacity=".55"/>';
    }
    var svg = '<svg class="msc-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block;width:100%;height:' + H + 'px">' +
      '<defs><linearGradient id="' + gid + '" x1="0" x2="0" y1="0" y2="1">' +
      '<stop offset="0" stop-color="' + col + '" stop-opacity=".35"/><stop offset="1" stop-color="' + col + '" stop-opacity="0"/></linearGradient></defs>' +
      grid +
      (g.area ? '<path d="' + g.area + '" fill="url(#' + gid + ')" opacity=".7"/>' : '') +
      (g.line ? '<path d="' + g.line + '" fill="none" stroke="' + col + '" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>' : '') +
      hitRects(vals, labels, W, H, o) +
      '</svg>';
    return '<div class="msc-chart">' + valueLabelsHtml(vals) + svg + xLabelsHtml(labels, o) + '</div>';
  }

  function svgBars(vals, labels, spec) {
    var o = spec || {};
    var W = o.width || 560, H = o.height || 150;
    var n = vals.length;
    var max = scaleMax(vals);
    var gap = W / Math.max(1, n), bw = Math.max(1, gap * 0.62);
    var bars = '';
    for (var i = 0; i < n; i++) {
      var v = numeric(vals[i]);
      if (v === null) continue;                       // sum/avg 空桶：不画（约束 4）
      var bh = Math.max(0, (v / max) * (H - 6));
      var y = H - bh;
      // 默认单色：这是「同一指标随时间变化」的柱图，逐柱换色会暗示它们是不同类别。
      // 需要分类着色时显式传 palette:true。
      var barCol = o.color || (o.palette ? COLORS[i % COLORS.length] : COLORS[0]);
      bars += '<rect x="' + r2(i * gap + (gap - bw) / 2) + '" y="' + r2(y) + '" width="' + r2(bw) + '" height="' + r2(bh) + '" rx="2" fill="' + barCol + '"/>';
    }
    var svg = '<svg class="msc-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="display:block;width:100%;height:' + H + 'px">' +
      '<line x1="0" y1="' + (H - 1) + '" x2="' + W + '" y2="' + (H - 1) + '" stroke="' + (o.grid || '#2a3342') + '" stroke-width="1"/>' +
      bars + hitRects(vals, labels, W, H, o) + '</svg>';
    return '<div class="msc-chart">' + valueLabelsHtml(vals) + svg + xLabelsHtml(labels, o) + '</div>';
  }

  /** 环形图：seg = [{label,value,color}]；合计为 0 时返回「暂无数据」 */
  function donut(seg, spec) {
    var o = spec || {};
    var size = o.size || 150;
    var list = (Array.isArray(seg) ? seg : []).filter(function (x) { return numeric(x.value) !== null && numeric(x.value) > 0; });
    var tot = list.reduce(function (s, x) { return s + numeric(x.value); }, 0);
    if (!list.length || tot <= 0) return noDataHtml('全部构成项为 0');
    var a = -Math.PI / 2, t = '';
    list.forEach(function (x, i) {
      var v = numeric(x.value) / tot * 2 * Math.PI;
      var a2 = a + v;
      var r = size / 2 - 12, cx = size / 2, cy = size / 2, r2i = r - 18;
      var large = v > Math.PI ? 1 : 0;
      var x1 = cx + r * Math.cos(a), y1 = cy + r * Math.sin(a);
      var x2 = cx + r * Math.cos(a2), y2 = cy + r * Math.sin(a2);
      var x3 = cx + r2i * Math.cos(a2), y3 = cy + r2i * Math.sin(a2);
      var x4 = cx + r2i * Math.cos(a), y4 = cy + r2i * Math.sin(a);
      var c = x.color || (o.colors || COLORS)[i % (o.colors || COLORS).length];
      t += '<path d="M' + r2(x1) + ' ' + r2(y1) + ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + r2(x2) + ' ' + r2(y2) +
        ' L' + r2(x3) + ' ' + r2(y3) + ' A' + r2i + ' ' + r2i + ' 0 ' + large + ' 0 ' + r2(x4) + ' ' + r2(y4) + ' Z" fill="' + c + '">' +
        '<title>' + esc(x.label + ' · ' + fmt(x.value) + '（' + (x.share === undefined ? Math.round(numeric(x.value) / tot * 100) : x.share) + '%）') + '</title></path>';
      a = a2;
    });
    var legend = '<div class="msc-legend">' + list.map(function (x, i) {
      var c = x.color || (o.colors || COLORS)[i % (o.colors || COLORS).length];
      return '<span><i style="background:' + c + '"></i>' + esc(x.label) + ' ' + fmt(x.value) +
        ' (' + Math.round(numeric(x.value) / tot * 100) + '%)</span>';
    }).join('') + '</div>';
    var cx2 = size / 2, cy2 = size / 2;
    return '<div class="msc-chart" style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">' +
      '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' + t +
      '<text x="' + cx2 + '" y="' + (cy2 - 4) + '" text-anchor="middle" fill="#e6edf3" font-size="22" font-weight="700">' + esc(fmt(tot)) + '</text>' +
      '<text x="' + cx2 + '" y="' + (cy2 + 15) + '" text-anchor="middle" fill="#8b97a7" font-size="11">合计</text></svg>' +
      legend + '</div>';
  }

  /** 漏斗：stages = [{label,value,color}]；宽度按阶段真实值占比，不归一化造假 */
  function funnel(stages, spec) {
    var o = spec || {};
    var list = (Array.isArray(stages) ? stages : []);
    if (!list.length) return noDataHtml();
    var nums = list.map(function (s) { return numeric(s.value); });
    if (nums.every(function (v) { return v === null || v === 0; })) return noDataHtml('各阶段均为 0');
    var max = 0;
    nums.forEach(function (v) { if (v !== null && v > max) max = v; });
    return list.map(function (s, i) {
      var v = nums[i];
      var w = (v === null || max <= 0) ? 0 : Math.max(0, Math.min(100, v / max * 100));
      var c = s.color || (o.colors || COLORS)[i % (o.colors || COLORS).length];
      var prev = i > 0 ? nums[i - 1] : null;
      var rate = (i > 0 && prev !== null && prev > 0 && v !== null) ? ' <span style="color:var(--mut2,#5b6675)">(' + Math.round(v / prev * 100) + '%)</span>' : '';
      return '<div class="msc-fn-row"><div class="lb">' + esc(s.label) + '</div>' +
        '<div class="trk"><i style="width:' + r2(w) + '%;background:' + c + '"></i></div>' +
        '<div class="num">' + (v === null ? '—' : esc(fmt(v))) + rate + '</div></div>';
    }).join('');
  }

  /** 迷你趋势线（固定尺寸 SVG，不会变形）。无真实点 → 返回空串 */
  function spark(vals, color, spec) {
    var o = spec || {};
    var w = o.w || 86, h = o.h || 24;
    var g = sparkPath(vals, w, h, o.pad);
    if (!g) return '';
    var col = color || '#39c5cf';
    return '<svg class="msc-spark" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      (g.area ? '<path d="' + g.area + '" fill="' + col + '" opacity=".16"/>' : '') +
      '<path d="' + g.line + '" fill="none" stroke="' + col + '" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  }

  /** 列表「迷你趋势列」单元格 */
  function trendCell(vals, spec) {
    var o = spec || {};
    var list = Array.isArray(vals) ? vals : [];
    if (!list.length) return '<span class="msc-tdim" title="未取到该行的时间序列">—</span>';
    var numericCount = list.filter(function (v) { return numeric(v) !== null; }).length;
    if (!numericCount) return '<span class="msc-tdim" title="该行在此时段内无可用数据点">—</span>';
    var dir = trendDirection(list);
    var col = o.color || (dir === 'up' ? (o.upColor || '#2ea043') : dir === 'down' ? (o.downColor || '#f85149') : '#39c5cf');
    var s = spark(list, col, o);
    if (!s) return '<span class="msc-tdim">—</span>';
    return '<span class="msc-trend" title="' + esc(o.title || ('首尾对比 ' + (dir || '不可比') + ' · 共 ' + numericCount + ' 个真实数据点')) + '">' + s + '</span>';
  }

  // ══════════════════════════════════════════════════════════════════════
  // HTTP 层
  // ══════════════════════════════════════════════════════════════════════

  /**
   * 组装查询串。
   * range=custom 时【必须由调用方给全 from/to】——调用方显式传了 range:'custom'
   * 却只给一个端点，是调用方写错了，不能静默用全局状态的另一半凑成窗口（约束 6）。
   * 只有「未显式指定 range、沿用了全局时间维度」时才使用全局的 from/to。
   */
  function buildQuery(module, opts) {
    var o = opts || {};
    var explicit = typeof o.range === 'string' && o.range;
    var st = timeState.get();
    var range = explicit ? o.range : st.range;
    var p = [];
    var push = function (k, v) { if (v !== null && v !== undefined && v !== '') p.push(encodeURIComponent(k) + '=' + encodeURIComponent(v)); };
    push('module', module);
    push('range', range);
    if (range === 'custom') {
      var f = explicit ? o.from : (o.from || st.from);
      var tt = explicit ? o.to : (o.to || st.to);
      if (!f || !tt) return { error: '自定义时间维度需要同时提供 from 与 to' };
      if (!(parseMs(f) < parseMs(tt))) return { error: '起始日期必须早于结束日期' };
      push('from', f);
      push('to', tt);
    }
    if (o.granularity) push('granularity', o.granularity);
    if (o.metric && o.metric !== 'count') push('metric', o.metric);
    if (o.field) push('field', o.field);
    if (o.filter) push('filter', o.filter);
    if (o.refresh) push('refresh', '1');
    return { url: API_PATH + '?' + p.join('&') };
  }

  /**
   * 拉取时间序列。**永不抛异常**：任何失败都返回 {ok:false, error}（约束 5）。
   * @returns {Promise<Object>} normalizePayload 的结果
   */
  function fetchSeries(module, opts) {
    var o = opts || {};
    var q = buildQuery(module, o);
    if (q.error) return Promise.resolve({ ok: false, error: q.error });
    var fn = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fn) return Promise.resolve({ ok: false, error: '运行环境不支持 fetch' });
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var to = null;
    if (ctl && o.timeoutMs) to = setTimeout(function () { try { ctl.abort(); } catch (e) { } }, o.timeoutMs);
    return fn(q.url, { headers: { 'Accept': 'application/json' }, signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (to) clearTimeout(to);
        if (!r.ok) return { ok: false, error: 'HTTP ' + r.status + ' ' + q.url };
        return r.json().catch(function () { return { ok: false, error: '响应不是合法 JSON' }; });
      })
      .then(function (j) { return normalizePayload(j, module); })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; });
  }

  /** 多模块一次拉取（服务端最多 8 个），返回 {ok, byModule:{name:norm}} */
  function fetchSeriesMulti(modules, opts) {
    var list = (Array.isArray(modules) ? modules : [modules]).slice(0, 8);
    var o = opts || {};
    var q = buildQuery(list.join(','), o);
    if (q.error) return Promise.resolve({ ok: false, error: q.error });
    var fn = o.fetch || (typeof fetch === 'function' ? fetch : null);
    if (!fn) return Promise.resolve({ ok: false, error: '运行环境不支持 fetch' });
    return fn(q.url, { headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : { ok: false, error: 'HTTP ' + r.status }; })
      .catch(function (e) { return { ok: false, error: String((e && e.message) || e) }; })
      .then(function (j) {
        if (!j || j.ok === false) return { ok: false, error: (j && j.error) || '接口失败' };
        var by = {};
        list.forEach(function (m) { by[m] = normalizePayload(j, m); });
        return { ok: true, byModule: by, raw: j, error: null };
      });
  }

  // ══════════════════════════════════════════════════════════════════════
  // 时间维度：全局单例状态（§3.4 「所有图表/列表共享」）
  // ══════════════════════════════════════════════════════════════════════

  function readStore() {
    try {
      if (typeof localStorage === 'undefined') return null;
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      var o = JSON.parse(raw);
      return (o && typeof o === 'object') ? o : null;
    } catch (e) { return null; }
  }
  function writeStore(s) {
    try {
      if (typeof localStorage === 'undefined') return;
      // 跨页统一（§3.4「全站统一」）；写失败（隐私模式/配额）不影响运行
      localStorage.setItem(STORE_KEY, JSON.stringify({ range: s.range, from: s.from, to: s.to }));
    } catch (e) { /* 静默降级为内存态 */ }
  }

  function sanitizeState(o) {
    var s = o && typeof o === 'object' ? o : {};
    var range = RANGES.indexOf(s.range) >= 0 ? s.range : 'today';
    var from = (typeof s.from === 'string' && s.from) ? s.from : daysAgoKey(6);
    var to = (typeof s.to === 'string' && s.to) ? s.to : daysAgoKey(0);
    if (parseMs(from) === null) from = daysAgoKey(6);
    if (parseMs(to) === null) to = daysAgoKey(0);
    return { range: range, from: from, to: to };
  }

  var _state = sanitizeState(readStore() || { range: 'today' });
  var _subs = [];

  var timeState = {
    get: function () { return { range: _state.range, from: _state.from, to: _state.to }; },
    /** 粒度（前端预测值，真实值以服务端 meta.granularity 为准） */
    granularity: function () { return rangeGranularity(_state.range, _state.from, _state.to); },
    /** 设置状态；非法窗口（from >= to）返回 {ok:false, error} 且【不写入】（约束 6） */
    set: function (patch, opts) {
      var o = opts || {};
      var next = sanitizeState(Object.assign({}, _state, patch || {}));
      if (next.range === 'custom') {
        var f = parseMs(next.from), t = parseMs(next.to);
        if (f === null || t === null) return { ok: false, error: '日期格式不合法' };
        if (!(f < t)) return { ok: false, error: '起始日期必须早于结束日期' };
      }
      var changed = next.range !== _state.range || next.from !== _state.from || next.to !== _state.to;
      _state = next;
      writeStore(_state);
      if (changed && !o.silent) _subs.slice().forEach(function (fn) { try { fn(timeState.get()); } catch (e) { /* 订阅者异常不影响其他订阅者 */ } });
      return { ok: true, changed: changed, state: timeState.get() };
    },
    subscribe: function (fn) {
      if (typeof fn !== 'function') return function () { };
      _subs.push(fn);
      return function () { var i = _subs.indexOf(fn); if (i >= 0) _subs.splice(i, 1); };
    },
    /** 人类可读窗口描述（用于顶栏/脚注） */
    describe: function () {
      var s = timeState.get();
      var gran = timeState.granularity();
      if (s.range === 'custom') return s.from + ' ~ ' + s.to + ' · 粒度 ' + (GRANULARITY_LABEL[gran] || gran);
      return RANGE_LABEL[s.range] + ' · 粒度 ' + (GRANULARITY_LABEL[gran] || gran);
    },
    /** 仅供单测：重置为给定状态 */
    _reset: function (o) { _state = sanitizeState(o || { range: 'today' }); writeStore(_state); return timeState.get(); },
  };

  // ══════════════════════════════════════════════════════════════════════
  // 时间维度控件（DOM）
  // ══════════════════════════════════════════════════════════════════════

  var STYLE_ID = 'msc-chart-style';
  var STYLE_CSS = [
    '.msc-td{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--mut,#8b97a7);flex-wrap:wrap}',
    '.msc-td-seg{display:flex;border:1px solid var(--bord,#2a3342);border-radius:6px;overflow:hidden}',
    '.msc-td-b{background:transparent;border:0;border-right:1px solid var(--bord,#2a3342);color:var(--mut,#8b97a7);padding:4px 10px;font-size:12px;cursor:pointer;font-family:inherit}',
    '.msc-td-b:last-child{border-right:0}',
    '.msc-td-b.on{background:var(--acc,#3b82f6);color:#fff}',
    '.msc-td-b:hover:not(.on){background:var(--bg3,#1c2330);color:var(--txt,#e6edf3)}',
    '.msc-td-cus{display:flex;align-items:center;gap:4px}',
    '.msc-td-cus input{background:var(--bg3,#1c2330);border:1px solid var(--bord,#2a3342);color:var(--txt,#e6edf3);border-radius:4px;padding:3px 6px;font-size:11px;font-family:inherit}',
    '.msc-td-go{background:var(--bg3,#1c2330);border:1px solid var(--bord,#2a3342);color:var(--txt,#e6edf3);border-radius:4px;padding:3px 8px;font-size:11px;cursor:pointer;font-family:inherit}',
    '.msc-td-go:hover{border-color:var(--acc,#3b82f6)}',
    '.msc-td-note{font-size:11px;color:var(--mut2,#5b6675)}',
    '.msc-td-err{color:var(--red,#f85149);font-size:11px}',
    '.msc-host{min-height:56px}',
    '.msc-nodata{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:110px;gap:4px;color:var(--mut2,#5b6675);font-size:12px;border:1px dashed var(--bord,#2a3342);border-radius:6px}',
    '.msc-chart{position:relative}',
    '.msc-svg{overflow:visible}',
    '.msc-xlab{display:flex;font-size:10px;color:var(--mut2,#5b6675);margin-top:2px}',
    '.msc-xlab span{flex:1;text-align:center;white-space:nowrap;overflow:hidden}',
    '.msc-vlab{display:flex;font-size:10px;color:var(--mut,#8b97a7);margin-bottom:2px}',
    '.msc-vlab span{flex:1;text-align:center;white-space:nowrap;overflow:hidden}',
    '.msc-hit{cursor:pointer}',
    '.msc-hit:hover{fill:rgba(59,130,246,.12)}',
    '.msc-fn-row{display:flex;align-items:center;gap:10px;margin:6px 0}',
    '.msc-fn-row .lb{width:110px;font-size:12px;color:var(--mut,#8b97a7);flex:none}',
    '.msc-fn-row .trk{flex:1;height:16px;background:var(--bg3,#1c2330);border-radius:3px;overflow:hidden}',
    '.msc-fn-row .trk i{display:block;height:100%;border-radius:3px}',
    '.msc-fn-row .num{width:110px;text-align:right;font-size:12px;color:var(--txt,#e6edf3);flex:none}',
    '.msc-legend{display:flex;flex-wrap:wrap;gap:10px;font-size:11px;color:var(--mut,#8b97a7);margin-top:6px}',
    '.msc-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}',
    '.msc-foot{font-size:10px;color:var(--mut2,#5b6675);margin-top:6px;line-height:1.5}',
    '.msc-err{color:var(--red,#f85149);font-size:12px;padding:10px;border:1px solid var(--red,#f85149);border-radius:6px;background:rgba(248,81,73,.06)}',
    '.msc-spark{vertical-align:middle}',
    '.msc-tdim{color:var(--mut2,#5b6675)}',
    '.msc-trend{display:inline-flex;align-items:center}',
  ].join('');

  function ensureStyle(doc) {
    var d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d) return;
    if (d.getElementById(STYLE_ID)) return;
    var st = d.createElement('style');
    st.id = STYLE_ID;
    st.textContent = STYLE_CSS;
    (d.head || d.documentElement).appendChild(st);
  }

  function controlHtml(opts) {
    var o = opts || {};
    var s = o.state || timeState.get();
    var seg = RANGES.map(function (r) {
      return '<button type="button" class="msc-td-b' + (r === s.range ? ' on' : '') + '" data-r="' + r + '">' + RANGE_LABEL[r] + '</button>';
    }).join('');
    var gran = rangeGranularity(s.range, s.from, s.to);
    return '<div class="msc-td" data-msc-td>' +
      '<span class="msc-td-note">时间维度</span>' +
      '<div class="msc-td-seg">' + seg + '</div>' +
      '<span class="msc-td-cus" style="display:' + (s.range === 'custom' ? 'flex' : 'none') + '">' +
      '<input type="date" data-msc-from value="' + esc(s.from) + '">' +
      '<span class="msc-td-note">→</span>' +
      '<input type="date" data-msc-to value="' + esc(s.to) + '">' +
      '<button type="button" class="msc-td-go" data-msc-apply>应用</button>' +
      '</span>' +
      '<span class="msc-td-note" data-msc-gran>粒度 ' + esc(GRANULARITY_LABEL[gran] || gran) + '</span>' +
      '<span class="msc-td-err" data-msc-err style="display:none"></span>' +
      '</div>';
  }

  /**
   * 挂载时间维度控件。
   * @param {Element} el 容器（若为 null 则创建并返回 el）
   * @param {{onChange?:Function, state?:Object}} opts
   * @returns {{el:Element, get:Function, set:Function, destroy:Function}}
   */
  function mountControl(el, opts) {
    var o = opts || {};
    var doc = (el && el.ownerDocument) || (typeof document !== 'undefined' ? document : null);
    if (!doc) return null;
    ensureStyle(doc);
    var host = el;
    if (!host) { host = doc.createElement('div'); }
    host.innerHTML = controlHtml({ state: timeState.get() });

    function paint() {
      var s = timeState.get();
      var gran = rangeGranularity(s.range, s.from, s.to);
      var root = host.querySelector('[data-msc-td]');
      if (!root) return;
      root.querySelectorAll('.msc-td-b').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-r') === s.range); });
      var cus = root.querySelector('.msc-td-cus');
      if (cus) cus.style.display = s.range === 'custom' ? 'flex' : 'none';
      var fi = root.querySelector('[data-msc-from]'), ti = root.querySelector('[data-msc-to]');
      if (fi) fi.value = s.from;
      if (ti) ti.value = s.to;
      var g = root.querySelector('[data-msc-gran]');
      if (g) g.textContent = '粒度 ' + (GRANULARITY_LABEL[gran] || gran);
    }
    function showErr(msg) {
      var e = host.querySelector('[data-msc-err]');
      if (!e) return;
      e.textContent = msg || '';
      e.style.display = msg ? 'inline' : 'none';
    }

    function apply(patch) {
      var r = timeState.set(patch);
      if (!r.ok) { showErr(r.error); return false; }   // 约束 6：非法窗口不写入、不改写
      showErr('');
      paint();
      return true;
    }

    host.addEventListener('click', function (ev) {
      var t = ev.target;
      if (!t || !t.getAttribute) return;
      var r = t.getAttribute('data-r');
      if (r) {
        if (r === 'custom') {
          // 切到自定义：把当前窗口预填成「最近 7 天」，仅预填，用户点「应用」才换窗口
          var s = timeState.get();
          var need = s.range !== 'custom';
          timeState.set({ range: 'custom', from: need ? daysAgoKey(6) : s.from, to: need ? daysAgoKey(0) : s.to }, { silent: true });
          paint();
          showErr('');
          if (o.onChange) o.onChange(timeState.get());
        } else if (apply({ range: r })) {
          if (o.onChange) o.onChange(timeState.get());
        }
        return;
      }
      if (t.hasAttribute && t.hasAttribute('data-msc-apply')) {
        var fi = host.querySelector('[data-msc-from]'), ti = host.querySelector('[data-msc-to]');
        if (apply({ range: 'custom', from: fi && fi.value, to: ti && ti.value }) && o.onChange) o.onChange(timeState.get());
      }
    });

    var unsub = timeState.subscribe(function () { paint(); });
    return {
      el: host,
      get: function () { return timeState.get(); },
      set: function (patch) { return apply(patch); },
      destroy: function () { unsub(); host.innerHTML = ''; },
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // 图表挂载：注册表 + hydrate（页面用字符串拼 HTML，之后再 hydrate）
  // ══════════════════════════════════════════════════════════════════════

  var registry = {};

  /** 注册一个图表规格；spec.module 为数据源，spec.type 为图形 */
  function define(id, spec) { registry[id] = spec || {}; return registry[id]; }
  function getSpec(id) { return registry[id] || null; }

  /** 生成 host 占位（页面 HTML 字符串里用），后续 hydrate 会填充 */
  function placeholder(id, inner) {
    return '<div class="msc-host" data-msc-chart="' + esc(id) + '">' + (inner || '<div class="msc-nodata">加载中…</div>') + '</div>';
  }

  /** 抽屉明细：把某个时间桶的原始信息交给调用方（点柱子/点折线点用） */
  function bucketDrill(d, idx) {
    var b = (d && d.buckets || [])[idx];
    if (!b) return null;
    var sv = seriesValues(d, {});
    var v = numeric(sv.vals[idx]);
    var kv = {
      时间桶: b.label || '—',
      时段起: b.from || '—',
      时段止: b.to || '—',
      模块: (d && d.module) || '—',
      条数: b.count,
    };
    if (sv.key === 'value') kv.指标值 = (v === null ? '该桶内无该字段记录' : v);
    if (d && d.meta) {
      kv.时间口径 = d.meta.field || '—';
      kv.粒度 = GRANULARITY_LABEL[d.meta.granularity] || d.meta.granularity || '—';
      kv.时区 = d.meta.timezone || 'UTC+8';
    }
    return { title: 'L5 · 时间桶 ' + (b.label || ''), kv: kv, raw: { bucket: b, meta: d.meta, module: d.module } };
  }

  /** 渲染单个 host。失败渲染错误占位，绝不静默留白。 */
  function renderHost(host) {
    var doc = host.ownerDocument;
    var id = host.getAttribute('data-msc-chart');
    var spec = getSpec(id);
    if (!spec) { host.innerHTML = errorHtml('未注册图表规格：' + id); return Promise.resolve(false); }

    var type = spec.type || 'line';
    function paint(d) {
      if (!d.ok) { host.innerHTML = errorHtml(d.error); return false; }
      if (datasetEmpty(d)) {
        // 约束 2：datasetEmpty → 占位，绝不画贴地直线
        host.innerHTML = noDataHtml('模块 ' + (d.module || spec.module) + ' 在此时段内没有可用时间数据' +
          (d.meta && d.meta.dropped ? '（' + d.meta.dropped + ' 条记录缺可用时间字段）' : '')) + footHtml(d);
        return false;
      }
      var sv = seriesValues(d, spec);
      var html;
      if (type === 'line') html = svgLine(sv.vals, d.labels, spec);
      else if (type === 'bar') html = svgBars(sv.vals, d.labels, spec);
      else if (type === 'donut') html = donut(spec.segments || [], spec);
      else if (type === 'funnel') html = funnel(spec.stages || [], spec);
      else if (type === 'spark') html = spark(sv.vals, spec.color, spec);
      else html = errorHtml('未知图表类型：' + type);
      host.innerHTML = html + footHtml(d, spec.extraFoot);
      host.setAttribute('data-msc-ok', '1');
      return true;
    }

    if (spec.data) return Promise.resolve(paint(normalizePayload(spec.data, spec.module)));
    if (!spec.module) { host.innerHTML = errorHtml('图表规格既无 module 也无 data'); return Promise.resolve(false); }
    return fetchSeries(spec.module, spec).then(function (d) { paint(d); return d.ok && !datasetEmpty(d); });
  }

  /** 把所有（或指定容器内的）`[data-msc-chart]` 渲染出来；返回已渲染数量 */
  function hydrate(root) {
    var scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || !scope.querySelectorAll) return Promise.resolve(0);
    ensureStyle(scope.ownerDocument || document);
    var hosts = Array.prototype.slice.call(scope.querySelectorAll('[data-msc-chart]'));
    return Promise.all(hosts.map(function (h) { return renderHost(h); }))
      .then(function (rs) { return rs.filter(Boolean).length; });
  }

  /** 时间维度变化后重绘当前页所有已注册图表（细粒度刷新，不整页重渲） */
  function refreshAll(root) { return hydrate(root); }

  var MSCMSChart = {
    version: VERSION,
    // 常量
    RANGES: RANGES, RANGE_LABEL: RANGE_LABEL,
    GRANULARITIES: GRANULARITIES, GRANULARITY_LABEL: GRANULARITY_LABEL,
    RANGE_GRANULARITY_MAP: RANGE_GRANULARITY_MAP,
    API_PATH: API_PATH, COLORS: COLORS, NO_DATA_TEXT: NO_DATA_TEXT,
    // 纯函数（可脱网单测）
    esc: esc, fmt: fmt, numeric: numeric,
    localDateKey: localDateKey, daysAgoKey: daysAgoKey, parseMs: parseMs,
    rangeGranularity: rangeGranularity,
    pickModuleData: pickModuleData, normalizePayload: normalizePayload,
    datasetEmpty: datasetEmpty, seriesValues: seriesValues, describeMeta: describeMeta,
    scaleMax: scaleMax, lineGeometry: lineGeometry, sparkPath: sparkPath,
    trendDirection: trendDirection, pickLabelIdx: pickLabelIdx,
    xLabelsHtml: xLabelsHtml, valueLabelsHtml: valueLabelsHtml,
    noDataHtml: noDataHtml, errorHtml: errorHtml, footHtml: footHtml,
    bucketDrill: bucketDrill, buildQuery: buildQuery,
    // DOM / IO
    timeState: timeState,
    controlHtml: controlHtml, mountControl: mountControl, ensureStyle: ensureStyle,
    donut: donut, funnel: funnel, spark: spark, trendCell: trendCell,
    svgLine: svgLine, svgBars: svgBars,
    define: define, getSpec: getSpec, placeholder: placeholder,
    renderHost: renderHost, hydrate: hydrate, refreshAll: refreshAll,
    fetchSeries: fetchSeries, fetchSeriesMulti: fetchSeriesMulti,
  };

  return MSCMSChart;
});
