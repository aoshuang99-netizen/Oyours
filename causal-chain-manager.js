/**
 * causal-chain-manager.js — MSCMS v14 因果链自动触发器
 * 
 * 负责自动触发7条因果链事件，确保端到端自动化流程正常运行：
 *   account.registered  (注册完成 → 养号开始)
 *   account.healthy     (养号达标 → 发布开始)
 *   content.generated   (内容生成 → 发布队列)
 *   post.published      (发布完成 → 营销开始)
 *   visit.recorded      (访客记录 → 分析开始)
 *   dau.updated         (DAU更新 → 决策引擎)
 *   action.execute       (决策执行 → 营销动作)
 * 
 * 触发策略：
 *   1. 数据库轮询（每30秒检查一次状态变化）
 *   2. API回调（各个模块完成任务后调用）
 *   3. 事件监听（监听模块内部事件）
 */

const { EventBus, CAUSAL_EVENTS } = require('./event-bus');
const { createServerLogger } = require('./server-logger');

class CausalChainManager {
  constructor(eventBus, dataStore, dbPool) {
    this.eventBus = eventBus;
    this.dataStore = dataStore;
    this.db = dbPool;
    this.logger = createServerLogger('CHAIN');
    
    // 状态跟踪
    this.lastCheck = {
      accounts: new Map(),      // account_id → last healthy score
      contents: new Map(),       // content_id → last status
      posts: new Map(),          // post_id → last status
      visits: new Map(),         // visit_id → last status
      dau: new Map(),           // date → last dau count
    };
    
    this.intervals = [];
    this.isRunning = false;
    this.dbErrorCount = 0; // MySQL错误计数，避免日志刷屏
    this._emptyContentWarned = false; // 2026-09-12：MySQL 无可发布内容只警告一次
  }

  /**
   * 启动因果链管理器
   */
  start() {
    if (this.isRunning) {
      this.logger.warn('CausalChainManager already running');
      return;
    }
    
    this.isRunning = true;
    this.logger.info('Starting CausalChainManager...');
    
    // 启动数据库轮询（每30秒）
    const pollInterval = setInterval(() => this.pollDatabase(), 30000);
    this.intervals.push(pollInterval);
    
    // 监听模块内部事件
    this.setupEventListeners();
    
    // 启动链监控
    this.eventBus.startChainMonitor(CAUSAL_EVENTS);
    
    this.logger.info('CausalChainManager started successfully');
  }

  /**
   * 停止因果链管理器
   */
  stop() {
    this.isRunning = false;
    this.logger.info('Stopping CausalChainManager...');
    
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.intervals = [];
    
    this.eventBus.stopChainMonitor();
    
    this.logger.info('CausalChainManager stopped');
  }

  /**
   * 数据库轮询 — 检测状态变化并触发事件
   */
  async pollDatabase() {
    if (!this.isRunning) return;
    
    // 快速测试MySQL是否可用，不可用则跳过本轮（避免刷屏）
    if (this.db) {
      try {
        await this.db.query('SELECT 1');
        this.dbErrorCount = 0;
      } catch (e) {
        if (this.dbErrorCount < 1) {
          this.logger.info('MySQL unavailable, skipping DB polling (events handled by in-memory chain)');
          this.dbErrorCount = 1;
        }
        return;
      }
    }
    
    try {
      // 1. 检查账号养号状态 → 触发 account.healthy
      await this.checkAccountHealth();
      
      // 2. 检查内容生成状态 → 触发 content.generated
      await this.checkContentGeneration();
      
      // 3. 检查发布状态 → 触发 post.published
      await this.checkPostPublication();
      
      // 4. 检查访客记录 → 触发 visit.recorded
      await this.checkVisitRecords();
      
      // 5. 检查DAU更新 → 触发 dau.updated
      await this.checkDAUUpdate();
      
    } catch (err) {
      this.logger.error(`Poll error: ${err.message}`);
    }
  }

