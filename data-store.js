'use strict';

const fs = require('fs');
const fsProm = fs.promises;
const path = require('path');
// [P2-B5] 真实媒体判定（单一事实源）
const _mediaRef = require('./content-media-ref.js');

/**
 * MSCMS v14 — DataStore 统一数据持久化层
 * 每个模块一个 JSON 文件，启动时自动加载，操作时同步写入
 * 替代"内存Map + 重启丢失"模式
 * 
 * 数据文件目录: ./data/
 * 
 * 统一 CRUD 接口:
 *   list(module, opts)     — 分页/筛选/排序
 *   get(module, id)        — 按 ID 查单条
 *   create(module, data)   — 新建（自动生成 id + createdAt）
 *   update(module, id, data) — 更新（自动记录 updatedAt）
 *   delete(module, id)     — 删除
 *   history(module, id)    — 历史操作记录
 *   count(module)          — 总数
 *   export(module, format) — 导出 CSV/JSON
 */

/**
 * FNV-1a 变体（双通道 64 位十六进制）——用于为「无 id 记录」生成确定性指纹。
 * 为什么不用 crypto：本文件被 3002/3005/3012/3013 多进程高频加载，
 * 保持零额外依赖可脱网运行；此处只需要「确定性 + 低碰撞」，不需要密码学强度。
 */
function _fnv1a64(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x85ebca6b);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

class DataStore {
  constructor(dataDir) {
    this.dataDir = dataDir || path.join(__dirname, 'data');
    this._cache = new Map();      // module → Map(id → record)
    this._history = new Map();    // module → array of history entries
    this._dirty = new Set();      // 待写入的模块
    // module → 原始 JSON 容器类型。部分外部流程（如 Tumblr token）按 { accountId: record }
    // 键控对象写入；必须保留该形态，避免 reload 后账号能看到但授权 token 查不到。
    this._storageShape = new Map();

    // 合并落盘白名单：这些模块可能被【本进程之外的其他进程】直接写盘
    // （如 tumblr-onboard.js 直接 fs 写 accounts.json，或 3005 养号服务独立 DataStore）。
    // 落盘前会把磁盘上「内存缓存没有」的记录并入，防止运行中 flush 覆盖掉外部追加的数据。
    // 典型事故：onboard 写 10 个号后被养号服务 5s flush 用陈旧内存缓存覆盖 → 假成功丢失。
    this._mergeOnFlush = new Map([['accounts', 'append'], ['content', 'lww']]);

    // ── 单写者隔离：模块级「可写白名单」（2026-09-12 架构治本）──
    // 背景：`tools/mscms-watchdog.js` 的 BASE_ENV 给 3002 / 3005 / 3012 三个服务注入了
    //   同一个 DATA_DIR（工作区 data\ 还是指向 D:\mscms-ws\data 的 junction，物理同一份），
    //   三方各自把 54 个模块读进内存、每 5s 把 dirty 模块整体写回 → 互相覆盖。
    //   LWW 并表只能「收敛冲突」，不能消除写者；根治办法是**只有属主进程能写该模块**：
    //     MSCMS_DATASTORE_WRITE_MODULES 未设置 → 除 OWNER_ONLY_MODULES 外全部可写（默认）
    //     MSCMS_DATASTORE_WRITE_MODULES='*'    → 全部可写（显式声明「我是属主」）
    //     MSCMS_DATASTORE_WRITE_MODULES='*,-content' → 除 content 外全部可写（黑名单语法）
    //     MSCMS_DATASTORE_WRITE_MODULES='none' → 只读（只读盘、绝不回写）
    //     MSCMS_DATASTORE_WRITE_MODULES='a,b'  → 白名单（只允许写这两个模块）
    // 被拒绝的写入会打日志一次（避免"静默不落盘"演变成隐形业务 bug）。
    //
    // ⚠️【2026-09-12 收口·第四类写者】除 3 个常驻服务外，仓库里还有 ~15 个 CLI 脚本
    //   （tumblr-onboard*.js / tumblr-reauth*.js / tools/probes/_test_*.js …）同样指向
    //   这个 DATA_DIR。它们**不经看门狗**，所以拿不到白名单 → 走了"未设置=全放开"的
    //   兼容分支，运行期每 5s 把全量内存副本回盘，把 prune 刚删掉的记录**写回来**
    //   （这正是"删除残余 18~45 条"的来源；墓碑只能挡"它启动前"的删除）。
    //   因此把默认值从"全放开"收紧为"除属主独占模块外全放开"，并把 content 列为
    //   属主独占（唯一合法写入方 = 主服务 server.js，它显式声明 '*'）。
    this._writeAllow = this._parseWriteAllowlist();
    this._deniedWarned = new Set();

    // ── 墓碑（tombstone）：让「删除」在多写者下可靠传播 ──
    // lww 模式下别的进程内存里仍持有的记录会在它 flush 时回到磁盘（删除被"复活"）。
    // 记录删除时间戳后：任何进程落盘/加载时，只要记录自身的 updatedAt 早于墓碑，就丢弃它。
    // 只登记**显式 delete()**，不登记 prune（历史日志无需墓碑，避免文件膨胀）。
    this._tombstones = new Map();          // module → Map(id → tsMs)
    this._tombstoneFile = path.join(this.dataDir, '_tombstones.json');
    this._tombstoneMtime = 0;
    this._tombstonesDirty = false;
    this._tombstoneTtlMs = 7 * 24 * 3600 * 1000;   // 7 天后墓碑自行过期
    this._loadTombstones();

    // 确保数据目录存在
    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }
    
