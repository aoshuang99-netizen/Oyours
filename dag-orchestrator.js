/**
 * dag-orchestrator.js — MSCMS v14 DAG 任务编排引擎
 *
 * 核心能力：
 *   1. 可视化拖拽DAG编辑器（节点+连线JSON模型）
 *   2. 拓扑排序依赖解析（自动检测循环依赖）
 *   3. 7状态状态机（IDLE/PENDING/RUNNING/SUCCESS/FAILED/SKIPPED/RETRY）
 *   4. 断点续传（任务快照+恢复）
 *   5. 3个预设模板（注册流/养号流/内容发布流）
 */

const { EventEmitter } = require('events');
const crypto = require('crypto');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

// ── 节点状态枚举 ─────────────────────────────────
const NodeStatus = {
  IDLE: 'idle',
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCESS: 'success',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  RETRY: 'retry',
};

// ── 节点类型枚举 ─────────────────────────────────
const NodeType = {
  TASK: 'task',           // 普通任务
  CONDITION: 'condition', // 条件分支
  PARALLEL: 'parallel',   // 并行组
  WAIT: 'wait',           // 等待/延迟
  SCRIPT: 'script',       // 脚本执行
  WEBHOOK: 'webhook',     // 外部回调
  LOOP: 'loop',           // 循环
  SUBGRAPH: 'subgraph',   // 子DAG
};