  /**
   * 检查账号养号状态
   */
  async checkAccountHealth() {
    if (!this.db) return;
    
    try {
      const [rows] = await this.db.query(`
        SELECT id, email, platform, status, health_score, ban_risk_score, warming_day
        FROM matrix_accounts_managed
        WHERE status IN ('warming', 'active')
        AND health_score IS NOT NULL
      `);
      
      for (const account of rows) {
        const lastScore = this.lastCheck.accounts.get(account.id);
        const currentScore = account.health_score || 0;
        
        // 首次检测到健康分数 > 70 → 触发 account.healthy
        if (currentScore >= 70 && (lastScore === undefined || lastScore < 70)) {
          this.logger.info(`Account ${account.email} healthy (score=${currentScore}), emitting account.healthy`);
          
          this.eventBus.emit('account.healthy', {
            account_id: account.id,
            email: account.email,
            platform: account.platform,
            score: currentScore,
            risk_score: account.ban_risk_score,
            warming_day: account.warming_day
          }, 'causal-chain-manager');
        }
        
        // 更新跟踪状态
        this.lastCheck.accounts.set(account.id, currentScore);
      }
    } catch (err) {
      this.logger.error(`checkAccountHealth error: ${err.message}`);
    }
  }

  /**
   * 检查内容生成状态
   */
  async checkContentGeneration() {
    if (!this.db) return;

    // 【2026-09-12 源头掐断·终版】显式停用「影子表回读」。
    //
    // 机理（已实测确认）：
    //   matrix_content_generated 是 server.js:3446 写入的**影子表**——MSCMS 在内容落库时
    //   并行插一行，用途是拿 MySQL 自增 id 当 `matrix_id`（供 content-media-bridge 生图、
    //   供发布器在发布前等图就绪）。该 INSERT 的列清单**故意不含 body**
    //   → 全表 85.7 万行 body 恒为 NULL。这是「只写设计」，不是数据缺失。
    //
    //   而本方法把这张影子表当成「外部内容源」回读，于是形成**自回声循环**：
    //     DataStore 落库 → INSERT 影子行(丢 body) → 本方法回读 → emit content.generated
    //     → server.js:3386 落库点再 create 一条 DataStore 记录(id = MySQL id)
    //     → 该记录又 INSERT 影子行 → …… 每跳产出一条 body 为空的垃圾记录。
    //   修复前实测 42 条/分钟（首版媒体豁免下仍有 ~2 条/分钟），
    //   累计向 ready 池灌入约 1.6 万条纯数字 id 的空正文记录。
    //
    //   影子表**永远不可能**成为合法内容源（唯一写入方是 MSCMS 自己，且不写 body），
    //   故彻底停用回读。下方带 body 过滤的 SQL 保留为第二道防线：
    //   若将来有人给 INSERT 补上 body 字段，须连同本开关一并评审，避免回声复活。
    const SHADOW_READBACK_ENABLED = false;
    if (!SHADOW_READBACK_ENABLED) {
      if (!this._shadowReadbackDisabledWarned) {
        this._shadowReadbackDisabledWarned = true;
        this.logger.warn('checkContentGeneration: 影子表回读已停用（防自回声循环，详见代码注释）；内容来源应走 DataStore → S4 落库点');
      }
      return;
    }

    try {
      // 【2026-09-12 污染源掐断】原 SQL 只 SELECT title/quality_score，不带 body。
      // 实测 matrix_content_generated 虽有 body text 列，但 85.7 万行全为 NULL、
      // preview_url 亦全空 → 每次 emit 出的 content.generated 都是「只有标题、
      // 没有正文」，靠落库守卫的短路 bug 以 42 条/分钟灌入 ready 发布池
      // （1.4 万条纯数字 id 记录 100% 空正文）。
      // 现在在 SQL 层直接过滤：必须有有效正文，查不到行即不再产生无效事件。
      // 【二次收紧 2026-09-12】首版曾用 preview_url 作「媒体贴豁免」，但实测该表的
      // preview_url 是同一张图被反复引用（每 30 秒新增数条 body=NULL 的伪媒体贴），
      // 仍以 ~2 条/分钟绕过滤进入 ready 池。故收紧为「必须有有效正文」——
      // 全表 body 有效行数 = 0，等价于彻底停掉这条脏通道。
      const [rows] = await this.db.query(`
        SELECT id, account_id, platform, type, content_type, title, body, preview_url, quality_score
        FROM matrix_content_generated
        WHERE status = 'ready'
        AND emitted_at IS NULL
        AND body IS NOT NULL
        AND CHAR_LENGTH(TRIM(body)) >= 30
        LIMIT 10
      `);

      if (rows.length === 0) {
        // 表内暂无可发布内容时只提示一次，避免每 30 秒刷屏
        if (!this._emptyContentWarned) {
          this._emptyContentWarned = true;
          this.logger.warn('checkContentGeneration: matrix_content_generated 无可发布内容（body 为空且无 preview_url），已跳过 emit；该 MySQL 链路需写入 body 后才能进入因果链');
        }
        return;
      }

      for (const content of rows) {
        this.logger.info(`Content ${content.id} ready, emitting content.generated`);
        
        this.eventBus.emit('content.generated', {
          content_id: content.id,
          account_id: content.account_id,
          platform: content.platform,
          type: content.type,
          content_type: content.content_type,
          title: content.title,
          body: content.body,
          preview_url: content.preview_url,
          quality_score: content.quality_score
        }, 'causal-chain-manager');
        
        // 标记已触发
        await this.db.query(
          'UPDATE matrix_content_generated SET emitted_at = NOW() WHERE id = ?',
          [content.id]
        );
      }
    } catch (err) {
      this.logger.error(`checkContentGeneration error: ${err.message}`);
    }
  }