    // 自动加载所有 JSON 文件
    this._loadAll();
    
    // 高频模块的自动清理配置 (maxKeep = 保留最大记录数)
    // ⚠️【2026-09-08 P2 修正】原阈值过小导致核心业务数据被静默裁剪：
    //   publish 749→555、traffic_links 695→507，且仍在继续降向 500。
    //   发布记录 / 短链 / 内容库是业务资产与回采数据源，绝不能按「高频日志」同标准裁剪。
    this._pruneConfig = {
      // 内容库：保留全部「已发布 / 待发布(ready) / 已入队 / 已隔离可回溯」内容，只裁无用的草稿垃圾
      // 【2026-09-12 保护规则收敛】旧规则无脑保护 status==='ready'，而 MySQL 影子表回声污染
      // 曾灌入 1.4 万条「纯数字 id + 空正文 + 无媒体」的 ready 垃圾 → 被 protect 永久锁定，
      // prune 永远删不掉（日志 `Pruned 4 ... kept 20946`），且 S4 每轮仍会选中它们白跑入队。
      // 新规则：只有「能真发出去 / 已发出去」的记录才受保护，空壳 ready 回归可裁剪。
      content: {
        maxKeep: 5000,
        protect: (it) => {
          if (!it) return false;
          if (it.published === true || it.published_at || it.status === 'published') return true; // 已发布：永久留痕
          if (it.status === 'queued') return true;                                                // 已入队：等待发布，勿裁
          const hasBody = String(it.body || it.text || it.caption || '').trim().length > 0;
          // [P2-B5] preview_url 多为内容存档 JSON 路径（非媒体）→ 统一判定，
          // 避免「只有存档路径、无正文无媒体」的空壳 ready 被 protect 永久锁定。
          const hasMedia = _mediaRef.contentHasRealMedia(it);
          return hasBody || hasMedia;                                                             // 有正文或有媒体 = 真内容
        }
      },
      // 发布记录是转化归因与回采的唯一真实来源，永不裁剪
      publish: { maxKeep: 20000, protect: () => true },
      analytics: { maxKeep: 1000 },
      dau_log: { maxKeep: 2000 },
      decision_actions: { maxKeep: 1000 },
      // 短链是引流归因主键，裁掉即无法回溯点击来源
      traffic_links: { maxKeep: 5000, protect: () => true },
      traffic_click_logs: { maxKeep: 2000 },
      conversion_logs: { maxKeep: 2000 },
      content_pipeline_logs: { maxKeep: 200 },
      social_logs: { maxKeep: 200 },
      campaign_logs: { maxKeep: 200 },
      nurture_logs: { maxKeep: 200 },
      // 社交发布平台凭证配置（低频单条，登记以防万一）
      bluesky_config: { maxKeep: 10 },
      mastodon_config: { maxKeep: 10 },
      telegram_config: { maxKeep: 10 },
      discord_config: { maxKeep: 10 },
      devto_config: { maxKeep: 10 },
      hashnode_config: { maxKeep: 10 },
      nostr_config: { maxKeep: 10 },
      github_config: { maxKeep: 10 },
      webhook_config: { maxKeep: 10 },
      // Tumblr OAuth1.0a 凭证（低频单条，登记以防万一）
      // 16+ 真实 Tumblr 账号：token/persona/nurture 1:1 绑定，绝不能被 prune 静默删除（否则「账号在、token 没了」孤儿）。maxKeep 已提到 2000。
      tumblr_config: { maxKeep: 2000 },
      tumblr_token: { maxKeep: 2000 },
      tumblr_reqtoken: { maxKeep: 2000 },
      // 养号进度/人格层持久化（每账号一条，16+ 条）
      tumblr_nurture: { maxKeep: 2000 },
      tumblr_persona: { maxKeep: 2000 },
      // 移动端设备池会话日志（每账号一条滚动日志，上限 30 条/账号，登记以防内存膨胀）
      tumblr_device: { maxKeep: 2000 },
      tumblr_action_log: { maxKeep: 600 },   // 每账号一条记录(有界数组)，按账号数增长，上限宽裕
      tumblr_daily_summary: { maxKeep: 400 }, // 每日一条，长期保留历史进度
      // 互动中心：每账号草稿/人工审批审计，任何发送都必须在真实网页中由人手确认。
      tumblr_interaction_draft: { maxKeep: 2000 },
      tumblr_interaction_audit: { maxKeep: 5000 },
      // 高速增长的流量/追踪日志 — 之前无上限导致内存无限膨胀 (link_traffic 曾达 10K+)
      link_traffic: { maxKeep: 1000 },
      account_tracker_cycles: { maxKeep: 500 },
      conversion_logs: { maxKeep: 500 },
      // ── 账号管理模块 (Phase 0) ──
      // cloud_phones: 50 台云手机注册表（每台 1 条元信息，上限宽裕）。每账号 1:1 绑定 owner_account 数组随之增长。
      cloud_phones: { maxKeep: 200 },
      // device_jobs: 设备任务队列（发布/养号/登录任务），按任务数增长
      device_jobs: { maxKeep: 2000 },
      // inbox: 收件箱/通知/评论，每账号滚动 ，上限宽裕
      inbox: { maxKeep: 5000 },
      // ── 决策桥接器 (Phase 4 / #527)：每个账号 4 决策点记录，按账号增长 ──
      account_decisions: { maxKeep: 5000 },
    };
    