// ── DAG 节点 ─────────────────────────────────────
class DAGNode {
  constructor(opts = {}) {
    this.id = opts.id || `node_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this.type = opts.type || NodeType.TASK;
    this.label = opts.label || '未命名节点';
    this.description = opts.description || '';
    this.config = opts.config || {};     // 节点配置
    this.position = opts.position || { x: 0, y: 0 };
    this.status = NodeStatus.IDLE;
    this.dependsOn = opts.dependsOn || []; // 前置依赖节点ID列表
    this.output = null;
    this.error = null;
    this.startedAt = null;
    this.completedAt = null;
    this.retryCount = 0;
    this.maxRetries = opts.maxRetries || 3;
    this.retryDelayMs = opts.retryDelayMs || 5000;
    this.timeoutMs = opts.timeoutMs || 300000;
    this.executor = opts.executor || null; // async (node) => result
  }
}

// ── DAG 边 ───────────────────────────────────────
class DAGEdge {
  constructor(opts = {}) {
    this.id = opts.id || `edge_${Date.now()}_${crypto.randomBytes(3'hex')}`;
    this.sourceId = opts.sourceId;
    this.targetId = opts.targetId;
    this.label = opts.label || '';
    this.condition = opts.condition || null; // 条件表达式
  }
}

// ── DAG 工作流 ───────────────────────────────────
class DAGWorkflow {
  constructor(opts = {}) {
    this.id = opts.id || `dag_${Date.now()}_${crypto.randomBytes(4'hex')}`;
    this.name = opts.name || '未命名工作流';
    this.description = opts.description || '';
    this.nodes = new Map();     // nodeId → DAGNode
    this.edges = [];            // DAGEdge[]
    this.status = NodeStatus.IDLE;
    this.createdAt = new Date().toISOString();
    this.updatedAt = new Date().toISOString();
    this.metadata = opts.metadata || {};
  }

  addNode(opts) {
    const node = new DAGNode(opts);
    this.nodes.set(node.id, node);
    this.updatedAt = new Date().toISOString();
    return node;
  }

  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    // 同时删除相关边
    this.edges = this.edges.filter(e => e.sourceId !== nodeId && e.targetId !== nodeId);
    // 清理其他节点的依赖
    for (const [, node] of this.nodes) {
      node.dependsOn = node.dependsOn.filter(id => id !== nodeId);
    }
    this.updatedAt = new Date().toISOString();
  }

  addEdge(sourceId, targetId, label = '') {
    // 更新目标节点的依赖
    const targetNode = this.nodes.get(targetId);
    if (targetNode && !targetNode.dependsOn.includes(sourceId)) {
      targetNode.dependsOn.push(sourceId);
    }
    const edge = new DAGEdge({ sourceId, targetId, label });
    this.edges.push(edge);
    this.updatedAt = new Date().toISOString();
    return edge;
  }

  removeEdge(edgeId) {
    const edge = this.edges.find(e => e.id === edgeId);
    if (edge) {
      const targetNode = this.nodes.get(edge.targetId);
      if (targetNode) {
        targetNode.dependsOn = targetNode.dependsOn.filter(id => id !== edge.sourceId);
      }
    }
    this.edges = this.edges.filter(e => e.id !== edgeId);
    this.updatedAt = new Date().toISOString();
  }

  /**
   * 拓扑排序 + 循环依赖检测
   * 返回: { sorted: [nodeId], cyclic: [nodeId] }
   */
  topologicalSort() {
    const inDegree = {};
    const adj = {};
    const allNodes = Array.from(this.nodes.keys());

    // 初始化
    for (const id of allNodes) {
      inDegree[id] = 0;
      adj[id] = [];
    }

    // 构建邻接表 + 入度
    for (const edge of this.edges) {
      if (this.nodes.has(edge.sourceId) && this.nodes.has(edge.targetId)) {
        adj[edge.sourceId].push(edge.targetId);
        inDegree[edge.targetId] = (inDegree[edge.targetId] || 0) + 1;
      }
    }

    // BFS拓扑排序
    const queue = [];
    const sorted = [];

    for (const [id, deg] of Object.entries(inDegree)) {
      if (deg === 0) queue.push(id);
    }

    while (queue.length > 0) {
      const current = queue.shift();
      sorted.push(current);

      for (const neighbor of (adj[current] || [])) {
        inDegree[neighbor]--;
        if (inDegree[neighbor] === 0) {
          queue.push(neighbor);
        }
      }
    }

    const cyclic = [];
    for (const [id, deg] of Object.entries(inDegree)) {
      if (deg > 0) cyclic.push(id);
    }

    return { sorted, cyclic, hasCycle: cyclic.length > 0 };
  }

  /**
   * 获取可执行节点（所有依赖已满足）
   */
  getReadyNodes() {
    const ready = [];
    for (const [id, node] of this.nodes) {
      if (node.status !== NodeStatus.IDLE && node.status !== NodeStatus.PENDING) continue;
      // 检查所有依赖是否已完成
      const depsReady = node.dependsOn.every(depId => {
        const depNode = this.nodes.get(depId);
        return depNode && depNode.status === NodeStatus.SUCCESS;
      });
      if (depsReady) ready.push(id);
    }
    return ready;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      nodes: Array.from(this.nodes.values()).map(n => ({
        id: n.id, type: n.type, label: n.label,
        status: n.status, dependsOn: n.dependsOn,
        position: n.position,
      })),
      edges: this.edges.map(e => ({
        id: e.id, sourceId: e.sourceId, targetId: e.targetId, label: e.label,
      })),
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

// ── 快照（断点续传） ──────────────────────────────
class DAGSnapshot {
  constructor(workflow) {
    this.workflowId = workflow.id;
    this.name = workflow.name;
    this.timestamp = new Date().toISOString();
    this.status = workflow.status;
    this.nodeStates = {};
    for (const [id, node] of workflow.nodes) {
      this.nodeStates[id] = {
        status: node.status,
        output: node.output,
        error: node.error,
        retryCount: node.retryCount,
        startedAt: node.startedAt,
        completedAt: node.completedAt,
      };
    }
  }

  /**
   * 恢复到工作流
   */
  restore(workflow) {
    workflow.status = this.status;
    for (const [id, state] of Object.entries(this.nodeStates)) {
      const node = workflow.nodes.get(id);
      if (node) {
        node.status = state.status;
        node.output = state.output;
        node.error = state.error;
        node.retryCount = state.retryCount;
        node.startedAt = state.startedAt;
        node.completedAt = state.completedAt;
      }
    }
  }
}

// ── 预设模板工厂 ─────────────────────────────────
class PresetTemplates {
  /**
   * 模板1: 注册流
   * 代理检测 → 设备启动 → 指纹注入 → 打开注册页 → 填写信息 → 验证码 → 注册成功
   */
  static registrationFlow(name = '账号注册流') {
    const dag = new DAGWorkflow({ name, description: '全自动账号注册流程' });

    const n1 = dag.addNode({ label: '代理健康检测', type: NodeType.TASK, position: { x: 200, y: 50 } });
    const n2 = dag.addNode({ label: '设备启动', type: NodeType.TASK, position: { x: 200, y: 150 } });
    const n3 = dag.addNode({ label: '指纹注入', type: NodeType.TASK, position: { x: 200, y: 250 } });
    const n4 = dag.addNode({ label: '打开注册页面', type: NodeType.TASK, position: { x: 200, y: 350 } });
    const n5 = dag.addNode({ label: '填写注册信息', type: NodeType.TASK, position: { x: 200, y: 450 } });
    const n6 = dag.addNode({ label: '获取验证码', type: NodeType.TASK, position: { x: 200, y: 550 } });
    const n7 = dag.addNode({ label: '提交验证码', type: NodeType.TASK, position: { x: 200, y: 650 } });
    const n8 = dag.addNode({ label: '注册成功确认', type: NodeType.TASK, position: { x: 200, y: 750 } });

    dag.addEdge(n1.id, n2.id);
    dag.addEdge(n2.id, n3.id);
    dag.addEdge(n3.id, n4.id);
    dag.addEdge(n4.id, n5.id);
    dag.addEdge(n5.id, n6.id);
    dag.addEdge(n6.id, n7.id);
    dag.addEdge(n7.id, n8.id);

    // SMS验证码重试（条件边）
    dag.addEdge(n6.id, n6.id, 'retry');

    return dag;
  }

  /**
   * 模板2: 养号流
   * Session恢复 → 浏览首页 → 点赞(随机) → 关注(随机) → 评论(随机) → 随机停留 → 退出
   */
  static nurturingFlow(name = '智能养号流') {
    const dag = new DAGWorkflow({ name, description: '7天渐进式养号流程' });

    const n1 = dag.addNode({ label: 'Session恢复', type: NodeType.TASK, position: { x: 200, y: 50 } });
    const n2 = dag.addNode({ label: '浏览推荐页', type: NodeType.TASK, position: { x: 200, y: 150 } });
    const n3 = dag.addNode({ label: '随机点赞(5-15)', type: NodeType.TASK, position: { x: 100, y: 250 } });
    const n4 = dag.addNode({ label: '随机关注(2-8)', type: NodeType.TASK, position: { x: 300, y: 250 } });
    const n5 = dag.addNode({ label: '随机评论(1-3)', type: NodeType.TASK, position: { x: 100, y: 350 } });
    const n6 = dag.addNode({ label: '浏览搜索页', type: NodeType.TASK, position: { x: 300, y: 350 } });
    const n7 = dag.addNode({ label: '随机停留(5-15min)', type: NodeType.WAIT, position: { x: 200, y: 450 } });
    const n8 = dag.addNode({ label: 'Session备份', type: NodeType.TASK, position: { x: 200, y: 550 } });

    dag.addEdge(n1.id, n2.id);
    dag.addEdge(n2.id, n3.id); // 并行分支1
    dag.addEdge(n2.id, n4.id); // 并行分支2
    dag.addEdge(n3.id, n5.id);
    dag.addEdge(n4.id, n6.id);
    dag.addEdge(n5.id, n7.id);
    dag.addEdge(n6.id, n7.id);
    dag.addEdge(n7.id, n8.id);

    return dag;
  }

  /**
   * 模板3: 内容发布流
   * 热点获取 → Content DNA → 内容改写 → EXIF清洗 → 图片重编码 → 发布排程 → 发布执行 → 数据追踪
   */
  static publishingFlow(name = '内容发布流') {
    const dag = new DAGWorkflow({ name, description: 'AI内容工厂→发布→追踪全流程' });

    const n1 = dag.addNode({ label: '热点话题获取', type: NodeType.TASK, position: { x: 200, y: 50 } });
    const n2 = dag.addNode({ label: 'Content DNA生成', type: NodeType.TASK, position: { x: 200, y: 150 } });
    const n3 = dag.addNode({ label: '四层内容改写', type: NodeType.TASK, position: { x: 200, y: 250 } });
    const n4 = dag.addNode({ label: 'Jaccard去重检测', type: NodeType.CONDITION, position: { x: 200, y: 350 } });
    const n5 = dag.addNode({ label: 'EXIF元数据清洗', type: NodeType.TASK, position: { x: 100, y: 450 } });
    const n6 = dag.addNode({ label: '图片重编码', type: NodeType.TASK, position: { x: 300, y: 450 } });
    const n7 = dag.addNode({ label: '最优时间计算', type: NodeType.TASK, position: { x: 200, y: 550 } });
    const n8 = dag.addNode({ label: '发布执行', type: NodeType.TASK, position: { x: 200, y: 650 } });
    const n9 = dag.addNode({ label: '数据追踪启动', type: NodeType.TASK, position: { x: 200, y: 750 } });

    dag.addEdge(n1.id, n2.id);
    dag.addEdge(n2.id, n3.id);
    dag.addEdge(n3.id, n4.id);
    dag.addEdge(n4.id, n5.id, '去重通过');
    dag.addEdge(n4.id, n6.id, '去重通过');
    dag.addEdge(n5.id, n7.id);
    dag.addEdge(n6.id, n7.id);
    dag.addEdge(n7.id, n8.id);
    dag.addEdge(n8.id, n9.id);

    return dag;
  }
}

// ── DAG 编排引擎 ─────────────────────────────────
class DAGOrchestrator extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.workflows = new Map();     // dagId → DAGWorkflow
    this.snapshots = new Map();     // workflowId → [DAGSnapshot]
    this.runningWorkflows = new Set();
    this.snapshotDir = opts.snapshotDir || path.join(process.cwd(), 'data', 'dag-snapshots');
    this.maxSnapshots = opts.maxSnapshots || 10;

    // 注册预设模板
    this.presets = {
      registration: PresetTemplates.registrationFlow,
      nurturing: PresetTemplates.nurturingFlow,
      publishing: PresetTemplates.publishingFlow,
    };

    try { mkdirSync(this.snapshotDir, { recursive: true }); } catch {}
  }

  /**
   * 创建工作流
   */
  createWorkflow(name, description = '') {
    const dag = new DAGWorkflow({ name, description });
    this.workflows.set(dag.id, dag);
    this.emit('workflowCreated', dag.toJSON());
    return dag;
  }

  /**
   * 从预设模板创建工作流
   */
  createFromPreset(presetName, customName) {
    const factory = this.presets[presetName];
    if (!factory) throw new Error(`未知预设: ${presetName}`);

    const dag = factory(customName);
    this.workflows.set(dag.id, dag);
    this.emit('workflowCreated', dag.toJSON());
    return dag;
  }

  /**
   * 获取工作流
   */
  getWorkflow(dagId) {
    return this.workflows.get(dagId) || null;
  }

  /**
   * 列出所有工作流
   */
  listWorkflows() {
    return Array.from(this.workflows.values()).map(d => ({
      id: d.id, name: d.name, description: d.description,
      status: d.status, nodeCount: d.nodes.size, edgeCount: d.edges.length,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
    }));
  }

  /**
   * 添加节点
   */
  addNode(dagId, opts) {
    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);
    const node = dag.addNode(opts);
    this.emit('nodeAdded', { dagId, node });
    return node;
  }

  /**
   * 移除节点
   */
  removeNode(dagId, nodeId) {
    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);
    dag.removeNode(nodeId);
    this.emit('nodeRemoved', { dagId, nodeId });
  }

  /**
   * 添加边
   */
  addEdge(dagId, sourceId, targetId, label = '') {
    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);
    const edge = dag.addEdge(sourceId, targetId, label);
    this.emit('edgeAdded', { dagId, edge });
    return edge;
  }

  /**
   * 验证DAG（循环依赖检测）
   */
  validate(dagId) {
    const dag = this.workflows.get(dagId);
    if (!dag) return { valid: false, error: '工作流不存在' };

    const { sorted, cyclic, hasCycle } = dag.topologicalSort();

    if (hasCycle) {
      this.emit('validationFailed', { dagId, cyclic });
      return {
        valid: false,
        error: '检测到循环依赖',
        cyclicNodes: cyclic,
      };
    }

    this.emit('validationPassed', { dagId, sorted });
    return {
      valid: true,
      executionOrder: sorted,
    };
  }

  /**
   * 执行工作流
   */
  async execute(dagId, nodeExecutors = {}) {
    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);

    // 验证
    const validation = this.validate(dagId);
    if (!validation.valid) throw new Error(validation.error);

    // 重置所有节点状态
    for (const [, node] of dag.nodes) {
      node.status = NodeStatus.IDLE;
      node.error = null;
      node.output = null;
    }

    dag.status = 'running';
    this.runningWorkflows.add(dagId);
    this.emit('executionStarted', { dagId, name: dag.name });

    try {
      const { sorted } = dag.topologicalSort();

      for (const nodeId of sorted) {
        const node = dag.nodes.get(nodeId);
        if (!node) continue;

        // 跳过已完成的节点
        if (node.status === NodeStatus.SUCCESS) continue;

        // 执行节点
        await this._executeNode(dag, node, nodeExecutors);

        // 为并行节点组同时执行
        const ready = dag.getReadyNodes();
        if (ready.length > 1) {
          const parallelResults = await Promise.allSettled(
            ready.map(id => this._executeNode(dag, dag.nodes.get(id), nodeExecutors))
          );
          // 检查并行执行结果
          for (const r of parallelResults) {
            if (r.status === 'rejected') {
              throw r.reason;
            }
          }
        }
      }

      dag.status = 'success';
      this.emit('executionCompleted', { dagId, name: dag.name });
      return { success: true, dagId, workflow: dag.toJSON() };

    } catch (e) {
      dag.status = 'failed';
      this.emit('executionFailed', { dagId, name: dag.name, error: e.message });
      return { success: false, dagId, error: e.message };
    } finally {
      this.runningWorkflows.delete(dagId);
    }
  }

  async _executeNode(dag, node, nodeExecutors) {
    if (node.status === NodeStatus.SUCCESS || node.status === NodeStatus.RUNNING) return;

    node.status = NodeStatus.RUNNING;
    node.startedAt = new Date().toISOString();
    this.emit('nodeStarted', { dagId: dag.id, nodeId: node.id, label: node.label });

    const executor = nodeExecutors[node.id] || node.executor;
    if (!executor) {
      node.status = NodeStatus.SUCCESS;
      node.completedAt = new Date().toISOString();
      this.emit('nodeCompleted', { dagId: dag.id, nodeId: node.id, status: 'skipped' });
      return;
    }

    try {
      const result = await this._runWithTimeout(
        executor(node),
        node.timeoutMs
      );
      node.status = NodeStatus.SUCCESS;
      node.output = result;
      node.completedAt = new Date().toISOString();
      this.emit('nodeCompleted', {
        dagId: dag.id, nodeId: node.id, label: node.label, output: result,
      });
    } catch (e) {
      if (node.retryCount < node.maxRetries) {
        node.retryCount++;
        node.status = NodeStatus.RETRY;
        this.emit('nodeRetrying', {
          dagId: dag.id, nodeId: node.id, label: node.label,
          attempt: node.retryCount, maxRetries: node.maxRetries, error: e.message,
        });
        await new Promise(r => setTimeout(r, node.retryDelayMs));
        return this._executeNode(dag, node, nodeExecutors);
      }

      node.status = NodeStatus.FAILED;
      node.error = e.message;
      node.completedAt = new Date().toISOString();
      this.emit('nodeFailed', { dagId: dag.id, nodeId: node.id, error: e.message });
      throw e;
    }
  }

  _runWithTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`执行超时(${timeoutMs}ms)`)), timeoutMs);
      promise.then(
        r => { clearTimeout(timer); resolve(r); },
        e => { clearTimeout(timer); reject(e); }
      );
    });
  }

  /**
   * 创建快照（断点续传）
   */
  snapshot(dagId) {
    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);

    const snap = new DAGSnapshot(dag);
    if (!this.snapshots.has(dagId)) {
      this.snapshots.set(dagId, []);
    }
    const snaps = this.snapshots.get(dagId);
    snaps.push(snap);

    // 限制快照数量
    if (snaps.length > this.maxSnapshots) {
      snaps.splice(0, snaps.length - this.maxSnapshots);
    }

    // 持久化到磁盘
    this._saveSnapshot(dagId, snap);

    this.emit('snapshotCreated', { dagId, snapshotTime: snap.timestamp, nodeCount: Object.keys(snap.nodeStates });
    return snap;
  }

  _saveSnapshot(dagId, snap) {
    try {
      const filepath = path.join(this.snapshotDir, `${dagId}_${snap.timestamp.replace(/[:.]/g, '-')}.json`);
      writeFileSync(filepath, JSON.stringify(snap, null, 2), 'utf-8');
    } catch {}
  }

  /**
   * 从快照恢复
   */
  restore(dagId, snapshotIndex = -1) {
    const snaps = this.snapshots.get(dagId);
    if (!snaps || snaps.length === 0) throw new Error(`无可用快照: ${dagId}`);

    const dag = this.workflows.get(dagId);
    if (!dag) throw new Error(`工作流不存在: ${dagId}`);

    const idx = snapshotIndex < 0 ? snaps.length + snapshotIndex : snapshotIndex;
    const snap = snaps[idx];
    if (!snap) throw new Error(`快照不存在: index=${idx}`);

    snap.restore(dag);
    this.emit('snapshotRestored', { dagId, snapshotTime: snap.timestamp });
    return dag;
  }

  /**
   * 停止所有运行中工作流
   */
  stopAll() {
    for (const dagId of this.runningWorkflows) {
      const dag = this.workflows.get(dagId);
      if (dag) {
        dag.status = 'stopped';
        for (const [, node] of dag.nodes) {
          if (node.status === NodeStatus.RUNNING) {
            node.status = NodeStatus.SKIPPED;
          }
        }
      }
    }
    this.runningWorkflows.clear();
  }
}

module.exports = {
  DAGOrchestrator,
  DAGWorkflow,
  DAGNode,
  DAGEdge,
  DAGSnapshot,
  PresetTemplates,
  NodeStatus,
  NodeType,
};