  /**
   * 检查发布状态
   */
  async checkPostPublication() {
    if (!this.db) return;
    
    try {
      const [rows] = await this.db.query(`
        SELECT id, account_id, content_id, content_account_id, platform, status, post_url, published_at
        FROM matrix_posts_published
        WHERE status = 'published'
        AND emitted_at IS NULL
        LIMIT 10
      `);

      for (const post of rows) {
        this.logger.info(`Post ${post.id} published, emitting post.published`);

        // 【去重修复】这是对数据库「已落库记录」的事件重放，并非一次新的真实发布。
        // 必须显式带 replay 标记与原始 post_url —— 否则 server.js 的 marketing 监听器
        // 会因 publish_url 缺失，把每条真实发布再写一条 status='not_published' 的幽灵行
        // （历史数据中该表约一半是这类幽灵记录）。
        this.eventBus.emit('post.published', {
          post_id: post.id,
          account_id: post.account_id,
          content_id: post.content_id,
          content_account_id: post.content_account_id || post.account_id || null,
          platform: post.platform,
          published_at: post.published_at,
          publish_url: post.post_url || null,
          replay: true,
        }, 'causal-chain-manager');
        
        // 标记已触发
        await this.db.query(
          'UPDATE matrix_posts_published SET emitted_at = NOW() WHERE id = ?',
          [post.id]
        );
      }
    } catch (err) {
      this.logger.error(`checkPostPublication error: ${err.message}`);
    }
  }

  /**
   * 检查访客记录
   */
  async checkVisitRecords() {
    if (!this.db) return;
    
    try {
      const [rows] = await this.db.query(`
        SELECT id, post_id, account_id, visitor_type, ip, ua, referrer, landing_page, duration, is_unique, source, recorded_at
        FROM matrix_visits_recorded
        WHERE emitted_at IS NULL
        ORDER BY recorded_at DESC
        LIMIT 20
      `);
      
      for (const visit of rows) {
        this.logger.info(`Visit ${visit.id} recorded, emitting visit.recorded`);
        
        this.eventBus.emit('visit.recorded', {
          visit_id: visit.id,
          post_id: visit.post_id,
          account_id: visit.account_id,
          visitor_type: visit.visitor_type,
          ip: visit.ip,
          ua: visit.ua,
          referrer: visit.referrer,
          landing_page: visit.landing_page,
          duration: visit.duration || 0,
          is_unique: !!visit.is_unique,
          source: visit.source || 'organic',
          platform: visit.source || 'unknown',
          country: 'DB',
          device_id: null,
          recorded_at: visit.recorded_at
        }, 'causal-chain-manager');
        
        // 标记已触发
        await this.db.query(
          'UPDATE matrix_visits_recorded SET emitted_at = NOW() WHERE id = ?',
          [visit.id]
        );
      }
    } catch (err) {
      this.logger.error(`checkVisitRecords error: ${err.message}`);
    }
  }

