/**
 * tumblr-batch-publish.js
 * 并发/分批真实视频发布调度器（零外部依赖）
 *  - 支持 concurrency（批次内并发数）与 batchSize + batchDelayMs（批次间间隔）
 *  - 每次成功发布：把视频拷贝进 D 盘独立任务文件夹
 *  - 任务结束：生成 publish_report.xlsx（含真实 postUrl）+ 整个文件夹压缩 zip
 *
 * 仅使用 Node 内置 zlib 实现最小可用 ZIP 与 XLSX（inlineStr，免 sharedStrings），
 * 不依赖任何 npm 包，避免污染受管 node_modules。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const PUBLISHED_ROOT = process.env.MSCMS_PUBLISHED_DIR || 'D:/MSCMS-Published';
const HISTORY_FILE = path.join(PUBLISHED_ROOT, 'history.json');

/* ============================ 最小 ZIP（deflate） ============================ */
function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = crc32._t = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { time: time & 0xFFFF, date: date & 0xFFFF };
}

/**
 * @param {Array<{name:string,data:Buffer}>} files
 * @returns {Buffer} 标准 ZIP 文件
 */
function zipSync(files) {
  const now = new Date();
  const { time, date } = dosDateTime(now);
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data);
    const crc = crc32(f.data);
    const uncomp = f.data.length;
    const compSize = comp.length;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(8, 8);      // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compSize, 18);
    lh.writeUInt32LE(uncomp, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBuf, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compSize, 20);
    ch.writeUInt32LE(uncomp, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + comp.length;
  }
  const centralBuf = Buffer.concat(central);
  const localBuf = Buffer.concat(local);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/* ============================ 最小 XLSX（inlineStr） ============================ */
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(i) {
  let s = '';
  i++;
  while (i > 0) {
    const r = (i - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/**
 * @param {string} sheetName
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @returns {Buffer} .xlsx 文件
 */
function buildXlsx(sheetName, headers, rows) {
  const sheetNameSafe = xmlEsc(sheetName || 'Sheet1').slice(0, 31);
  let sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>';
  const all = [headers, ...rows];
  all.forEach((row, ri) => {
    const r = ri + 1;
    sheet += `<row r="${r}">`;
    if (Array.isArray(row)) {
      row.forEach((cell, ci) => {
        const ref = colLetter(ci) + r;
        if (typeof cell === 'number' && isFinite(cell)) {
          sheet += `<c r="${ref}"><v>${cell}</v></c>`;
        } else {
          sheet += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(cell)}</t></is></c>`;
        }
      });
    }
    sheet += '</row>';
  });
  sheet += '</sheetData></worksheet>';

  const files = [
    { name: '[Content_Types].xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>') },
    { name: '_rels/.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>') },
    { name: 'xl/workbook.xml', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + `<sheets><sheet name="${sheetNameSafe}" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet) }
  ];
  return zipSync(files);
}

/* ============================ 拟人化 / 风控规避工具 ============================ */
// 确定性 RNG（按账号稳定产出，保证重跑一致；避免 Math.random 在并发下撞序列）
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const CPA_EMOJI = ['🔥', '✨', '💡', '🚀', '👀', '💥', '🌟', '🤔', '📈', '🎯', '✅', '🙌', '🌈', '⚡', '💎'];
const CAP_SUFFIX = ['', ' #shorts', ' 来看看', ' 👇', ' 速看', ' 值得收藏', ' 别错过', ' 真实记录', ' 最新', ' 热门'];

/**
 * 为单个账号派生「拟人」发布参数：
 *  - 稳定的移动端 UA（同一账号会话内不换，避免指纹异常）
 *  - 文案变体（多套候选轮替 / 自动加 emoji & 后缀，避免多账号同文案被判定搬运）
 *  - 标签子集随机打乱（避免完全相同的 hashtag 组合）
 * @returns {{caption:string, tags:string[], ua:string}}
 */
function humanizeAccount(accountId, idx, baseCaption, baseTags, opts) {
  // 同一账号固定用同一台「设备」指纹：UA 仅由 accountId 决定（真人不会中途换手机）
  const uaRng = mulberry32(hashString(accountId));
  const rng = mulberry32(hashString(accountId) ^ (idx * 2654435761));
  let caption;
  if (opts.captionVariants && opts.captionVariants.length) {
    caption = opts.captionVariants[idx % opts.captionVariants.length];
  } else {
    const em = CPA_EMOJI[Math.floor(rng() * CPA_EMOJI.length)];
    const suf = CAP_SUFFIX[Math.floor(rng() * CAP_SUFFIX.length)];
    caption = (baseCaption || 'MSCMS auto post') + suf + ' ' + em;
  }
  let tags = baseTags || [];
  if (opts.shuffleTags && tags.length > 1) {
    const keep = Math.max(1, Math.floor(rng() * tags.length) + 1);
    tags = shuffle(tags, rng).slice(0, keep);
  }
  const ua = opts.publisher.pickMobileUA(uaRng);
  return { caption, tags, ua };
}

/* ============================ 批量发布调度器 ============================ */
class TumblrBatchPublisher {
  constructor(opts = {}) {
    const { dataStore, videoRender, tumblrPublisher, mysqlPool } = opts;
    this.dataStore = dataStore;
    this.videoRender = videoRender;
    this.tumblrPublisher = tumblrPublisher;
    this.mysqlPool = mysqlPool || null; // 真实发布链接回写 matrix_posts_published，闭环「回收→二次创作」
    this.tasks = new Map();
    this._persisted = [];
    try { fs.mkdirSync(PUBLISHED_ROOT, { recursive: true }); } catch (_) {}
    try { if (fs.existsSync(HISTORY_FILE)) this._persisted = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')) || []; } catch (_) {}
  }

  // 把任务摘要落盘到 history.json，使发布历史在重启后仍可查（零伪造，仅真实结果）
  _persistTask(task) {
    try {
      const entry = {
        id: task.id, videoId: task.videoId, status: task.status,
        total: task.total, done: task.done, success: task.success, fail: task.fail,
        startedAt: task.startedAt, finishedAt: task.finishedAt,
        folder: task.folder, excel: task.excel, zip: task.zip,
        caption: task.caption, tags: task.tags, humanize: task.humanize,
        results: (task.results || []).map(r => ({
          accountId: r.accountId, blogName: r.blogName, status: r.status,
          postUrl: r.postUrl, publishedAt: r.publishedAt,
          file: r.file ? path.basename(r.file) : ''
        }))
      };
      const arr = this._persisted || [];
      const i = arr.findIndex(t => t.id === task.id);
      if (i >= 0) arr[i] = entry; else arr.push(entry);
      this._persisted = arr;
      fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2));
    } catch (_) { /* 历史落盘失败不阻断发布 */ }
  }

  _newTaskId() {
    return 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  }

  /** 真实发布成功 → 回写 matrix_posts_published（供真实数据回收/正向筛选闭环）。零伪造。 */
  async _recordPublish(accountId, postUrl, title) {
    if (!this.mysqlPool || !postUrl) return;
    try {
      await this.mysqlPool.execute(
        `INSERT INTO matrix_posts_published (account_id, content_id, platform, post_url, status, content_title)
         VALUES (?, NULL, 'tumblr', ?, 'published', ?)`,
        [String(accountId), String(postUrl), title || null]
      );
    } catch (e) { /* 不阻断主流程 */ }
  }

  /**
   * 启动批量发布（异步执行）。
   * @returns {  string} taskId
   */
  startBatch({ videoId, accountIds, concurrency = 2, batchSize = 10, batchDelayMs = 3000, caption, tags,
                humanize = true, jitter = 0.5, warmupCount = 5, captionVariants, shuffleTags = true }) {
    const taskId = this._newTaskId();
    const baseTags = Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    const task = {
      id: taskId,
      videoId,
      accountIds: Array.isArray(accountIds) ? accountIds.slice() : [],
      concurrency: Math.max(1, parseInt(concurrency, 10) || 2),
      batchSize: Math.max(1, parseInt(batchSize, 10) || 10),
      batchDelayMs: Math.max(0, parseInt(batchDelayMs, 10) || 0),
      caption: caption || '',
      tags: baseTags,
      humanize: !!humanize,
      jitter: Math.max(0, Math.min(1, parseFloat(jitter))),
      warmupCount: Math.max(0, parseInt(warmupCount, 10) || 0),
      captionVariants: Array.isArray(captionVariants) ? captionVariants.filter(Boolean) : [],
      shuffleTags: !!shuffleTags,
      status: 'running',
      total: 0,
      done: 0,
      success: 0,
      fail: 0,
      results: [],
      startedAt: new Date().toISOString(),
      finishedAt: null,
      folder: null,
      excel: null,
      zip: null,
      error: null
    };
    task.status = 'running';
    this.tasks.set(taskId, task);

    // 解析视频路径
    const rec = this.videoRender && this.videoRender.getStatus ? this.videoRender.getStatus(videoId) : null;
    if (!rec || !rec.filePath || !fs.existsSync(rec.filePath)) {
      task.status = 'failed';
      task.error = '视频文件不存在或尚未渲染: ' + videoId;
      this._persistTask(task);
      return taskId;
    }
    task.videoPath = rec.filePath;
    task.total = task.accountIds.length;

    // D 盘独立任务文件夹
    const folder = path.join(PUBLISHED_ROOT, taskId);
    try { fs.mkdirSync(folder, { recursive: true }); } catch (e) { /* ignore */ }
    task.folder = folder;

    // 异步执行，不阻塞 HTTP 响应
    this._run(task).catch(e => {
      task.status = 'failed';
      task.error = String((e && e.message) || e);
      task.finishedAt = new Date().toISOString();
      this._persistTask(task);
    });
    return taskId;
  }

  async _run(task) {
    const ids = task.accountIds;
    const n = ids.length;
    let idx = 0;

    // 代理池（多出口轮换）：优先 TUMBLR_PROXY_POOL，否则回退单 TUMBLR_PROXY / 账号解析器
    const poolEnv = (process.env.TUMBLR_PROXY_POOL || '').split(',').map(s => s.trim()).filter(Boolean);
    const proxyFor = (i) => poolEnv.length ? poolEnv[i % poolEnv.length]
      : (this.tumblrPublisher._proxyResolver ? this.tumblrPublisher._proxyResolver(ids[i]) : null)
      || process.env.TUMBLR_PROXY || null;

    const processOne = async (accountId, i) => {
      const started = new Date().toISOString();
      // 拟人化：派生该账号专属文案 / 标签 / UA
      const h = humanizeAccount(accountId, i, task.caption, task.tags, {
        captionVariants: task.captionVariants, shuffleTags: task.shuffleTags, publisher: this.tumblrPublisher
      });
      // 绑定该账号 UA（后续所有 API 请求一致）
      this.tumblrPublisher.setAccountUA(accountId, h.ua);
      try {
        const r = await this.tumblrPublisher.publishVideo({
          filePath: task.videoPath,
          caption: h.caption,
          tags: h.tags,
          accountId,
          userAgent: h.ua,
          proxy: proxyFor(i)
        });
        // 拷贝视频到 D 盘任务文件夹（按账号命名，便于回溯）
        const ext = path.extname(task.videoPath) || '.mp4';
        const dest = path.join(task.folder, accountId + ext);
        try { fs.copyFileSync(task.videoPath, dest); } catch (_) {}
        const res = {
          accountId,
          blogName: r.blogName || '',
          status: 'success',
          postUrl: r.postUrl || '',
          publishedAt: started,
          file: fs.existsSync(dest) ? dest : ''
        };
        task.results.push(res);
        task.success++;
        this._recordPublish(accountId, r.postUrl, h.caption);
      } catch (e) {
        const res = {
          accountId,
          blogName: '',
          status: 'failed',
          error: String((e && e.message) || e),
          publishedAt: started,
          file: ''
        };
        task.results.push(res);
        task.fail++;
      } finally {
        task.done++;
      }
    };

    while (idx < n) {
      const chunk = ids.slice(idx, idx + task.batchSize);
      // 拟人化：批次内顺序随机打乱，避免「顺序爆破」的指纹
      const order = task.humanize ? shuffle(chunk, mulberry32(hashString(task.id) ^ idx)) : chunk;
      idx += task.batchSize;

      let bi = 0;
      const worker = async () => {
        while (bi < order.length) {
          const pos = idx - task.batchSize + bi; // 全局序号（用于 UA/代理稳定分配）
          const id = order[bi++];
          // 拟人化抖动：每帖之间随机抖动间隔，前 warmupCount 帖额外加长（模拟「刚上手」节奏）
          if (task.humanize && task.jitter > 0) {
            let gap = task.batchDelayMs * (1 + (Math.random() * 2 - 1) * task.jitter);
            if (task.warmupCount && pos < task.warmupCount) gap += task.batchDelayMs; // 热身双倍
            gap = Math.max(0, Math.round(gap));
            if (gap > 0) await new Promise(res => setTimeout(res, gap));
          }
          await processOne(id, pos);
        }
      };
      const pool = [];
      const c = Math.min(task.concurrency, order.length);
      for (let k = 0; k < c; k++) pool.push(worker());
      await Promise.all(pool);

      // 批次之间冷却（最后一批不等待）
      if (idx < n && task.batchDelayMs > 0) {
        await new Promise(res => setTimeout(res, task.batchDelayMs));
      }
    }

    this._writeReport(task);
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    this._persistTask(task);
  }

  /**
   * 失败账号一键重发：从已完成/失败任务的 results 中挑出未成功账号，复用原视频与文案重新发布。
   * @returns {string|null} 新 taskId；无失败账号返回 null
   */
  resendFailed(taskId) {
    const src = this.tasks.get(taskId) || (this._persisted.find(t => t.id === taskId));
    if (!src) return null;
    const failed = (src.results || []).filter(r => r.status !== 'success').map(r => r.accountId);
    if (!failed.length) return null;
    return this.startBatch({
      videoId: src.videoId,
      accountIds: failed,
      caption: src.caption,
      tags: src.tags,
      humanize: src.humanize,
      jitter: src.jitter,
      warmupCount: 0,
      captionVariants: src.captionVariants,
      shuffleTags: src.shuffleTags,
      concurrency: 2,
      batchSize: 10,
      batchDelayMs: 4000
    });
  }

  /** 从 post_url 解析 { blogName, postId }（与 engagement-harvester 同源） */
  _parseUrl(postUrl) {
    if (!postUrl) return null;
    const u = String(postUrl).trim();
    let m = u.match(/tumblr\.com\/blog\/view\/([^/?#]+)\/([^/?#]+)/);
    if (m) return { blogName: m[1], postId: m[2] };
    m = u.match(/([a-z0-9_-]+)\.tumblr\.com\/post\/(\d+)/i);
    if (m) return { blogName: m[1], postId: m[2] };
    m = u.match(/tumblr\.com\/([a-z0-9_-]+)\/post\/(\d+)/i);
    if (m) return { blogName: m[1], postId: m[2] };
    return null;
  }

  /**
   * 二次创作 + 跨账号复制：把「正向视频」以 reblog 形式复制到其它账号。
   * 每个目标账号携带「拟人化」变体评论/标签（账号绑定 UA、打乱标签顺序），
   * 规避「同一内容同步轰炸」风控；源账号本身被排除。
   * @returns {string} taskId
   */
  startRemix({ sourcePostUrl, targetAccountIds, comment, tags, humanize = true, jitter = 0.5, warmupCount = 0, captionVariants, shuffleTags = true, concurrency = 2, batchSize = 10, batchDelayMs = 4000 }) {
    const taskId = this._newTaskId();
    const baseTags = Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    const task = {
      id: taskId, type: 'remix', sourcePostUrl, sourceBlog: null, sourcePostId: null, reblogKey: null,
      accountIds: Array.isArray(targetAccountIds) ? targetAccountIds.slice() : [],
      tags: baseTags, caption: comment || '', captionVariants: Array.isArray(captionVariants) ? captionVariants.filter(Boolean) : [],
      humanize: !!humanize, jitter: Math.max(0, Math.min(1, parseFloat(jitter))), warmupCount: Math.max(0, parseInt(warmupCount, 10) || 0),
      shuffleTags: !!shuffleTags, batchSize: Math.max(1, parseInt(batchSize, 10) || 10), concurrency: Math.max(1, parseInt(concurrency, 10) || 2), batchDelayMs: Math.max(0, parseInt(batchDelayMs, 10) || 4000),
      status: 'running', total: 0, done: 0, success: 0, fail: 0,
      results: [], startedAt: new Date().toISOString(), finishedAt: null, folder: null, excel: null, zip: null, error: null
    };
    this.tasks.set(taskId, task);

    const p = this._parseUrl(sourcePostUrl);
    if (!p) { task.status = 'failed'; task.error = '无法解析 sourcePostUrl'; this._persistTask(task); return taskId; }
    task.sourceBlog = p.blogName; task.sourcePostId = p.postId;
    task.total = task.accountIds.filter((id) => id !== task.sourceBlog).length;

    // 源帖 reblog_key 在 _runRemix 内异步拉取（startRemix 保持同步以便立即返回 taskId）
    const folder = path.join(PUBLISHED_ROOT, taskId);
    try { fs.mkdirSync(folder, { recursive: true }); } catch (_) {}
    task.folder = folder;

    this._runRemix(task).catch(e => {
      task.status = 'failed'; task.error = String((e && e.message) || e); task.finishedAt = new Date().toISOString(); this._persistTask(task);
    });
    return taskId;
  }

  async _runRemix(task) {
    // 异步拉取源帖 reblog_key（用于跨账号 reblog）；acting 用任一已授权账号读取
    try {
      const acting = this.tumblrPublisher._defaultAccountId ? this.tumblrPublisher._defaultAccountId() : 'main';
      const res = await this.tumblrPublisher.getBlogPosts(task.sourceBlog, { limit: 50, notesInfo: false }, acting);
      const posts = res.posts || [];
      const tp = posts.find(x => String(x.id_string || x.id) === String(task.sourcePostId));
      if (!tp || !tp.reblog_key) { task.status = 'failed'; task.error = '未找到源帖 reblog_key（可能已删除或非公开）'; this._persistTask(task); return; }
      task.reblogKey = tp.reblog_key;
    } catch (e) {
      task.status = 'failed'; task.error = '拉取源帖失败: ' + (e && e.message); this._persistTask(task); return;
    }

    // 排除源账号本身（不能 reblog 到自己）
    const ids = task.accountIds.filter((id) => id !== task.sourceBlog);
    const n = ids.length;
    let idx = 0;
    const proxyFor = (i) => (this.tumblrPublisher._proxyResolver ? this.tumblrPublisher._proxyResolver(ids[i]) : null) || process.env.TUMBLR_PROXY || null;

    const processOne = async (accountId, i) => {
      const started = new Date().toISOString();
      const h = humanizeAccount(accountId, i, task.caption, task.tags, { captionVariants: task.captionVariants, shuffleTags: task.shuffleTags, publisher: this.tumblrPublisher });
      this.tumblrPublisher.setAccountUA(accountId, h.ua);
      try {
        // 【2026-09-10 修复】必须用 ownBlogNameOf（不兜底到他人账号），
        // 否则无 token 账号会用别人的 token 发到别人的 blog（记录却归它）。
        const targetBlog = this.tumblrPublisher.ownBlogNameOf
          ? this.tumblrPublisher.ownBlogNameOf(accountId)
          : this.tumblrPublisher.blogNameOf(accountId);
        if (!targetBlog) throw new Error('目标账号无自己的博客名（无 token 或缺 blog 名）');
        const r = await this.tumblrPublisher.reblogPost(targetBlog, { id: task.sourcePostId, reblogKey: task.reblogKey, comment: h.caption, tags: h.tags }, accountId);
        task.results.push({ accountId, blogName: targetBlog, status: 'success', postUrl: r.postUrl || '', publishedAt: started, file: '' });
        this._recordPublish(accountId, r.postUrl, h.caption);
        task.success++;
      } catch (e) {
        task.results.push({ accountId, blogName: '', status: 'failed', error: String((e && e.message) || e), publishedAt: started, file: '' });
        task.fail++;
      } finally { task.done++; }
    };

    while (idx < n) {
      const chunk = ids.slice(idx, idx + task.batchSize);
      const order = task.humanize ? shuffle(chunk, mulberry32(hashString(task.id) ^ idx)) : chunk;
      idx += task.batchSize;
      let bi = 0;
      const worker = async () => {
        while (bi < order.length) {
          const pos = idx - task.batchSize + bi;
          if (task.humanize && task.jitter > 0) {
            let gap = task.batchDelayMs * (1 + (Math.random() * 2 - 1) * task.jitter);
            if (task.warmupCount && pos < task.warmupCount) gap += task.batchDelayMs;
            gap = Math.max(0, Math.round(gap));
            if (gap > 0) await new Promise(res => setTimeout(res, gap));
          }
          await processOne(order[bi++], pos);
        }
      };
      const pool = [];
      const c = Math.min(task.concurrency, order.length);
      for (let k = 0; k < c; k++) pool.push(worker());
      await Promise.all(pool);
      if (idx < n && task.batchDelayMs > 0) await new Promise(res => setTimeout(res, task.batchDelayMs));
    }
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    this._persistTask(task);
  }

  /**
   * 图文批量发布（postPhoto）：把一张图片（本地路径 sourceUrl 或本地文件 filePath）+ 文案，
   * 真实发布到多个账号。区别于视频批量：用 postPhoto 而非 publishVideo。
   * @returns {string} taskId
   */
  startPhotoBatch({ imagePath, sourceUrl, accountIds, caption, tags, humanize = true, jitter = 0.5, warmupCount = 0, captionVariants, shuffleTags = true, concurrency = 2, batchSize = 10, batchDelayMs = 4000 }) {
    const taskId = this._newTaskId();
    const baseTags = Array.isArray(tags) ? tags : (tags ? String(tags).split(',').map(s => s.trim()).filter(Boolean) : []);
    if (!imagePath && !sourceUrl) { return { error: 'imagePath 或 sourceUrl 必填' }; }
    if (imagePath && !fs.existsSync(imagePath)) { return { error: '图片文件不存在: ' + imagePath }; }
    const task = {
      id: taskId, type: 'photo', imagePath: imagePath || null, sourceUrl: sourceUrl || null,
      accountIds: Array.isArray(accountIds) ? accountIds.slice() : [],
      tags: baseTags, caption: caption || '', captionVariants: Array.isArray(captionVariants) ? captionVariants.filter(Boolean) : [],
      humanize: !!humanize, jitter: Math.max(0, Math.min(1, parseFloat(jitter))), warmupCount: Math.max(0, parseInt(warmupCount, 10) || 0),
      shuffleTags: !!shuffleTags, batchSize: Math.max(1, parseInt(batchSize, 10) || 10), concurrency: Math.max(1, parseInt(concurrency, 10) || 2), batchDelayMs: Math.max(0, parseInt(batchDelayMs, 10) || 4000),
      status: 'running', total: 0, done: 0, success: 0, fail: 0,
      results: [], startedAt: new Date().toISOString(), finishedAt: null, folder: null, excel: null, zip: null, error: null
    };
    this.tasks.set(taskId, task);
    task.total = task.accountIds.length;
    const folder = path.join(PUBLISHED_ROOT, taskId);
    try { fs.mkdirSync(folder, { recursive: true }); } catch (_) {}
    task.folder = folder;
    this._runPhoto(task).catch(e => {
      task.status = 'failed'; task.error = String((e && e.message) || e); task.finishedAt = new Date().toISOString(); this._persistTask(task);
    });
    return taskId;
  }

  async _runPhoto(task) {
    const ids = task.accountIds;
    const n = ids.length;
    let idx = 0;
    while (idx < n) {
      const chunk = ids.slice(idx, idx + task.batchSize);
      const order = task.humanize ? shuffle(chunk, mulberry32(hashString(task.id) ^ idx)) : chunk;
      idx += task.batchSize;
      let bi = 0;
      const worker = async () => {
        while (bi < order.length) {
          const pos = idx - task.batchSize + bi;
          if (task.humanize && task.jitter > 0) {
            let gap = task.batchDelayMs * (1 + (Math.random() * 2 - 1) * task.jitter);
            if (task.warmupCount && pos < task.warmupCount) gap += task.batchDelayMs;
            gap = Math.max(0, Math.round(gap));
            if (gap > 0) await new Promise(res => setTimeout(res, gap));
          }
          const id = order[ (bi++) ];
          const h = humanizeAccount(id, pos, task.caption, task.tags, { captionVariants: task.captionVariants, shuffleTags: task.shuffleTags, publisher: this.tumblrPublisher });
          this.tumblrPublisher.setAccountUA(id, h.ua);
          try {
            // 【2026-09-10 修复】同 reblog 路径：不兜底到他人账号
            const targetBlog = this.tumblrPublisher.ownBlogNameOf
              ? this.tumblrPublisher.ownBlogNameOf(id)
              : this.tumblrPublisher.blogNameOf(id);
            if (!targetBlog) throw new Error('目标账号无自己的博客名（无 token 或缺 blog 名）');
            const r = await this.tumblrPublisher.postPhoto(targetBlog, { caption: h.caption, tags: h.tags, filePath: task.imagePath, sourceUrl: task.sourceUrl }, id);
            task.results.push({ accountId: id, blogName: targetBlog || '', status: 'success', postUrl: r.postUrl || '', publishedAt: new Date().toISOString(), file: task.imagePath || '' });
            this._recordPublish(id, r.postUrl, h.caption);
            task.success++;
          } catch (e) {
            task.results.push({ accountId: id, blogName: '', status: 'failed', error: String((e && e.message) || e), publishedAt: new Date().toISOString(), file: '' });
            task.fail++;
          } finally { task.done++; }
        }
      };
      const pool = [];
      const c = Math.min(task.concurrency, order.length);
      for (let k = 0; k < c; k++) pool.push(worker());
      await Promise.all(pool);
      if (idx < n && task.batchDelayMs > 0) await new Promise(res => setTimeout(res, task.batchDelayMs));
    }
    task.status = 'done';
    task.finishedAt = new Date().toISOString();
    this._persistTask(task);
  }

  _writeReport(task) {
    const headers = ['序号', '视频ID', '账号ID', '博客名', '状态', '真实地址(postUrl)', '发布时间', '本地文件'];
    const rows = task.results.map((r, i) => [
      i + 1,
      task.videoId,
      r.accountId,
      r.blogName || '',
      r.status === 'success' ? '成功' : '失败',
      r.postUrl || '',
      r.publishedAt || '',
      r.file ? path.basename(r.file) : ''
    ]);
    const xlsxBuf = buildXlsx('发布任务', headers, rows);
    const excelPath = path.join(task.folder, 'publish_report.xlsx');
    try { fs.writeFileSync(excelPath, xlsxBuf); task.excel = excelPath; } catch (e) { /* ignore */ }

    // 压缩整个任务文件夹（视频 + Excel）为 zip 放到根目录
    try {
      const files = [];
      for (const r of task.results) {
        if (r.file && fs.existsSync(r.file)) {
          files.push({ name: path.basename(r.file), data: fs.readFileSync(r.file) });
        }
      }
      files.push({ name: 'publish_report.xlsx', data: xlsxBuf });
      const zipBuf = zipSync(files);
      const zipPath = path.join(PUBLISHED_ROOT, task.id + '.zip');
      fs.writeFileSync(zipPath, zipBuf);
      task.zip = zipPath;
    } catch (e) {
      task.error = 'zip 生成失败: ' + String((e && e.message) || e);
    }
  }

  getTask(id) {
    const live = this.tasks.get(id);
    if (live) return live;
    // 重启后内存任务已清空，回退到持久化历史（含真实 results / excel / zip 路径）
    const p = (this._persisted || []).find(t => t.id === id);
    return p || null;
  }
  listTasks() {
    const live = Array.from(this.tasks.values())
      .map(t => ({ id: t.id, status: t.status, total: t.total, done: t.done, success: t.success, fail: t.fail, startedAt: t.startedAt, folder: t.folder, excel: t.excel, zip: t.zip, tags: t.tags }));
    const liveMap = new Map(live.map(t => [t.id, t]));
    const merged = [];
    for (const p of (this._persisted || [])) {
      merged.push(liveMap.get(p.id) || p);
      liveMap.delete(p.id);
    }
    for (const t of liveMap.values()) merged.push(t);
    merged.sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    return merged;
  }
}

module.exports = { TumblrBatchPublisher, zipSync, buildXlsx, PUBLISHED_ROOT };