    // 启动时清理膨胀数据
    this._startupPrune();
    
    // 定时写入（每 5 秒写入一次脏数据）
    this._flushInterval = setInterval(() => this._flush(), 5000);
    
    // 定期自动清理（每 2 分钟）
    this._pruneInterval = setInterval(() => this._periodicPrune(), 120000);
  }

  /**
   * 解析「可写白名单」环境变量。
   * 支持黑名单语法：`*` 表示全放开，`-模块名` 表示在放开的基础上排除该模块。
   *   'a,b'      → 白名单（只允许 a、b）
   *   '*,-content' → 除 content 外全部可写
   * 未设置时默认"除 OWNER_ONLY_MODULES 外全部可写"（防止未配置的脚本回写共享模块）。
   * @returns {null|{mode:'all'|'list'|'readonly', allow:Set<string>, deny:Set<string>}}
   */
  _parseWriteAllowlist() {
    // 属主独占模块：整个仓库里只有一个进程有权写它。
    // content 的唯一合法属主 = 主服务 server.js（内容生成/质检/发布选择都在它进程内）。
    const OWNER_ONLY = ['content'];

    const raw = process.env.MSCMS_DATASTORE_WRITE_MODULES;
    if (raw === undefined || raw === null) {
      console.log(`[DataStore] 写入白名单=默认（除属主独占模块 ${OWNER_ONLY.join(',')} 外全部可写；如需成为属主请显式设 '*'）`);
      return { mode: 'all', allow: new Set(), deny: new Set(OWNER_ONLY) };
    }
    const v = String(raw).trim();
    if (v === '' || v.toLowerCase() === 'none') {
      console.log('[DataStore] 写入白名单=只读（只读盘，绝不回写）');
      return { mode: 'readonly', allow: new Set(), deny: new Set() };
    }
    const allow = new Set();
    const deny = new Set();
    let allowAll = false;
    for (const part of v.split(',').map(s => s.trim()).filter(Boolean)) {
      if (part === '*') { allowAll = true; continue; }
      if (part.startsWith('-') && part.length > 1) { deny.add(part.slice(1)); continue; }
      allow.add(part);
    }
    if (allowAll) {
      console.log(deny.size
        ? `[DataStore] 写入白名单=全部模块（排除: ${Array.from(deny).join(', ')}）`
        : '[DataStore] 写入白名单=全部模块（本进程为属主）');
      return { mode: 'all', allow, deny };
    }
    console.log(`[DataStore] 写入白名单=${allow.size} 个模块: ${Array.from(allow).join(', ')}${deny.size ? `（另排除: ${Array.from(deny).join(', ')}）` : ''}`);
    return { mode: 'list', allow, deny };
  }

  /**
   * 本进程是否允许写该模块。被拒绝时只警告一次（每模块）。
   */
  _canWrite(module) {
    const w = this._writeAllow;
    if (w === null) return true;                       // 未配置（保留的兼容分支，正常不会走到）
    if (w.deny && w.deny.has(module)) { this._warnDenied(module); return false; }
    if (w.mode === 'all') return true;
    if (w.allow && w.allow.has(module)) return true;
    this._warnDenied(module);
    return false;
  }

  /** 写入被拒时的单次告警 */
  _warnDenied(module) {
    if (this._deniedWarned.has(module)) return;
    this._deniedWarned.add(module);
    console.warn(`[DataStore] ⛔ 写入被白名单拒绝（本进程无权写该模块，不再重复提示）: ${module}`);
  }

  /** 读取墓碑文件（合并式；可被 _refreshTombstones 重复调用） */
  _loadTombstones() {
    try {
      if (!fs.existsSync(this._tombstoneFile)) return;
      const stat = fs.statSync(this._tombstoneFile);
      this._tombstoneMtime = stat.mtimeMs;
      const raw = JSON.parse(fs.readFileSync(this._tombstoneFile, 'utf8'));
      const now = Date.now();
      let total = 0;
      for (const [module, entries] of Object.entries(raw || {})) {
        if (!entries || typeof entries !== 'object') continue;
        if (!this._tombstones.has(module)) this._tombstones.set(module, new Map());
        const m = this._tombstones.get(module);
        for (const [id, ts] of Object.entries(entries)) {
          const t = Number(ts) || 0;
          if (t && now - t > this._tombstoneTtlMs) continue;   // 过期墓碑丢弃
          const prev = m.get(String(id)) || 0;
          if (t > prev) { m.set(String(id), t); total++; }
        }
      }
      if (total > 0) console.log(`[DataStore] 已同步墓碑 ${total} 条（${this._tombstones.size} 个模块）`);
    } catch (e) {
      console.warn(`[DataStore] 墓碑文件读取失败（忽略）: ${e.message}`);
    }
  }

  /**
   * 落盘前刷新墓碑：别的进程刚登记的删除必须立刻对本进程生效，
   * 否则本进程（删除发生前就已启动）flush 时会把它内存里的旧记录写回磁盘 = 删除被复活。
   * 墓碑文件很小（仅 id→ts），stat + 条件重读的开销可忽略。
   */
  _refreshTombstones() {
    try {
      const mt = fs.statSync(this._tombstoneFile).mtimeMs;
      if (this._tombstoneMtime === undefined || mt > this._tombstoneMtime) this._loadTombstones();
    } catch (_) { /* 文件不存在：无墓碑 */ }
  }

  /** 登记墓碑（仅显式删除调用） */
  _addTombstone(module, id) {
    // 只读进程连墓碑都不能登记：墓碑本身也是一种"删除"，会传播到其他进程，
    // 否则 3005/3012 里一次误删就会把 3002 的权威记录抹掉。
    if (!this._canWrite(module)) return;
    const key = String(id);
    if (!this._tombstones.has(module)) this._tombstones.set(module, new Map());
    this._tombstones.get(module).set(key, Date.now());
    this._tombstonesDirty = true;
  }

  /** 某条记录是否已被墓碑判定为「已删除」 */
  _isTombstoned(module, record) {
    if (!record) return false;
    const m = this._tombstones.get(module);
    if (!m || m.size === 0) return false;
    const ts = m.get(String(record.id));
    if (!ts) return false;
    const recT = Date.parse(record.updatedAt || record.createdAt || 0) || 0;
    // 墓碑晚于（或等于）记录的最后更新时间 → 删除生效；记录在墓碑之后被重建则保留
    return ts >= recT;
  }

  /** 落盘墓碑文件（随 flush 一起，保持低开销） */
  async _saveTombstones() {
    if (!this._tombstonesDirty) return;
    try {
      const now = Date.now();
      const out = {};
      let total = 0;
      for (const [module, m] of this._tombstones) {
        const entries = {};
        for (const [id, ts] of m) {
          if (now - ts > this._tombstoneTtlMs) continue;   // 顺带清理过期
          entries[id] = ts;
          total++;
        }
        if (Object.keys(entries).length) out[module] = entries;
      }
      await this._writeWithRetry(this._tombstoneFile, JSON.stringify(out));
      this._tombstonesDirty = false;
      if (total > 0) console.log(`[DataStore] 墓碑落盘 ${total} 条`);
    } catch (e) {
      console.warn(`[DataStore] 墓碑落盘失败（保留 dirty，下轮重试）: ${e.message}`);
    }
  }

  /** 墓碑统计（诊断用） */
  tombstoneStats() {
    const out = {};
    for (const [module, m] of this._tombstones) out[module] = m.size;
    return out;
  }

  /** 写入白名单统计（诊断用） */
  writeAllowStats() {
    return {
      allow: this._writeAllow === null ? 'unset(all)' : (this._writeAllow === 'all' ? 'all' : Array.from(this._writeAllow)),
      denied: Array.from(this._deniedWarned),
    };
  }

  /**
   * 加载所有数据文件
   */
  _loadAll() {
    const files = fs.readdirSync(this.dataDir).filter(f =>
      f.endsWith('.json') &&
      !f.startsWith('_') &&                 // _tombstones.json 等内部文件不是业务模块
      !/\.bak[-_.]/i.test(f)                 // content.bak-1788…json 之类的备份不加载
    );
    for (const file of files) {
      const module = file.replace('.json', '');
      try {
        const raw = fs.readFileSync(path.join(this.dataDir, file), 'utf8');
        const rawData = JSON.parse(raw);
        const map = new Map();
        const isArray = Array.isArray(rawData);
        this._storageShape.set(module, isArray ? 'array' : 'object');
        const items = isArray
          ? rawData
          : (rawData && typeof rawData === 'object' ? Object.entries(rawData).map(([key, value]) => {
              // 键控对象兼容：若记录缺 id，以 JSON key 作为稳定 ID；不修改源记录。
              if (value && typeof value === 'object' && !Array.isArray(value) && !value.id) {
                return Object.assign({ id: key }, value);
              }
              return value;
            }) : []);
        let tombstoned = 0;
        let autoIded = 0;
        for (let item of items) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          let id = item.id;
          if (id === undefined || id === null) {
            // 【2026-09-20 B5】此处原本是 `if (item.id !== undefined && item.id !== null) {…}`
            // —— 无 id 的记录被直接跳过，且【不写任何日志、不计数】，属于静默数据丢失。
            // 实测影响：trends 928 条 + system_audit 79 条被整模块丢弃（占全部记录 2.4%），
            // 表现为「文件里有数据，但列表页/时序图永远 0 条」，且无从察觉。
            // 现改为生成【确定性】id（内容指纹 + 冲突序号）：
            //   · 确定性 ⇒ 重复加载同一文件得到相同 id，不会重复插入、不会翻倍
            //   · 不再丢数据 ⇒ 列表与时间维度图能看到真实记录（仍零伪造：只是让真实数据可见）
            id = this._deriveAutoId(item, map);
            item = Object.assign({ id: id }, item);
            autoIded++;
          }
          // 墓碑生效：磁盘上这条记录已被别的进程显式删除过 → 沿用删除
          if (this._isTombstoned(module, item)) { tombstoned++; continue; }
          map.set(String(id), item);
        }
        if (autoIded > 0) {
          console.log(`[DataStore] ${module}: ${autoIded} 条记录缺 id → 已按内容指纹补确定性 id（此前会被静默丢弃）`);
        }
        if (tombstoned > 0) {
          console.log(`[DataStore] ${module}: 加载时丢弃 ${tombstoned} 条已墓碑记录（删除传播生效）`);
          this._dirty.add(module);   // 需要把墓碑后的状态写回磁盘
        }
        this._cache.set(module, map);
        this._history.set(module, []);
      } catch (e) {
        console.error(`[DataStore] Failed to load ${file}: ${e.message}`);
        this._cache.set(module, new Map());
        this._history.set(module, []);
      }
    }
    console.log(`[DataStore] Loaded ${this._cache.size} module data files from ${this.dataDir}`);
  }

  /**
   * 为「无 id 的记录」生成确定性 id。
   * 同一记录反复加载必须得到同一 id（否则每次重启都会把同一批数据再插一遍）。
   * 内容完全相同的多条记录（如多条同源热点）用 `_2`/`_3` 序号区分，
   * 序号按文件中的出现顺序分配 ⇒ 只要文件内容确定，结果就确定。
   */
  _deriveAutoId(item, map) {
    const base = 'auto_' + _fnv1a64(JSON.stringify(item));
    if (!map.has(base)) return base;
    let n = 2;
    while (map.has(base + '_' + n)) n++;
    return base + '_' + n;
  }

  /**
   * 写入脏数据到磁盘
   */
  /**
   * 落盘（异步、非阻塞）。
   * 关键修复（E 控制台负载降级）：旧实现是同步循环 writeFileSync + Atomics.wait 退避，
   * 在 Defender/索引服务瞬时锁住数据目录（EPERM/EBUSY）时，每个脏模块最多同步阻塞主线程
   * ~1.36s；多个脏模块叠加即造成事件循环冻结 → 控制台 HTML 在因果链负载下 30s 无响应头。
   * 改为 async：退避用 setTimeout 让出事件循环，fs 写用 fs.promises；单轮 flush 不再阻塞请求。
   * 失败时保留 dirty 标记，下一轮重试，不丢数据。
   */
  async _flush() {
    if (this._flushing) return; // 重负载下防止上一轮未结束就重叠启动
    this._flushing = true;
    try {
      const modules = Array.from(this._dirty);
      for (const module of modules) {
        try {
          await this._saveModule(module);
          this._dirty.delete(module);
        } catch (e) {
          console.error(`[DataStore] flush ${module} 失败（保留 dirty，下轮重试）: ${e.message}`);
        }
      }
      await this._saveTombstones();   // 墓碑随 flush 一起落盘
    } finally {
      this._flushing = false;
    }
  }

  async _saveModule(module) {
    const map = this._cache.get(module);
    if (!map) return;
    // 单写者隔离（2026-09-12）：本进程未被授权写该模块 → 绝不落盘。
    // 典型：3005(nurture)/3012(visitor) 与 3002 共用同一 DATA_DIR，若允许它们写
    // content.json（10MB / 1.2 万条），每 5s 整体写回就会把 3002 的更新抹掉。
    if (!this._canWrite(module)) return;
    // 墓碑过滤：内存中被显式删除过的记录不再写回（删除在多写者下可靠传播）
    this._refreshTombstones();   // 先同步别的进程刚登记的删除，再决定写什么
    let arr = Array.from(map.values()).filter(it => !this._isTombstoned(module, it));
    const filePath = path.join(this.dataDir, `${module}.json`);
    // ── 合并落盘保护（防外部进程写盘被覆盖）──
    // 【2026-09-12 关键修复】看门狗的 BASE_ENV 给 3002 / 3005 / 3012 三个服务注入了
    // 同一个 DATA_DIR，三方各自持有整份模块的内存副本并每 5s 落盘 → 任一方的陈旧快照
    // 都会把另一方的更新整体抹掉。实测同一个 content.json 在 3 个快照间振荡
    // （20946 / 22516 / 20868 条），状态修改（批量 quarantine）5~20 秒内被回滚，
    // canary 标记凭空消失。故按模块区分两种并表模式：
    //   · 'append'（accounts）：磁盘独有记录并入 + 逐记录 LWW —— 外部脚本（onboard）会直接写盘，
    //                            必须保住它追加的记录。
    //   · 'lww'   （content） ：**只做逐记录 LWW，不回收磁盘独有记录** —— content 的唯一
    //                            创建方是本进程群的 S4 落库点，不存在「外部追加」场景；
    //                            而一旦回收磁盘独有记录，prune 刚删掉的垃圾就会被自己的
    //                            flush 从磁盘捞回来，裁剪永远失效。故 content 只收敛、
    //                            不补录，使「删除」在多写者下也能生效。
    const _mergeMode = (this._mergeOnFlush && this._mergeOnFlush.get(module)) || null;
    if (_mergeMode) {
      try {
        let exists = true;
        try { await fsProm.access(filePath); } catch (_) { exists = false; }
        if (exists) {
          const raw = JSON.parse(await fsProm.readFile(filePath, 'utf8'));
          const diskItems = Array.isArray(raw)
            ? raw
            : (raw && typeof raw === 'object' ? Object.values(raw) : []);
          let merged = 0;
          let tookDisk = 0;
          for (const item of diskItems) {
            if (!item || item.id == null) continue;
            if (this._isTombstoned(module, item)) continue;   // 已墓碑：删除优先于并表
            const key = String(item.id);
            const mine = map.get(key);
            if (!mine) {
              if (_mergeMode === 'append') { arr.push(item); merged++; }
              continue;
            }
            // 逐记录 LWW：磁盘版本更新则采用磁盘版本
            const dT = Date.parse(item.updatedAt || 0) || 0;
            const mT = Date.parse(mine.updatedAt || 0) || 0;
            if (dT > mT) {
              map.set(key, item);
              tookDisk++;
            }
          }
          if (merged > 0 || tookDisk > 0) {
            console.log(`[DataStore] _saveModule(${module}) [${_mergeMode}] 合并磁盘独有 ${merged} 条 / 采用磁盘较新 ${tookDisk} 条（多写者 LWW 收敛）`);
            // 采用磁盘版本后需重建待写数组，确保采用的版本真正落盘
            if (tookDisk > 0) arr = Array.from(map.values());
          }
        }
      } catch (e) {
        console.warn(`[DataStore] _saveModule(${module}) 合并磁盘记录失败（忽略，继续主写入）: ${e.message}`);
      }
    }
    try {
      // 保持外部流程使用的键控对象形态（例如 tumblr_token.json），避免落盘后破坏按账号 ID 读取。
      const payload = this._storageShape.get(module) === 'object'
        ? Object.fromEntries(arr.map(item => [String(item.id), item]))
        : arr;
      // 大模块使用紧凑 JSON 减少磁盘 I/O
      const json = arr.length > 500
        ? JSON.stringify(payload)
        : JSON.stringify(payload, null, 2);
      // Windows 下高频 flush 会被 Defender(MsMpEng)/索引服务瞬时锁住文件 → EPERM/EBUSY，
      // 直接写会导致整轮数据丢失。这里做退避重试（非阻塞），绝大多数瞬时锁都能自愈。
      await this._writeWithRetry(filePath, json);
    } catch (e) {
      console.error(`[DataStore] Failed to save ${module}: ${e.message}`);
    }
  }

  /**
   * 带退避重试的文件写入（异步、非阻塞）。
   * 背景：C 盘写满迁至 D 盘后，大文件写入期间会被外部进程（Defender 扫描、
   *       WorkBuddy safe-delete 守卫）短暂独占句柄，writeFileSync 抛 EPERM。
   *       属性/ACL 均正常，属瞬时锁；此处为应用层兜底。
   * 关键修复（E）：旧实现用 fs.writeFileSync + Atomics.wait 同步退避，会在主线程阻塞最长
   *       ~1.36s/模块；重负载多模块叠加即冻结事件循环。现改为 fs.promises + setTimeout 退避，
   *       写盘期间让出事件循环，静态资源服务（express.static/res.sendFile）不再被饿死。
   * @returns {Promise<boolean>} 是否写入成功
   */
  async _writeWithRetry(filePath, json, maxRetries = 4) {
    const delays = [0, 60, 150, 350, 800];
    // 原子写入：临时文件 → rename 覆盖，替换瞬时完成，原文件写入期间不被独占。
    // 临时文件刻意放在【数据目录之外】：safe-delete 守卫会监视数据目录内的
    // 新增/删除动作并锁文件（曾导致 .tmp 残留 19 个、写入持续 EPERM）。
    const tmpDir = process.env.MSCMS_TMP_DIR || 'D:\\mscms-tmp';
    const tmp = path.join(tmpDir, `${path.basename(filePath)}.${process.pid}.tmp`);
    let lastErr;
    for (let i = 0; i <= maxRetries; i++) {
      if (delays[i]) await new Promise(r => setTimeout(r, delays[i])); // 非阻塞退避
      try {
        try { await fsProm.mkdir(tmpDir, { recursive: true }); } catch (_) { /* 已存在 */ }
        await fsProm.writeFile(tmp, json, 'utf8');
        await fsProm.rename(tmp, filePath);   // 同卷 rename 为原子操作
        return true;
      } catch (e) {
        lastErr = e;
        // 清理残留临时文件，避免脏数据堆积
        try { await fsProm.unlink(tmp); } catch (_) { /* ignore */ }
        // 仅对"瞬时锁"类错误重试；ENOSPC 等非瞬时错误立即放弃，避免无谓阻塞
        if (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES') break;
      }
    }
    throw lastErr;
  }

  _markDirty(module) {
    // 单写者隔离：未被授权写的模块不进 dirty 队列（prune / startupPrune 也走这里，
    // 因此只读服务不会因为「裁剪」而把整个模块写回磁盘覆盖属主）。
    if (!this._canWrite(module)) return;
    this._dirty.add(module);
  }

  _ensureModule(module) {
    if (!this._cache.has(module)) {
      this._cache.set(module, new Map());
      this._history.set(module, []);
    }
  }

  _genId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
  }

  _addHistory(module, action, id, before, after) {
    // 性能优化：高频模块不存储深拷贝（省去 JSON.parse(JSON.stringify) 开销）
    const isHighVolume = this._pruneConfig && this._pruneConfig[module];
    if (isHighVolume) return;
    
    if (!this._history.has(module)) this._history.set(module, []);
    this._history.get(module).push({
      id: this._genId(),
      recordId: id,
      action, // create / update / delete
      before: before ? JSON.parse(JSON.stringify(before)) : null,
      after: after ? JSON.parse(JSON.stringify(after)) : null,
      ts: new Date().toISOString()
    });
    // 保留最近 1000 条历史
    const hist = this._history.get(module);
    if (hist.length > 1000) {
      this._history.set(module, hist.slice(-1000));
    }
  }

  /**
   * 查询列表
   * @param {string} module - 模块名
   * @param {object} opts - { search, filter, sort, order, page, limit }
   */
  list(module, opts = {}) {
    this._ensureModule(module);
    const map = this._cache.get(module);
    let arr = Array.from(map.values());

    // 搜索
    if (opts.search) {
      const q = opts.search.toLowerCase();
      arr = arr.filter(item =>
        JSON.stringify(item).toLowerCase().includes(q)
      );
    }

    // 筛选（精确匹配字段值）
    if (opts.filter && typeof opts.filter === 'object') {
      for (const [key, val] of Object.entries(opts.filter)) {
        if (val !== undefined && val !== null && val !== '') {
          arr = arr.filter(item => String(item[key]) === String(val));
        }
      }
    }

    // 排序
    if (opts.sort) {
      const key = opts.sort;
      const order = opts.order === 'desc' ? -1 : 1;
      arr.sort((a, b) => {
        const va = a[key], vb = b[key];
        if (va === undefined) return 1;
        if (vb === undefined) return -1;
        if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * order;
        return String(va).localeCompare(String(vb)) * order;
      });
    }

    // 分页
    const total = arr.length;
    const page = opts.page || 1;
    const limit = opts.limit || 20;
    const start = (page - 1) * limit;
    const items = arr.slice(start, start + limit);

    return { items, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /**
   * 查询单条
   */
  get(module, id) {
    this._ensureModule(module);
    return this._cache.get(module).get(String(id)) || null;
  }

  /**
   * 新建
   */
  create(module, data) {
    this._ensureModule(module);
    const id = data.id || this._genId();
    const now = new Date().toISOString();
    const record = { ...data, id, createdAt: now, updatedAt: now };
    this._cache.get(module).set(String(id), record);
    // 重建即撤销墓碑：新记录 updatedAt=now 已晚于墓碑，此处主动清理避免墓碑无限增长
    const tm = this._tombstones.get(module);
    if (tm && tm.delete(String(id))) this._tombstonesDirty = true;
    this._addHistory(module, 'create', id, null, record);
    this._markDirty(module);
    return record;
  }

  /**
   * 批量新建
   */
  createBatch(module, items) {
    this._ensureModule(module);
    const results = [];
    for (const item of items) {
      results.push(this.create(module, item));
    }
    return results;
  }

  /**
   * 更新
   */
  update(module, id, data) {
    this._ensureModule(module);
    const map = this._cache.get(module);
    const key = String(id);
    const existing = map.get(key);
    if (!existing) return null;
    const updated = { ...existing, ...data, id, updatedAt: new Date().toISOString() };
    map.set(key, updated);
    this._addHistory(module, 'update', id, existing, updated);
    this._markDirty(module);
    return updated;
  }

  /**
   * 从磁盘重新加载某个模块（覆盖内存缓存）。
   * 用于：tumblr-onboard.js 等外部进程直接写 accounts.json 后，
   * 让运行中的 3003 服务能感知新增账号（否则内存缓存会是过期快照）。
   */
  reloadModule(module) {
    const filePath = path.join(this.dataDir, `${module}.json`);
    if (!fs.existsSync(filePath)) { this._ensureModule(module); return; }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const rawData = JSON.parse(raw);
      const map = new Map();
      const isArray = Array.isArray(rawData);
      this._storageShape.set(module, isArray ? 'array' : 'object');
      const items = isArray
        ? rawData
        : (rawData && typeof rawData === 'object' ? Object.entries(rawData).map(([key, value]) => {
            if (value && typeof value === 'object' && !Array.isArray(value) && !value.id) {
              return Object.assign({ id: key }, value);
            }
            return value;
          }) : []);
      for (const item of items) {
        if (item && item.id !== undefined && item.id !== null) {
          if (this._isTombstoned(module, item)) continue;
          map.set(String(item.id), item);
        }
      }
      this._cache.set(module, map);
      this._history.set(module, []);
    } catch (e) {
      console.error(`[DataStore] reloadModule 失败 ${module}: ${e.message}`);
    }
  }

  /**
   * 删除
   */
  delete(module, id) {
    this._ensureModule(module);
    const map = this._cache.get(module);
    const key = String(id);
    const existing = map.get(key);
    if (!existing) return false;
    map.delete(key);
    // 墓碑：本进程删掉的记录，别的进程（持同一 DATA_DIR）内存里还有、flush 时会写回来。
    // 登记删除时间戳后，任何进程落盘/加载都会丢弃 updatedAt 早于墓碑的该条记录。
    this._addTombstone(module, key);
    this._addHistory(module, 'delete', id, existing, null);
    this._markDirty(module);
    return true;
  }

  /**
   * 历史记录
   */
  history(module, id, limit = 50) {
    if (!this._history.has(module)) return [];
    let hist = this._history.get(module);
    if (id) {
      hist = hist.filter(h => h.recordId === id);
    }
    return hist.slice(-limit);
  }

  /**
   * 总数
   */
  count(module) {
    this._ensureModule(module);
    return this._cache.get(module).size;
  }

  /**
   * 获取所有模块名
   */
  getModules() {
    return Array.from(this._cache.keys());
  }

  /**
   * 获取模块统计
   */
  getModuleStats(module) {
    this._ensureModule(module);
    const map = this._cache.get(module);
    const hist = this._history.get(module) || [];
    return {
      module,
      totalRecords: map.size,
      historyEntries: hist.length,
      lastModified: hist.length > 0 ? hist[hist.length - 1].ts : null
    };
  }

  /**
   * 导出
   */
  export(module, format = 'json') {
    this._ensureModule(module);
    const arr = Array.from(this._cache.get(module).values());
    
    if (format === 'csv') {
      if (arr.length === 0) return '';
      const keys = Object.keys(arr[0]);
      const lines = [keys.join(',')];
      for (const item of arr) {
        lines.push(keys.map(k => {
          const v = item[k];
          if (v === null || v === undefined) return '';
          if (typeof v === 'object') return `"${JSON.stringify(v).replace(/"/g, '""')}"`;
          return `"${String(v).replace(/"/g, '""')}"`;
        }).join(','));
      }
      return lines.join('\n');
    }
    
    return JSON.stringify(arr, null, 2);
  }

  /**
   * 清理旧数据 — 保留最新 maxKeep 条记录（按 createdAt 降序）
   * @returns {number} 被删除的记录数
   */
  prune(module, maxKeep) {
    this._ensureModule(module);
    // 单写者隔离：本进程无权写该模块时，连裁剪都不做。
    // 否则只读服务（3005/3012）的 startup/periodic prune 会白跑一遍 1.2 万条 content
    // 的排序+删除（CPU/内存 churn），写盘又被拒 → 纯浪费。
    if (!this._canWrite(module)) return 0;
    const map = this._cache.get(module);
    if (map.size <= maxKeep) return 0;
    
    // 保留 Map 的 key（而非依赖 item.id）：
    // 早期实现用 `if (item && item.id) map.delete(item.id)`，
    // 一旦记录缺少 id 字段就永远删不掉 —— account_tracker_cycles 曾因此堆积到
    // 4719 条 / 25MB（配置 maxKeep 仅 500），单次写入耗时过长并反复触发 EPERM 锁冲突。
    const entries = Array.from(map.entries());
    // 按 createdAt 降序排列（最新的在前）
    entries.sort((a, b) => {
      const ra = a[1] || {};
      const rb = b[1] || {};
      const ta = new Date(ra.createdAt || ra.updatedAt || 0).getTime();
      const tb = new Date(rb.createdAt || rb.updatedAt || 0).getTime();
      return tb - ta;
    });

    const cfg = this._pruneConfig[module] || {};
    const toRemove = entries.slice(maxKeep);
    let removed = 0;
    for (const [key, item] of toRemove) {
      // 受保护记录（如已发布内容 published===true）免裁剪，确保发布外键可溯源、闭环不断裂
      if (cfg.protect && cfg.protect(item)) continue;
      if (map.delete(key)) removed++;
    }
    
    this._markDirty(module);
    console.log(`[DataStore] Pruned ${removed} old records from '${module}' (kept ${map.size})`);
    return removed;
  }

  /**
   * 启动时清理膨胀模块（超过 maxKeep × 2 的模块）
   */
  _startupPrune() {
    let totalPruned = 0;
    for (const [module, config] of Object.entries(this._pruneConfig)) {
      const map = this._cache.get(module);
      if (map && map.size > config.maxKeep * 2) {
        totalPruned += this.prune(module, config.maxKeep);
      }
    }
    if (totalPruned > 0) {
      console.log(`[DataStore] Startup pruning: removed ${totalPruned} records total, flushing to disk...`);
      this._flush();
    }
  }

  /**
   * 定期清理（超过 maxKeep × 1.5 的模块）
   */
  _periodicPrune() {
    for (const [module, config] of Object.entries(this._pruneConfig)) {
      const map = this._cache.get(module);
      if (map && map.size > config.maxKeep * 1.5) {
        this.prune(module, config.maxKeep);
      }
    }
  }

  /**
   * 关联查询 — 获取一个记录在所有模块中的关联数据
   * 支持 account_id, content_id, post_id, bot_id 等多维度溯源
   */
  findRelated(id, modules) {
    const result = {};
    for (const mod of modules) {
      this._ensureModule(mod);
      const arr = Array.from(this._cache.get(mod).values());
      result[mod] = arr.filter(item =>
        item.account_id === id ||
        item.accountId === id ||
        item.linked_account === id ||
        item.content_id === id ||
        item.contentId === id ||
        item.post_id === id ||
        item.postId === id ||
        item.bot_id === id ||
        item.botId === id ||
        item.id === id ||
        item.source_id === id ||
        item.link_id === id ||
        item.variant_id === id ||
        item.task_id === id
      );
    }
    return result;
  }

  /**
   * 强制写入（异步、非阻塞，返回 Promise）
   */
  flush() {
    return this._flush();
  }

  /**
   * 关闭
   */
  async destroy() {
    try { await this._flush(); } catch (_) { /* 忽略关闭期写入错误 */ }
    try { await this._saveTombstones(); } catch (_) { /* 忽略 */ }
    clearInterval(this._flushInterval);
    clearInterval(this._pruneInterval);
  }
}

module.exports = { DataStore };
