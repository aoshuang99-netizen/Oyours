'use strict';
/**
 * tumblr-nurture.js — 16 真实 Tumblr 账户「第二阶段养号」真实引擎
 *
 * 设计铁律（用户 6 条指令 + 行业研究）：
 *  - 零假数据：所有养号动作都是真实 Tumblr API 调用；任何失败都如实记录，绝不伪造计数/进度。
 *  - 赛道=生活&交友：关注 dating/relationship 博主，发情感/两性关系内容（英文内容，欧美 dating 圈）。
 *  - 保守强度：日操作上限远低于平台硬限制。
 *  - 发布是养号一部分，比例受控：消费(浏览/点赞/reblog) >> 生产(原创帖)。
 *  - 模拟真实用户：稳定人格(persona)、时区活跃节律、高斯抖动、错峰、偶发跳过、动作顺序随机、发帖前思考时长。
 *
 * 阶段（消费 → 生产）：
 *  P0 资料完善(Day0)  → P1 观察期(D1-3 纯消费) → P2 轻度互动(D4-7)
 *  → P3 内容沉淀(D8-14) → P4 成熟期(D15+ 稳定日更)
 *
 * 复用：tumblr-publisher.js 的全部真实 API 方法 + http-client 代理 + 429 退避。
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { tmpFile } = require('./storage-paths.js');

const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';
// 移动端消费会话所需的标签池（来自设备池模块；仅引用常量，不会主动启动浏览器）
const { CONSUME_TAGS } = require('./tumblr-nurture-device.js');
// 多出口代理池（缓解 Tumblr 429 限流根因：不同账号/浏览器走不同出口 IP）
const { ProxyPool } = require('./proxy-pool.js');

// ── 稳定 persona 的确定性随机（按 accountId 播种，重启一致） ──
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function randInt(rng, a, b) { return a + Math.floor(rng() * (b - a + 1)); }

// ── 人格素材 ──
const FIRST_NAMES = ['Ava', 'Mia', 'Liam', 'Noah', 'Zoe', 'Eli', 'Ivy', 'Leo', 'Maya', 'Kai', 'Nora', 'Theo', 'Luna', 'Finn', 'Ruby', 'Jude', 'Cleo', 'Asa', 'Wren', 'Ezra'];
const VOICES = ['warm', 'witty', 'reflective', 'bold', 'gentle'];
const VOICE_BIO = {
  warm: 'soft thoughts on love, dating & growing. 27. she/her. here for the real ones.',
  witty: 'dating is a comedy and i\'m the unwilling lead. memes + feelings. he/him.',
  reflective: 'writing my way through love, loss & everything between. 29. they/them.',
  bold: 'say it loud: sex, love, boundaries. unapologetic. she/her. 26.',
  gentle: 'quiet notes on relationships & self-love. take what you need. he/him.',
};
const BLOG_TITLES = {
  warm: ['soft parts', 'love, loosely', 'the gentle archive', 'hearts in progress'],
  witty: ['date me maybe', 'romcom reruns', 'swipe fatigue', 'plot twist romance'],
  reflective: ['letters to no one', 'the in-between', 'mapping love', 'quiet confessions'],
  bold: ['no filter feelings', 'boundaries & bodies', 'loud love', 'tell it true'],
  gentle: ['slow love notes', 'tender things', 'the soft list', 'kindest version'],
};

// ── 情感/两性关系 内容种子池（英文，欧美 dating 圈） ──
const CONTENT_SEEDS = [
  { title: 'the kind of love that stays', body: 'the kind of love i want isn\'t loud. it\'s the "did you eat?" texts. the quiet "i\'m here" at 2am. the person who remembers the small things you forgot you mentioned. romance isn\'t only grand gestures — it\'s consistency when no one\'s watching. reblog if you\'ve found that, or are still looking.', tags: ['dating', 'relationships', 'love', 'relationshipadvice', 'tumblrrelationships', 'softlaunch'] },
  { title: 'dating red flag: inconsistency', body: 'hot take: inconsistency is a red flag dressed as mystery. if they can go from "good morning gorgeous" to 3-day silence with no reason, that\'s not busy — that\'s unavailability. you deserve the same energy you give. don\'t romanticize confusion.', tags: ['dating', 'datingadvice', 'redflags', 'relationships', 'selflove', 'tumblrdating'] },
  { title: 'you\'re not "too much"', body: 'if someone makes you feel like wanting clarity, effort, and respect makes you "too much" — you\'re not too much. they\'re too little. your standards are not a personality flaw. reblog for the girlies who forgot that this week.', tags: ['selflove', 'relationships', 'dating', 'boundaries', 'mentalhealth', 'growth'] },
  { title: 'the ick is usually a clue', body: 'we joke about "the ick" but sometimes it\'s just your gut telling you something\'s off. you don\'t owe anyone the benefit of the doubt at the cost of your peace. trust the discomfort. it\'s data.', tags: ['dating', 'relationships', 'intuition', 'datingadvice', 'tumblrrelationships'] },
  { title: 'love languages but make it honest', body: 'my love language is "telling you the truth even when it\'s awkward." and "remembering your coffee order." and "not leaving you on read when i\'m upset." what\'s yours? reblog with yours, i\'m curious.', tags: ['love', 'relationships', 'dating', 'loveLanguages', 'couple', 'tumblrrelationships'] },
  { title: 'breakup clarity hits at 3am', body: 'breakup clarity is wild. one day you\'re begging for a text back, the next you realize you were mourning the potential, not the person. healing isn\'t linear and it\'s not pretty. but you get there.', tags: ['breakup', 'heartbreak', 'healing', 'selflove', 'relationships', 'mentalhealth'] },
  { title: 'green flags > red flags', body: 'green flags nobody talks about: they ask how your day was and mean it. they celebrate your wins without envy. they can sit in silence with you. they say "we" about the future without scaring you. collect green flags.', tags: ['dating', 'relationships', 'greenflags', 'love', 'relationshipadvice', 'tumblrdating'] },
  { title: 'texting is not love', body: 'texting fast doesn\'t mean they love you. texting slow doesn\'t mean they don\'t. communication is the action, not the speed. stop decoding response times like tarot cards. have the conversation instead.', tags: ['dating', 'datingadvice', 'relationships', 'communication', 'love', 'tumblrrelationships'] },
  { title: 'choose the calm', body: 'choose the person who feels like quiet, not chaos. the one your nervous system relaxes around. chemistry without safety is just adrenaline. peace is the real romance.', tags: ['love', 'relationships', 'selflove', 'healing', 'dating', 'softlaunch'] },
  { title: 'being single is not a failure', body: 'being single at 28 (or 35, or 40) is not a failure. it\'s a season. you\'re not "behind." you\'re building a life you don\'t have to escape from. reblog if you\'re happy on your own terms.', tags: ['single', 'selflove', 'dating', 'relationships', 'independence', 'growth'] },
  { title: 'the bare minimum isn\'t romance', body: 'replying, planning dates, remembering your birthday — that\'s the floor, not the ceiling. don\'t hand out trophies for bare minimum behavior. want the person who exceeds it without being asked.', tags: ['dating', 'relationships', 'standards', 'datingadvice', 'boundaries', 'tumblrdating'] },
  { title: 'soft launch era', body: 'the soft launch is my favorite era of a relationship. the vague song, the hand in frame, the "someone\'s been on my mind" post. tell me (vaguely) about your person. reblog with your soft launch energy.', tags: ['softlaunch', 'relationships', 'love', 'dating', 'couple', 'tumblrrelationships'] },
  { title: 'anxious attachment, gently', body: 'if you have anxious attachment: your need for reassurance isn\'t weakness. it\'s a wound asking to be held. the work is learning to soothe yourself AND choosing people safe enough to ask. both. not either/or.', tags: ['attachment', 'relationships', 'mentalhealth', 'dating', 'healing', 'selflove'] },
  { title: 'date someone who listens', body: 'date someone who actually listens — not waits for their turn to talk. someone who remembers the story about your dad, your best friend, your worst job. being heard is the most underrated form of being loved.', tags: ['dating', 'love', 'relationships', 'relationshipadvice', 'tumblrdating', 'greenflags'] },
  { title: 'romance is in the details', body: 'romance isn\'t only roses. it\'s "i saved you the last bite." it\'s them pausing the show because you fell asleep. it\'s "drive safe, text me when you\'re home." the details are the whole thing.', tags: ['love', 'romance', 'relationships', 'softlaunch', 'dating', 'couple'] },
  { title: 'you can want love and want yourself', body: 'you can want a relationship AND want your own life. wanting love doesn\'t cancel your independence. the right person adds to your life, they don\'t become it. hold both. you\'re allowed.', tags: ['selflove', 'relationships', 'dating', 'independence', 'love', 'growth'] },
];

// 用于发现 dating/relationship 博主的标签
const DISCOVER_TAGS = ['dating', 'relationships', 'relationshipadvice', 'tumblrrelationships', 'datingadvice', 'breakup', 'selflove'];

// 保守日操作上限（远低于 Tumblr 硬限制：关注200/赞1000/帖250/视频20）
const DAILY_CAPS = {
  follow: 12,
  like: 50,
  reblog: 6,
  post: 2,
  comment: 3,
};

// 并发信号量：限制同时进行的设备会话(浏览器导航)数量，避免 45 个上下文同时压单代理出口被淹。
// 单代理(10808)在高并发 CONNECT 下会被远端大量重置(ERR_CONNECTION_CLOSED)，导致 API/设备会话全面失败。
class Semaphore {
  constructor(max) { this.max = max; this.cur = 0; this.queue = []; }
  async acquire() {
    if (this.cur < this.max) { this.cur++; return; }
    return new Promise((res) => this.queue.push(res));
  }
  release() {
    this.cur = Math.max(0, this.cur - 1);
    if (this.queue.length) { this.cur++; this.queue.shift()(); }
  }
}

// 全局速率治理（共享 1 个 consumer key：1000/hr, 5000/day）
class GlobalRateGovernor {
  constructor() {
    this.windowHr = { ts: Date.now(), count: 0 };   // 滚动 1 小时
    this.windowDay = { ts: Date.now(), count: 0 };  // 滚动 24 小时
    this.HR_LIMIT = 1000;
    this.DAY_LIMIT = 5000;
  }
  _roll() {
    const now = Date.now();
    if (now - this.windowHr.ts > 3600000) { this.windowHr = { ts: now, count: 0 }; }
    if (now - this.windowDay.ts > 86400000) { this.windowDay = { ts: now, count: 0 }; }
  }
  // 预估 n 次调用是否会超全局限；预算（消耗）由调用方在实际发请求时调 consume
  canProceed(n = 1) {
    this._roll();
    return (this.windowHr.count + n <= this.HR_LIMIT) && (this.windowDay.count + n <= this.DAY_LIMIT);
  }
  consume(n = 1) {
    this._roll();
    this.windowHr.count += n;
    this.windowDay.count += n;
  }
  snapshot() {
    this._roll();
    return { hr: this.windowHr.count, hrLimit: this.HR_LIMIT, day: this.windowDay.count, dayLimit: this.DAY_LIMIT };
  }
}

// 高斯抖动延迟
function gaussian(mean, sd) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(50, Math.round(mean + z * sd));
}

class TumblrNurtureEngine extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.dataStore = opts.dataStore;
    this.publisher = opts.publisher;
    this.eventBus = opts.eventBus || null;
    this.governor = new GlobalRateGovernor();
    this.accounts = [];           // 16 真实 tumblr 账号元数据
    this.personas = new Map();    // accountId -> persona
    this.states = new Map();      // accountId -> nurture state (持久化于 dataStore tumblr_nurture)
    this.device = null;           // MobileDevicePool 实例（移动端养号）；默认 null = 纯 API 模式
    this._timer = null;
    this._tickMs = 90000;         // 每 90s 一个调度 tick（真实用户是零星使用，不是批量刷）
    this._blogCache = new Map();  // blogName 内存缓存，避免回写共享 tumblr_token
    this._gen = 0;                // 循环代际：看门狗自愈重启时自增，陈旧循环立即退出防重复动作
    this._apiCooldownUntil = 0;   // 兜底全局冷却（无代理池 / 单出口时退化为原行为）
    this._apiCooldownMap = new Map(); // 按出口 IP 分桶冷却：key=proxyUrl → until 时间戳。多 IP 下某 IP 被限流只冻结走该 IP 的账号，不波及其它账号。
    this._readCache = new Map();  // 读端点(dashboard/tagged)短缓存，降低限流概率
    // 设备会话并发上限：单代理出口(10808)被高并发 CONNECT 淹没是 08-20 全面失败根因。
    // 实测 4 并发 chromium 上下文即可把单代理 ESTABLISHED 连接打到 180+，挤垮 OAuth API。
    // 故严格串行（max=1）：任意时刻最多 1 个设备会话在进行，单代理几乎全留给 API 养号。
    // 设备会话仅作「移动端消费」指纹对齐的轻量背景点缀，不抢 API 带宽。
    this._deviceSem = new Semaphore(1);
    this._deviceStaggerMs = 1500; // 每个账号触发设备会话前的基础错峰间隔（叠加随机）

    // ── 多出口代理池 + 按账号分配出口 IP（429 限流根因缓解） ──
    this.proxyPool = new ProxyPool();
    if (this.publisher && typeof this.publisher.setProxyResolver === 'function') {
      this.publisher.setProxyResolver((accountId) => this.proxyPool.forAccount(accountId));
      // 出口健康回传：429/连续失败 → 冷却该出口，账号自动切到其它出口（修复空转）
      if (typeof this.publisher.setProxyReporter === 'function') {
        this.publisher.setProxyReporter((url, r) => this.proxyPool.report(url, r));
      }
    }

    // ── 每账号操作日志 + 每日进度（持久化，供后台/看板下钻与汇总） ──
    this._logModule = 'tumblr_action_log';        // 每账号一条记录，内含有界数组
    this._dailySummaryModule = 'tumblr_daily_summary';
    this._lastSummaryDate = null;
    this._initLogging();
  }

  // 订阅引擎事件 → 写入每账号操作日志（同步、零阻塞；任何失败静默吞掉，不影响养号）
  _initLogging() {
        this.on('nurture:action', (e) => {
          try {
            const phase = (this.states.get(e.accountId) || {}).phase || null;
            this._appendActionLog(e.accountId, {
              kind: 'api', type: e.type, ok: e.ok,
              error: e.error || null, detail: e.detail || null, phase, meta: e.meta || null,
            });
          } catch (_) {}
        });
    this.on('nurture:device', (e) => {
      try {
        const s = e.summary || {};
        this._appendActionLog(e.accountId, {
          kind: 'device', ok: s.ok !== false, error: s.error || null,
          visited: s.visited || [], tag: s.tag || null, readPosts: s.readPosts || 0,
          durationMs: s.durationMs || 0,
        });
      } catch (_) {}
    });
    this.on('nurture:phase', (e) => {
      try { this._appendActionLog(e.accountId, { kind: 'phase', type: e.phase, day: e.day, ok: true }); } catch (_) {}
    });
    this.on('nurture:tagged', (e) => {
      try { this._appendActionLog(e.accountId, { kind: 'tagged', tag: e.tag, ok: true }); } catch (_) {}
    });
  }

  // 追加一条操作日志到该账号的有界数组（最多保留 _LOG_MAX 条，超出丢弃最旧）
  _appendActionLog(accountId, entry) {
    if (!accountId) return;
    const ts = new Date().toISOString();
    const rec = this.dataStore.get(this._logModule, accountId) || { id: accountId, logs: [] };
    rec.logs = rec.logs || [];
    rec.logs.push(Object.assign({ ts }, entry));
    // P0-3 大文件治理：条数上限 + 时间窗口双重约束。
    // 原实现仅截断到 500 条且无时间窗 —— 90 个账号即膨胀到 8.2MB（单条最大 171KB），
    // 大文件单次写入耗时长，写入期间独占文件，易触发 EPERM 锁冲突（见 08-29 故障）。
    // 保留最近 {LOGS_KEEP_DAYS} 天内的最多 {LOGS_MAX} 条，既够养号进度展示又可控。
    const LOGS_MAX = Number(process.env.TUMBLR_LOG_MAX || 120);
    const LOGS_KEEP_DAYS = Number(process.env.TUMBLR_LOG_KEEP_DAYS || 7);
    const cutoff = Date.now() - LOGS_KEEP_DAYS * 86400000;
    if (rec.logs.length) {
      rec.logs = rec.logs.filter((l) => {
        const t = Date.parse(l.ts || 0);
        return Number.isNaN(t) || t >= cutoff;   // 无法解析时间的条目保守保留
      });
    }
    if (rec.logs.length > LOGS_MAX) rec.logs = rec.logs.slice(-LOGS_MAX);
    rec.updatedAt = ts;
    if (this.dataStore.get(this._logModule, accountId)) this.dataStore.update(this._logModule, accountId, rec);
    else this.dataStore.create(this._logModule, rec);
  }

  // 取某账号最近的操作日志（默认 50 条）
  getActionLog(accountId, limit = 50) {
    const rec = this.dataStore.get(this._logModule, accountId);
    if (!rec || !rec.logs) return [];
    return rec.logs.slice(-limit).reverse();
  }

  // 全局最近操作日志（跨账号，默认 80 条，按时间倒序）
  getRecentLogs(limit = 80) {
    const logs = [];
    const all = this.dataStore.list(this._logModule, { limit: 1000 }).items;
    for (const rec of all) {
      for (const l of (rec.logs || [])) logs.push(Object.assign({ accountId: rec.id }, l));
    }
    logs.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
    return logs.slice(0, limit);
  }

  /**
   * 汇总某一天的养号进度（从状态 + 操作日志聚合）。
   * @param {string} date YYYY-MM-DD（缺省=今天）
   */
  dailySummary(date) {
    const day = date || this._todayKey();
    // 已持久化的历史汇总优先
    const cached = this.dataStore.get(this._dailySummaryModule, day);
    const states = this.dataStore.list('tumblr_nurture', { limit: 2000 }).items;
    const accounts = this.dataStore.list('accounts', { filter: { platform: 'tumblr' }, limit: 1000 }).items;

    const phases = {};
    let totalActions = 0, follows = 0, likes = 0, reblogs = 0, posts = 0, comments = 0;
    let deviceSessions = 0, errors = 0, okActions = 0;
    let newRegistrations = 0, taggedNormal = 0;
    // 当日操作日志聚合（精确计数）
    const todayLogs = [];
    const allLogs = this.dataStore.list(this._logModule, { limit: 2000 }).items;
    for (const rec of allLogs) {
      for (const l of (rec.logs || [])) {
        if ((l.ts || '').slice(0, 10) === day) todayLogs.push(Object.assign({ accountId: rec.id }, l));
      }
    }
    for (const l of todayLogs) {
      if (l.kind === 'device') { deviceSessions++; if (l.ok === false) errors++; }
      else if (l.kind === 'api') { if (l.ok) { okActions++; } else { errors++; } }
    }

    // 当天各动作计数以状态里的 st.daily[day] 为准（即使操作日志是刚启用、历史为空，也能还原真实当日进度）
    for (const s of states) {
      const d = (s.daily && s.daily[day]) || {};
      follows += d.follow || 0;
      likes += d.like || 0;
      reblogs += d.reblog || 0;
      posts += d.post || 0;
      comments += d.comment || 0;
    }
    okActions = follows + likes + reblogs + posts + comments; // 当日成功 API 动作合计

    for (const s of states) { const p = s.phase || 'none'; phases[p] = (phases[p] || 0) + 1; totalActions += (s.totalActions || 0); }

    for (const a of accounts) {
      if (a.status === 'terminated') continue;
      if ((a.createdAt || '').slice(0, 10) === day) newRegistrations++;
      if (Array.isArray(a.tags) && a.tags.includes('正常')) taggedNormal++;
    }

    return {
      date: day,
      totalAccounts: accounts.filter((a) => a.status !== 'terminated').length,
      newRegistrations,
      taggedNormal,
      phases,
      actions: { follow: follows, like: likes, reblog: reblogs, post: posts, comment: comments, deviceSessions, okActions, errors, totalActionsFromStates: totalActions },
      proxyPoolSize: this.proxyPool.count(),
      generatedAt: new Date().toISOString(),
      // 注：本函数始终基于 st.daily[day] + 当日操作日志实时聚合，数字为实时值；
      // “cached” 仅表示当天是否存在历史落盘文件（用于跨日归档），不代表数字来自陈旧缓存。
      cached: false,
    };
  }

  // 在每日首次 tick 时，把「昨天」的汇总落盘（保留历史，服务重启也不丢）
  _maybePersistDailySummary() {
    const today = this._todayKey();
    if (this._lastSummaryDate === today) return;
    this._lastSummaryDate = today;
    try {
      // 落盘昨天的汇总（若存在）；首次运行则落今天的
      const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      const target = (this.dataStore.get(this._dailySummaryModule, yesterday)) ? yesterday : today;
      const sum = this.dailySummary(target);
      const existing = this.dataStore.get(this._dailySummaryModule, target);
      if (existing) this.dataStore.update(this._dailySummaryModule, target, sum);
      else this.dataStore.create(this._dailySummaryModule, Object.assign({ id: target }, sum));
    } catch (_) {}
  }

  // ── 加载账号 + persona + state ──
  // ⚠️【2026-09-08 P2】原硬编码 limit:100 导致 271 个账号仅 100 个被纳管，
  //   171 个账号永远不养号、不进因果链，是「发布覆盖率仅 77/271」的直接原因之一。
  //   纳管 ≠ 全部并发：动作执行仍受 activeWindow / caps 配额与代理出口数限流，
  //   因此放开纳管不会打爆代理，只是让全部账号进入状态机与健康分评估。
  load() {
    const maxAccounts = Number(process.env.NURTURE_MAX_ACCOUNTS || 1000);
    const accts = this.dataStore.list('accounts', { filter: { platform: 'tumblr' }, limit: maxAccounts }).items
      .filter(a => a.status !== 'terminated'); // 跳过被 Tumblr 终止的死账号
    this.accounts = accts;
    for (const a of accts) {
      const persona = this._ensurePersona(a);
      this.personas.set(a.id, persona);
      const st = this._loadState(a.id) || this._initState(a.id);
      this.states.set(a.id, st);
    }
    this.emit('nurture:loaded', { count: this.accounts.length });
    return this.accounts.length;
  }

  // 接入移动端设备池（由 3003 服务在 TUMBLR_NURTURE_DEVICE=1 时调用）
  setDevice(pool) {
    this.device = pool;
    this.emit('nurture:device-set', { proxy: pool ? pool.proxy : null });
  }

  // 为所有已加载账号分配移动上下文并同步 UA 到 publisher（使 API 与移动网页指纹对齐）
  async syncDeviceUA() {
    if (!this.device) return;
    const ok = await this.device.launch();
    if (!ok) { this.emit('nurture:device-disabled', { reason: this.device.disableReason }); return; }
    // ⚠️ 不再预拉起常驻浏览器：设备池改为「按需临时启动、会话后关闭」（空闲零代理连接，不挤占 API 出口）
    await Promise.all(this.accounts.map(async (a) => {
      // 幂等：已分配指纹的账号跳过，避免重启/重载时重复分配
      if (this.device.getDevice(a.id)) {
        this.publisher.setAccountUA(a.id, this.device.getUA(a.id));
        return;
      }
      const persona = this.personas.get(a.id);
      const entry = await this.device.assignDevice(a.id, { tzOffset: persona ? persona.tzOffset : 0 }).catch(() => null);
      if (entry) {
        this.publisher.setAccountUA(a.id, entry.ua);
        // 立即把设备型号写入 state，使看板在首会话前就能显示每个账号的移动设备
        const st = this.states.get(a.id);
        if (st) { st.device = st.device || { model: null, sessions: 0, lastSessionAt: null }; st.device.model = entry.device.name; this._persist(st); }
      }
    }));
    this.emit('nurture:device-synced', { contexts: this.device._uaByAccount ? this.device._uaByAccount.size : 0 });
  }

  // 养号完成（到达 P4 成熟期）时，在真实账户记录上打「正常」标签，便于后台识别健康账号
  _tagAccountNormal(accountId) {
    try {
      const rec = this.dataStore.get('accounts', accountId);
      if (!rec) return;
      const tags = Array.isArray(rec.tags) ? rec.tags : [];
      if (tags.includes('正常')) return; // 已标记，幂等
      this.dataStore.update('accounts', accountId, { tags: [...tags, '正常'], status: 'active' });
      this.emit('nurture:tagged', { accountId, tag: '正常' });
      console.log(`[tumblr-nurture] 账号 ${accountId} 养号完成，已打标签「正常」`);
    } catch (e) {
      console.error(`[tumblr-nurture] 打标签失败 ${accountId}: ${e.message}`);
    }
  }

  _ensurePersona(account) {
    const existing = this.dataStore.get('tumblr_persona', account.id);
    if (existing && existing.realName) return existing;
    const rng = mulberry32(hashStr(account.id));
    const realName = pick(rng, FIRST_NAMES) + ' ' + String.fromCharCode(65 + randInt(rng, 0, 25)) + '.';
    const voice = pick(rng, VOICES);
    const title = pick(rng, BLOG_TITLES[voice]);
    // 活跃窗口：本地时区估计（随机偏移避免所有号同时在线被关联）
    const startH = randInt(rng, 7, 10);
    const endH = randInt(rng, 21, 24);
    const persona = {
      id: account.id,
      realName,
      voice,
      title,
      bio: VOICE_BIO[voice],
      activeStartHour: startH,
      activeEndHour: endH,
      tzOffset: randInt(rng, -5, 3),   // 模拟不同时区账号
      appetite: { like: 0.45, reblog: 0.2, follow: 0.15, post: 0.15, comment: 0.05 },
      interests: ['dating', 'relationships', 'love', 'selflove', 'breakup'],
      createdAt: new Date().toISOString(),
    };
    this.dataStore.create('tumblr_persona', persona);
    return persona;
  }

  _loadState(id) { return this.dataStore.get('tumblr_nurture', id); }
  _initState(id) {
    const now = new Date().toISOString();
    const st = {
      id,
      phase: 'P0',
      day: 0,
      startedAt: now,
      lastActionAt: null,
      nextActionAt: now,
      daily: {},   // { 'YYYY-MM-DD': { follow, like, reblog, post, comment } }
      totalActions: 0,
      real: { followers: 0, following: 0, posts: 0, likes: 0 },
      lastError: null,
      lastApi: null,
      device: { model: null, sessions: 0, lastSessionAt: null }, // 移动端消费会话记录
      nextDeviceSessionAt: null, // 下次允许的移动端会话时间（节流）
      updatedAt: now,
    };
    this.dataStore.create('tumblr_nurture', st);
    return st;
  }

  _todayKey() { return new Date().toISOString().slice(0, 10); }
  _dayCount(st, type) {
    const t = this._todayKey();
    return (st.daily[t] && st.daily[t][type]) || 0;
  }
  _incDay(st, type, n = 1) {
    const t = this._todayKey();
    if (!st.daily[t]) st.daily[t] = {};
    st.daily[t][type] = (st.daily[t][type] || 0) + n;
  }

  // 读端点短缓存（5 分钟 TTL）：dashboard/tagged 是 Tumblr 限流重灾区，跨账号/跨 tick 复用可显著降低调用量
  _cacheGet(key) { const e = this._readCache.get(key); return (e && Date.now() - e.t < 300000) ? e.v : null; }
  _cacheSet(key, v) { this._readCache.set(key, { t: Date.now(), v }); }

  // 命中 Tumblr 429「Limit Exceeded」→ 按【该账号出口 IP】进入 API 冷却（默认 20 分钟）。
  // 多出口 IP 下，仅冻结走同一出口 IP 的账号，其它出口 IP 的账号照常养号——避免「一个 IP 被限流，61 个账号全停」。
  // 单出口（仅 10808）时退化为全局冷却，与原行为一致。
  // （移动端消费会话是浏览器行为，不受 API 限流影响，照常进行以维系真人足迹）
  _on429(accountId) {
    const COOLDOWN = 20 * 60000;
    const key = (accountId && this.proxyPool) ? this.proxyPool.forAccount(accountId) : null;
    const now = Date.now();
    if (key) {
      const until = this._apiCooldownMap.get(key) || 0;
      if (now < until) return;
      this._apiCooldownMap.set(key, now + COOLDOWN);
    } else {
      if (now < this._apiCooldownUntil) return;
      this._apiCooldownUntil = now + COOLDOWN;
    }
    this.emit('nurture:rate429', {
      accountId: accountId || null,
      proxy: key || '(global)',
      cooldownMs: COOLDOWN,
      until: new Date(now + COOLDOWN).toISOString(),
    });
  }
  _inApiCooldown(accountId) {
    const now = Date.now();
    const key = (accountId && this.proxyPool) ? this.proxyPool.forAccount(accountId) : null;
    if (key) return now < (this._apiCooldownMap.get(key) || 0);
    return now < this._apiCooldownUntil;
  }
  /** 看板/接口用：返回各出口 IP 的冷却剩余秒数（key=proxyUrl 或 'global'） */
  _apiCooldownView() {
    const out = {};
    const now = Date.now();
    if (this._apiCooldownUntil > now) out['(global)'] = Math.ceil((this._apiCooldownUntil - now) / 1000);
    for (const [k, v] of this._apiCooldownMap) {
      if (v > now) out[k] = Math.ceil((v - now) / 1000);
    }
    return out;
  }

  async _ownBlogName(accountId) {
    // 内存缓存，避免回写共享的 tumblr_token 文件（独立 nurture 进程不污染主服务数据）
    if (this._blogCache && this._blogCache.has(accountId)) return this._blogCache.get(accountId);
    const tok = this.dataStore.get('tumblr_token', accountId);
    if (tok && tok.blogName) { this._blogCache.set(accountId, tok.blogName); return tok.blogName; }
    try {
      const info = await this.publisher.getUserInfo(accountId);
      const b = info.blogs && info.blogs[0] && (info.blogs[0].name || (info.blogs[0].url || '').replace(/^https?:\/\//, '').replace(/\.tumblr\.com\/?$/, ''));
      if (b) { this._blogCache.set(accountId, b); return b; }
    } catch (_) {}
    return null;
  }

  // 账号当前是否在「活跃窗口」内（基于 persona 时区偏移）
  _inActiveWindow(persona) {
    const utcH = new Date().getUTCHours();
    const localH = (utcH + persona.tzOffset + 24) % 24;
    return localH >= persona.activeStartHour && localH < persona.activeEndHour;
  }

  // ── 真实动作封装（任一失败都如实记录，绝不伪造） ──
  async _act(accountId, type, fn, meta) {
    const st = this.states.get(accountId);
    if (!st) return { ok: false, reason: 'no-state' };
    // 全局速率优先
    if (!this.governor.canProceed(1)) {
      this.emit('nurture:rate', { accountId, type, global: this.governor.snapshot() });
      return { ok: false, reason: 'global-rate' };
    }
    // 429 冷却期：不 hammering，静待 Tumblr 限流窗口恢复（按该账号出口 IP 分桶）
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    // 日上限
    if (this._dayCount(st, type) >= DAILY_CAPS[type]) {
      return { ok: false, reason: 'daily-cap' };
    }
    this.governor.consume(1);
    try {
      const detail = await fn();
      this._incDay(st, type, 1);
      st.totalActions++;
      st.lastActionAt = new Date().toISOString();
      st.lastApi = { type, ok: true, at: st.lastActionAt, detail: detail || null };
      st.lastError = null;
      this._persist(st);
      this.emit('nurture:action', { accountId, type, ok: true, detail, meta: meta || null });
      return { ok: true, detail };
    } catch (e) {
      if (/429|Limit Exceeded/i.test(e.message)) this._on429(accountId);
      st.lastError = `${type}:${e.message}`;
      st.lastApi = { type, ok: false, at: new Date().toISOString(), err: e.message };
      this._persist(st);
      this.emit('nurture:action', { accountId, type, ok: false, error: e.message, meta: meta || null });
      return { ok: false, reason: e.message };
    }
  }

  _persist(st) {
    st.updatedAt = new Date().toISOString();
    this.dataStore.update('tumblr_nurture', st.id, st);
  }

  _advancePhase(st, toPhase, day) {
    if (st.phase !== toPhase) {
      st.phase = toPhase;
      st.day = day;
      this._persist(st);
      this.emit('nurture:phase', { accountId: st.id, phase: toPhase, day });
      // 养号完成（成熟期）→ 真实账户打「正常」标签
      if (toPhase === 'P4') this._tagAccountNormal(st.id);
    } else {
      st.day = day;
    }
  }

  // Promise 超时封装（移动端会话可能受外网影响卡住，必须硬性兜底）
  _withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('device-session-timeout')), ms))]);
  }

  // 执行一次真实移动端消费会话（公开 tumblr 移动网页浏览），并写入 state/设备池日志
  async _runDeviceSession(accountId, persona) {
    if (!this.device) return null;
    const blog = await this._ownBlogName(accountId).catch(() => null);
    const summary = await this._withTimeout(
      this.device.openSession(accountId, { tags: CONSUME_TAGS, ownBlog: blog, overrides: { tzOffset: persona ? persona.tzOffset : 0 } }),
      120000
    ).catch((e) => ({ ok: false, error: e.message }));
    const st = this.states.get(accountId);
    if (st) {
      st.device = st.device || { model: null, sessions: 0, lastSessionAt: null };
      const dev = this.device.getDevice(accountId);
      if (dev) st.device.model = dev.device.name;
      st.device.sessions = (dev && dev.sessions) || st.device.sessions || 0;
      st.device.lastSessionAt = (summary && summary.endedAt) ? new Date(summary.endedAt).toISOString() : new Date().toISOString();
      // 节流：每账号约每 40-60 分钟一次移动端会话（模拟真人零星刷手机，不刷屏）
      st.nextDeviceSessionAt = new Date(Date.now() + 40 * 60000 + Math.floor(Math.random() * 20 * 60000)).toISOString();
      this._persist(st);
    }
    this.emit('nurture:device', { accountId, summary });
    return summary;
  }

  // 生成富内容原创帖：按人格 voice 注入开场白/收尾语，正文仍来自真实种子池（零假数据）
  composePost(persona) {
    const seed = CONTENT_SEEDS[Math.floor(Math.random() * CONTENT_SEEDS.length)];
    const intros = {
      warm: 'okay, just thinking out loud —',
      witty: 'unpopular opinion incoming (again) —',
      reflective: 'something i keep coming back to —',
      bold: 'say it with me —',
      gentle: 'a soft reminder i needed today —',
    };
    const signoffs = {
      warm: 'sending love to whoever needed this.',
      witty: 'reblog if you’ve been personally victimized by dating.',
      reflective: 'that’s all i’ve got tonight.',
      bold: 'don’t let anyone tell you otherwise.',
      gentle: 'take what you need and leave the rest.',
    };
    const intro = intros[persona.voice] || '';
    const signoff = signoffs[persona.voice] || '';
    const body = (intro ? intro + '\n\n' : '') + seed.body + (signoff ? '\n\n' + signoff : '');
    return { title: seed.title, body, tags: seed.tags };
  }

  // 生成纯色 PNG 头像（占位，给真实账号一个可见头像；Tumblr 头像是强身份信号）
  _genAvatarPng(persona) {
    const zlib = require('zlib');
    const palette = { warm: [230, 160, 150], witty: [150, 180, 230], reflective: [170, 150, 220], bold: [230, 130, 130], gentle: [150, 210, 180] };
    const [r, g, b] = palette[persona.voice] || [180, 180, 200];
    const size = 256;
    const raw = Buffer.alloc(size * (1 + size * 4));
    let o = 0;
    for (let y = 0; y < size; y++) { raw[o++] = 0; for (let x = 0; x < size; x++) { raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = 255; } }
    const idat = zlib.deflateSync(raw);
    const crc32 = (type, data) => { const buf = Buffer.concat([Buffer.from(type, 'ascii'), data]); let c = ~0; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1)); } const out = Buffer.alloc(4); out.writeUInt32BE((~c) >>> 0, 0); return out; };
    const chunk = (type, data) => Buffer.concat([(() => { const l = Buffer.alloc(4); l.writeUInt32BE(data.length, 0); return l; })(), Buffer.from(type, 'ascii'), data, crc32(type, data)]);
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
  }

  // ── 各阶段真实动作 ──
  // P0 资料完善：确认博客存在(真实调用) + 尝试上传头像。
  // 注意：本 OAuth App 的 avatar/title 编辑接口受 scope 限制（返回 "You must supply the source for the image"），
  // 因此如实记录，不伪造成功；阶段仍推进（账号本身是真实授权的 Tumblr 博客）。
  async doProfileComplete(accountId) {
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    const blog = await this._ownBlogName(accountId);
    if (!blog) return { ok: false, reason: 'no-blog' };
    const persona = this.personas.get(accountId);
    let confirmed = false;
    try { const info = await this.publisher.blogInfo(blog, accountId); confirmed = !!(info && info.name); } catch (_) {}
    let avatar = 'skipped';
    try {
      const png = this._genAvatarPng(persona);
      const tmp = tmpFile(`_tmp_avatar_${accountId}.png`);
      fs.writeFileSync(tmp, png);
      await this.publisher.updateAvatar(blog, tmp, accountId);
      avatar = 'ok';
      try { fs.unlinkSync(tmp); } catch (_) {}
    } catch (e) {
      avatar = 'unavailable';
    }
    return { ok: true, blog, confirmed, avatar, title: persona.title, note: 'title/desc 编辑 API 受 scope 限制，未推送（如实记录）' };
  }

  // 从 dashboard 找小博主帖子并点赞（消费）
  async doObserveLike(accountId, n) {
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    let posts = this._cacheGet('dash:' + accountId);
    if (!posts) {
      try { posts = await this.publisher.getDashboard({ limit: 20 }, accountId); }
      catch (e) { if (/429|Limit Exceeded/i.test(e.message)) this._on429(accountId); throw e; }
      this._cacheSet('dash:' + accountId, posts || []);
    }
    posts = posts || [];
    let done = 0;
    for (const p of posts) {
      if (done >= n) break;
      if (!p || !p.id_string || !p.reblog_key) continue;
      // 跳过自己/大博主：只给小博主点赞（notes 少）
      const notes = (p.note_count || p.notes_remaining || 0);
      if (notes > 5000) continue;
      const r = await this._act(accountId, 'like', () => this.publisher.likePost(p.id_string, p.reblog_key, accountId), { postId: p.id_string });
      if (r.ok) done++;
      await new Promise(res => setTimeout(res, gaussian(1500, 800)));
    }
    return { ok: true, liked: done };
  }

  // 发现 dating/relationship 博主并关注若干
  async doFollowDating(accountId, n) {
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    const tag = pick(Math.random, DISCOVER_TAGS) || DISCOVER_TAGS[0];
    let posts = this._cacheGet('tag:' + tag);
    if (!posts) {
      try { posts = await this.publisher.taggedPosts(tag, { limit: 20 }, accountId); }
      catch (e) { if (/429|Limit Exceeded/i.test(e.message)) this._on429(accountId); throw e; }
      this._cacheSet('tag:' + tag, posts || []);
    }
    posts = posts || [];
    let done = 0;
    for (const p of posts) {
      if (done >= n) break;
      const blog = p.blog_name || (p.blog && p.blog.name);
      if (!blog) continue;
      const info = await this.publisher.blogInfo(blog, accountId).catch(() => ({}));
      const followers = info.followers || 0;
      if (followers > 50000) continue; // 只关注中小博主，像真人
      const r = await this._act(accountId, 'follow', () => this.publisher.followBlog(blog, accountId), { blog });
      if (r.ok) done++;
      await new Promise(res => setTimeout(res, gaussian(4000, 2000)));
    }
    return { ok: true, followed: done, tag };
  }

  // 原创情感帖（带思考时长模拟 + 人格 voice 富内容）
  async doOriginalPost(accountId) {
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    const blog = await this._ownBlogName(accountId);
    if (!blog) return { ok: false, reason: 'no-blog' };
    const persona = this.personas.get(accountId);
    // 发帖前「思考时长」：真人写帖会犹豫
    await new Promise(res => setTimeout(res, gaussian(8000, 4000)));
    const post = this.composePost(persona || { voice: 'warm' });
    const r = await this._act(accountId, 'post', () => this.publisher.postText(blog, { title: post.title, body: post.body, tags: post.tags }, accountId), { blog, title: post.title });
    return { ok: true, postUrl: (r && r.detail && r.detail.postUrl) || null, title: post.title };
  }

  // reblog 一条 dating 帖子（带 commentary，Tumblr 文化）
  async doReblog(accountId, n) {
    if (this._inApiCooldown(accountId)) return { ok: false, reason: 'api-cooldown' };
    // ⚠️ 修复：reblog 必须发到【自己的博客】(POST /blog/{自己的blog}/post/reblog)，
    //   不能把源帖作者的 blog(p.blog_name) 当目标——否则 Tumblr 返回 404，导致 reblog 100% 失败。
    const ownBlog = await this._ownBlogName(accountId).catch(() => null);
    if (!ownBlog) return { ok: false, reason: 'no-own-blog' };
    const tag = pick(Math.random, DISCOVER_TAGS) || DISCOVER_TAGS[0];
    let posts = this._cacheGet('tag:' + tag);
    if (!posts) {
      try { posts = await this.publisher.taggedPosts(tag, { limit: 20 }, accountId); }
      catch (e) { if (/429|Limit Exceeded/i.test(e.message)) this._on429(accountId); throw e; }
      this._cacheSet('tag:' + tag, posts || []);
    }
    posts = posts || [];
    let done = 0;
    const comments = ['so real', 'reblogging for the girlies', 'needed this today', 'this.', 'say it louder', 'literally me', 'truth', 'bookmarking'];
    for (const p of posts) {
      if (done >= n) break;
      if (!p || !p.id_string || !p.reblog_key) continue;
      const c = comments[Math.floor(Math.random() * comments.length)];
      // 目标博客=自己的博客；id/reblog_key 用源帖的（Tumblr reblog 语义）
      const r = await this._act(accountId, 'reblog', () => this.publisher.reblogPost(ownBlog, { id: p.id_string, reblogKey: p.reblog_key, comment: c }, accountId), { blog: ownBlog, postId: p.id_string });
      if (r.ok) done++;
      await new Promise(res => setTimeout(res, gaussian(3000, 1500)));
    }
    return { ok: true, reblogged: done, tag };
  }

  // ── 单账号单 tick 调度（按阶段推进真实动作） ──
  async tickAccount(accountId) {
    const st = this.states.get(accountId);
    const persona = this.personas.get(accountId);
    if (!st || !persona) return;
    if (!this._inActiveWindow(persona)) return;            // 错峰：非活跃时段不动作
    if (st.nextActionAt && Date.now() < new Date(st.nextActionAt).getTime()) return; // 还没到下次动作

    // 缺 token 守卫（B8）：注册后若 token 未同步（或曾被 prune），跳过养号动作，避免每 tick 静默报「未授权」刷屏淹没真实错误；
    // 一旦 /api/reload 同步到 token，下个 tick 自动清掉 noToken 标记并恢复养号。
    const _tok = this.dataStore.get('tumblr_token', accountId);
    if (!_tok || !_tok.oauthToken) {
      if (!st.noToken) { st.noToken = true; this._persist(st); this.emit('nurture:no-token', { accountId }); console.warn(`[tumblr-nurture] 账号 ${accountId} 缺 token，跳过养号（注册后请触发 /api/reload 同步 token）`); }
      return;
    }
    if (st.noToken) { st.noToken = false; this._persist(st); }

    const dayOfLife = Math.floor((Date.now() - new Date(st.startedAt).getTime()) / 86400000) + 1;

    try {
      // 移动端消费会话（真实移动网页浏览）：P1+ 每账号约每 40-60 分钟一次。
      // ⚠️ 修复：旧实现 await 设备会话（最长 120s），代理过载时设备会话失败/卡死会【阻塞】本 tick 的
      //   API 养号动作（关注/点赞/reblog/发文），导致核心养号动作长期 0 执行。
      //   现改为【非阻塞触发】——设备会话异步跑（独立 try），本 tick 立即继续做 API 动作，二者解耦。
      if (this.device && st.phase !== 'P0' && (!st.nextDeviceSessionAt || Date.now() >= new Date(st.nextDeviceSessionAt).getTime())) {
        // ⚠️ 修复：首跑错峰 + 并发闸。
        // 旧逻辑在重启后所有账号 nextDeviceSessionAt 为空 → 同 tick 并发 45 个浏览器导航 → 单代理被淹 → API 全面 fetch failed。
        // 现：① 首次触发(无 nextDeviceSessionAt)时把下次会话时间错峰到未来 0~25 分钟，分散负载；
        //     ② 用信号量限制同时进行的设备会话数(默认 4)，超出排队，避免压垮单代理出口。
        const isFirst = !st.nextDeviceSessionAt;
        const baseDelay = isFirst ? Math.floor(Math.random() * 30 * 60000) : 0;
        // 设备会话极稀疏（每 3-4 小时/账号）：单代理串行 1 个会话，仅占 API 带宽的零头。
        // 旧值 40-60 分钟在 45 账号下会话过于密集（叠加串行也持续占用代理），故拉长。
        st.nextDeviceSessionAt = new Date(Date.now() + baseDelay + 180 * 60000 + Math.floor(Math.random() * 60 * 60000)).toISOString();
        this._persist(st);
        // 并发闸：最多 N 个设备会话同时进行
        this._deviceSem.acquire().then(async () => {
          try { await this._runDeviceSession(accountId, persona); }
          catch (e) { this.emit('nurture:device-error', { accountId, error: e.message }); }
          finally { this._deviceSem.release(); }
        });
      }

      if (st.phase === 'P0') {
        // 资料完善（一次性）：设置博客标题/简介，不计入生产上限
        const pr = await this.doProfileComplete(accountId).catch(e => ({ ok: false, reason: e.message }));
        this.emit('nurture:profile', { accountId, ok: pr.ok, blog: pr.blog });
        this._advancePhase(st, 'P1', 1);
        st.nextActionAt = new Date(Date.now() + gaussian(3600000, 1800000)).toISOString();
        this._persist(st);
        return;
      }

      if (st.phase === 'P1') {
        // 观察期：纯消费（点赞小博主），不关注不发文
        const plan = Math.min(DAILY_CAPS.like, 8); // P1 每天 ≤8 赞
        const remain = plan - this._dayCount(st, 'like');
        if (remain > 0) {
          const r = await this.doObserveLike(accountId, Math.min(remain, 3));
          this.emit('nurture:observe', { accountId, liked: r.liked });
        }
        if (dayOfLife >= 3) this._advancePhase(st, 'P2', dayOfLife);
        st.nextActionAt = new Date(Date.now() + gaussian(1800000, 900000)).toISOString();
        this._persist(st);
        return;
      }

      if (st.phase === 'P2') {
        // 轻度互动：关注 3-5/天 + 赞 15-25/天 + reblog 1-2/天 + 首帖（本阶段 1 帖）
        const followRemain = Math.min(5, DAILY_CAPS.follow) - this._dayCount(st, 'follow');
        const likeRemain = Math.min(25, DAILY_CAPS.like) - this._dayCount(st, 'like');
        const reblogRemain = Math.min(2, DAILY_CAPS.reblog) - this._dayCount(st, 'reblog');
        const postRemain = Math.min(1, DAILY_CAPS.post) - this._dayCount(st, 'post');
        // 动作顺序随机化 + 消费优先
        const actions = [];
        if (likeRemain > 0) actions.push('like');
        if (reblogRemain > 0) actions.push('reblog');
        if (followRemain > 0) actions.push('follow');
        if (postRemain > 0) actions.push('post');
        // 随机打散
        for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
        // 每 tick 只做 1 个动作（零星使用）
        const one = actions[0];
        if (one === 'like') await this.doObserveLike(accountId, 2);
        else if (one === 'reblog') await this.doReblog(accountId, 1);
        else if (one === 'follow') await this.doFollowDating(accountId, 1);
        else if (one === 'post') await this.doOriginalPost(accountId);
        if (dayOfLife >= 7) this._advancePhase(st, 'P3', dayOfLife);
        st.nextActionAt = new Date(Date.now() + gaussian(1500000, 800000)).toISOString();
        this._persist(st);
        return;
      }

      if (st.phase === 'P3') {
        // 内容沉淀：1 原创/天 + reblog 3-5/天 + 关注 3-5/天 + 赞 20-30/天
        const followRemain = Math.min(5, DAILY_CAPS.follow) - this._dayCount(st, 'follow');
        const likeRemain = Math.min(30, DAILY_CAPS.like) - this._dayCount(st, 'like');
        const reblogRemain = Math.min(5, DAILY_CAPS.reblog) - this._dayCount(st, 'reblog');
        const postRemain = Math.min(1, DAILY_CAPS.post) - this._dayCount(st, 'post');
        const actions = [];
        if (likeRemain > 0) actions.push('like');
        if (reblogRemain > 0) actions.push('reblog');
        if (followRemain > 0) actions.push('follow');
        if (postRemain > 0) actions.push('post');
        for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
        const one = actions[0];
        if (one === 'like') await this.doObserveLike(accountId, 3);
        else if (one === 'reblog') await this.doReblog(accountId, 2);
        else if (one === 'follow') await this.doFollowDating(accountId, 2);
        else if (one === 'post') await this.doOriginalPost(accountId);
        if (dayOfLife >= 14) this._advancePhase(st, 'P4', dayOfLife);
        st.nextActionAt = new Date(Date.now() + gaussian(1200000, 700000)).toISOString();
        this._persist(st);
        return;
      }

      if (st.phase === 'P4') {
        // 成熟期：稳定日更 1-2 帖 + reblog 3-5 + 关注≤8 + 赞≤50
        const followRemain = Math.min(8, DAILY_CAPS.follow) - this._dayCount(st, 'follow');
        const likeRemain = Math.min(50, DAILY_CAPS.like) - this._dayCount(st, 'like');
        const reblogRemain = Math.min(5, DAILY_CAPS.reblog) - this._dayCount(st, 'reblog');
        const postRemain = Math.min(DAILY_CAPS.post, 2) - this._dayCount(st, 'post');
        const actions = [];
        if (likeRemain > 0) actions.push('like');
        if (reblogRemain > 0) actions.push('reblog');
        if (followRemain > 0) actions.push('follow');
        if (postRemain > 0) actions.push('post');
        for (let i = actions.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [actions[i], actions[j]] = [actions[j], actions[i]]; }
        const one = actions[0];
        if (one === 'like') await this.doObserveLike(accountId, 3);
        else if (one === 'reblog') await this.doReblog(accountId, 2);
        else if (one === 'follow') await this.doFollowDating(accountId, 2);
        else if (one === 'post') await this.doOriginalPost(accountId);
        st.nextActionAt = new Date(Date.now() + gaussian(900000, 500000)).toISOString();
        this._persist(st);
        return;
      }
    } catch (e) {
      if (/429|Limit Exceeded/i.test(e.message)) this._on429(accountId);
      st.lastError = 'tick:' + e.message;
      this._persist(st);
      this.emit('nurture:error', { accountId, error: e.message });
    }
  }

  // ── 启动循环 ──
  // ⚠️ 关键修复：旧实现用 setInterval(loop, tickMs)，但 loop 是 async 且内部 await 每个账号的
  //    tickAccount（含最长 120s 的移动端会话）。当一轮耗时超过 tickMs，setInterval 会【未等上一轮
  //    完成就再触发新一轮】，导致多轮循环并发跑 45 个账号的设备会话+API，全部压在单一代理出口上
  //    → 连接被 Tumblr 大量重置(ERR_CONNECTION_CLOSED)+429 → 全面失败 → 看门狗杀掉重启 → 死循环。
  //    改为「上一轮跑完才排下一轮」的链式 setTimeout，保证任意时刻最多一个循环在跑。
  start() {
    if (this._timer) return;
    this.load();
    this._gen++;
    const myGen = this._gen;
    const loop = async () => {
      if (myGen !== this._gen) return; // 已被看门狗/新一次 start 取代，陈旧循环立即退出
      try {
        this._maybePersistDailySummary(); // 跨日时落盘昨日进度汇总
        for (const a of this.accounts) {
          if (myGen !== this._gen) return; // 中途被取代也立即退出
          await this.tickAccount(a.id).catch(e => this.emit('nurture:error', { accountId: a.id, error: e.message }));
        }
        this.emit('nurture:tick', this.snapshot());
      } catch (e) {
        this.emit('nurture:error', { error: e.message });
      } finally {
        // 仅当本代仍有效时排下一轮（避免重叠 + 失效循环继续跑）
        if (myGen === this._gen) this._timer = setTimeout(loop, this._tickMs);
      }
    };
    loop();
    this.emit('nurture:started', { count: this.accounts.length, tickMs: this._tickMs });
  }

  stop() {
    this._gen++; // 使任何在途循环立即失效（陈旧 await 不再排下一轮）
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this.emit('nurture:stopped');
  }

  // 指标快照（后台真实指标页用）
  snapshot() {
    const rows = [];
    for (const a of this.accounts) {
      const st = this.states.get(a.id);
      const persona = this.personas.get(a.id);
      const tok = this.dataStore.get('tumblr_token', a.id);
      rows.push({
        id: a.id,
        blog: (tok && tok.blogName) || null,
        authorized: !!(tok && tok.oauthToken),
        phase: st ? st.phase : '?',
        day: st ? st.day : 0,
        totalActions: st ? st.totalActions : 0,
        today: this._todayKey(),
        caps: DAILY_CAPS,
        todayCounts: st ? (st.daily[this._todayKey()] || {}) : {},
        lastActionAt: st ? st.lastActionAt : null,
        lastApi: st ? st.lastApi : null,
        lastError: st ? st.lastError : null,
        device: st && st.device ? { model: st.device.model, sessions: st.device.sessions, lastSessionAt: st.device.lastSessionAt } : null,
        voice: persona ? persona.voice : null,
        activeWindow: persona ? `${persona.activeStartHour}:00-${persona.activeEndHour}:00 (tz${persona.tzOffset})` : null,
      });
    }
    const counts = { P0: 0, P1: 0, P2: 0, P3: 0, P4: 0 };
    for (const r of rows) counts[r.phase] = (counts[r.phase] || 0) + 1;
    return { accounts: rows, global: this.governor.snapshot(), tickMs: this._tickMs, counts, apiCooldownUntil: this._apiCooldownUntil, apiCooldownByProxy: this._apiCooldownView() };
  }

  // ── 单账号立即跑指定阶段（dry-run / 手动用） ──
  async runPhaseNow(accountId, phase, opts = {}) {
    const st = this.states.get(accountId);
    if (!st) return { ok: false, reason: 'no-state' };
    if (phase === 'P0') return await this.doProfileComplete(accountId).catch(e => ({ ok: false, reason: e.message }));
    if (phase === 'P1') return await this.doObserveLike(accountId, opts.likes || 3);
    if (phase === 'P2') {
      const r1 = await this.doObserveLike(accountId, 2);
      const r2 = await this.doFollowDating(accountId, 2);
      const r3 = await this.doReblog(accountId, 1);
      return { ok: true, like: r1, follow: r2, reblog: r3 };
    }
    if (phase === 'P3' || phase === 'P4') {
      const r1 = await this.doObserveLike(accountId, 3);
      const r2 = await this.doFollowDating(accountId, 2);
      const r3 = await this.doReblog(accountId, 2);
      const r4 = await this.doOriginalPost(accountId);
      return { ok: true, like: r1, follow: r2, reblog: r3, post: r4 };
    }
    return { ok: false, reason: 'unknown-phase' };
  }
}

module.exports = { TumblrNurtureEngine, DAILY_CAPS, CONTENT_SEEDS, DISCOVER_TAGS, GlobalRateGovernor };