  /**
   * 检查DAU更新
   */
  async checkDAUUpdate() {
    if (!this.db) return;
    
    try {
      const [rows] = await this.db.query(`
        SELECT id, date, platform, dau_count, updated_at
        FROM matrix_dau_stats
        WHERE emitted_at IS NULL
        ORDER BY date DESC
        LIMIT 5
      `);
      
      for (const dau of rows) {
        this.logger.info(`DAU ${dau.date} updated (count=${dau.dau_count}), emitting dau.updated`);
        
        this.eventBus.emit('dau.updated', {
          dau_id: dau.id,
          date: dau.date,
          platform: dau.platform,
          dau_count: dau.dau_count,
          updated_at: dau.updated_at
        }, 'causal-chain-manager');
        
        // 标记已触发
        await this.db.query(
          'UPDATE matrix_dau_stats SET emitted_at = NOW() WHERE id = ?',
          [dau.id]
        );
      }
    } catch (err) {
      this.logger.error(`checkDAUUpdate error: ${err.message}`);
    }
  }

  /**
   * 设置事件监听器 — 监听模块内部事件
   */
  setupEventListeners() {
    // 监听注册完成事件（来自 full-auto-register.js）
    this.eventBus.on('registration.completed', 'causal-chain-manager', async (data) => {
      this.logger.info(`Registration completed for ${data.email}, emitting account.registered`);
      
      this.eventBus.emit('account.registered', {
        account_id: data.account_id,
        email: data.email,
        platform: data.platform,
        username: data.username,
        password: data.password,
        phone: data.phone,
        registration_ip: data.registration_ip,
        proxy_used: data.proxy_used
      }, 'causal-chain-manager');
    });
    
    // 监听养号完成事件（来自 account-nurturing.js）
    this.eventBus.on('nurturing.completed', 'causal-chain-manager', async (data) => {
      this.logger.info(`Nurturing completed for ${data.account_id}, emitting account.healthy`);
      
      this.eventBus.emit('account.healthy', {
        account_id: data.account_id,
        score: data.health_score,
        warming_day: data.warming_day
      }, 'causal-chain-manager');
    });
    
    // 监听内容生成完成事件（来自 aigc-content-generator.js）
    this.eventBus.on('content.completed', 'causal-chain-manager', async (data) => {
      this.logger.info(`Content generation completed for ${data.content_id}, emitting content.generated`);
      
      this.eventBus.emit('content.generated', {
        content_id: data.content_id,
        account_id: data.account_id,
        platform: data.platform,
        type: data.type,
        title: data.title,
        quality_score: data.quality_score
      }, 'causal-chain-manager');
    });
    
    // 监听发布完成事件（来自 smart-publisher.js）
    this.eventBus.on('publish.completed', 'causal-chain-manager', async (data) => {
      this.logger.info(`Publishing completed for ${data.post_id}, emitting post.published`);
      
      this.eventBus.emit('post.published', {
        post_id: data.post_id,
        account_id: data.account_id,
        content_id: data.content_id,
        platform: data.platform,
        published_at: data.published_at
      }, 'causal-chain-manager');
    });
    
    this.logger.info('Event listeners setup completed');
  }

  /**
   * API回调 — 供各个模块直接调用
   */
  triggerAccountRegistered(accountData) {
    this.logger.info(`API trigger: account.registered for ${accountData.email}`);
    this.eventBus.emit('account.registered', accountData, 'api-callback');
  }
  
  triggerAccountHealthy(accountData) {
    this.logger.info(`API trigger: account.healthy for ${accountData.account_id}`);
    this.eventBus.emit('account.healthy', accountData, 'api-callback');
  }
  
  triggerContentGenerated(contentData) {
    this.logger.info(`API trigger: content.generated for ${contentData.content_id}`);
    this.eventBus.emit('content.generated', contentData, 'api-callback');
  }
  
  triggerPostPublished(postData) {
    this.logger.info(`API trigger: post.published for ${postData.post_id}`);
    this.eventBus.emit('post.published', postData, 'api-callback');
  }
  
  triggerVisitRecorded(visitData) {
    this.logger.info(`API trigger: visit.recorded for ${visitData.visit_id}`);
    this.eventBus.emit('visit.recorded', visitData, 'api-callback');
  }
  
  triggerDAUUpdated(dauData) {
    this.logger.info(`API trigger: dau.updated for ${dauData.date}`);
    this.eventBus.emit('dau.updated', dauData, 'api-callback');
  }
  
  triggerActionExecute(actionData) {
    this.logger.info(`API trigger: action.execute for ${actionData.action_type}`);
    this.eventBus.emit('action.execute', actionData, 'api-callback');
  }
}

module.exports = { CausalChainManager };
