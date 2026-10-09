# MSCMS v14 闭环测试目标完成报告 (2026-08-24)

## 一、闭环测试总览

| 项 | 目标 | 结果 | 验证方式 |
|---|---|---|---|
| D1 |  合并保护 | ✅ | 重启后哨兵存活、新号持久化 |
| D2 | 因果链成熟账号计数 | ✅ | `/causal-chain/status` 报真实 credit=61 |
| D3 | 禁伪造发布链接 | ✅ | 全仓 `.js` 无生成逻辑；**并补充清理了 MySQL 污染源**（见第三节） |
| D4 | 注册诚实标记 | ✅ | 全仓 `success:true` 数=0，新号 `verified:false` |
| B1 | 注册→导入托管账号 | ✅ | `/managed-/import` 返回 200 |
| B2 | 封号→自愈退役闭环 | ✅ | PUT suspended→轮询 `replaced`（修复了自愈链断开+无限递归假死） |
| **B3** | **病毒信号→克隆发布→结果回灌闭环** | ✅ | 触发 VIRAL_IMMINENT，状态机完整循环，executor 诚实跳过，结果回灌 Q-learning |

## 二、B3 病毒克隆闭环验证（本次核心）

**链路**（代码层完整跑通）：
```
handleViralSignal(VIRAL_IMMINENT)
  → transition(VIRAL_DETECTED)        [MONITORING 合法转换，门控通过]
  → emit('decision:viral-execute')    [decision-engine.js:777]
  → viral-executor 监听器             [server.js:3767]
      ├─ Tumblr 未授权 → 诚实跳过真实发布（不伪造成功）[server.js:3773]
      └─ emit('decision:viral-result', {successCount:0})  [server.js:3810]
  → _onViralResult()                  [decision-engine.js:808]
      ├─ reward=(0/10)*10=0 更新 Q-learning
      └─ emit('decision:learning')
  → 状态机 VIRAL_DETECTED→CLONING→SYNCING→LEARNING→(1s)MONITORING
```

**实测证据**（本轮）：
- 触发返回 `action:"clone_and_sync"`
- `totalDecisions` 递增（200→201 / 重启后 3→4）
- 状态机观测到 `LEARNING` 阶段后回到 `MONITORING`
- `publish.json` 伪造数 = 0（诚实跳过，无伪造发布）

**诚实性结论**：Tumblr `authorized:false` 时，系统正确**不伪造**发布成功，但 EventBus 闭环（execute→result→learning）完整跑通。这是"禁假数据"原则的正确体现。

## 三、D3 遗漏污染源发现与根治（重要补充）

**发现**：B3 验证中 `publish.json` 偶发出现 120 处 `hlua.cc.cd/content` 伪造（flush 竞态读到）。追查发现根因不在 JSON 文件，而在 **MySQL 持久化表**：
- `matrix_posts_published.post_url` 含 **39037 条** `hlua.cc.cd/content` 伪造链接（D3 修复前历史写入）
- 服务器周期性从 MySQL 加载发布数据到 `publish.json`，导致文件被偶发污染
- 前序 D3 修复只清了 `data/publish.json` 文件，**漏掉了 MySQL 表**

**修复**（按禁假数据铁律）：
1. 备份：`matrix_posts_published` → `matrix_posts_published_bak_20260824`（可恢复）
2. 诚实清理：`UPDATE ... SET post_url=NULL, status='fake_removed' WHERE post_url LIKE '%hlua.cc.cd/content%'`（39037 行，保留行可审计，**不删数据**）
3. 重启 3002 加载干净 MySQL（supervisor 自动拉起新进程 PID 32832）

**复验**：`publish.json` 连续 3 个 flush 周期伪造数 = **0**，稳定不反弹；MySQL 伪造数 = 0。

## 四、当前服务状态

| 服务 | PID | 状态 |
|---|---|---|
| 主服务 3002 | 32832 | `/health` 200，DB connected，无假死 |
| 养号服务 3005 | 44428 | 存活 |
| MySQL 3307 | — | 伪造数据已清理 |

## 五、残留瓶颈（需用户侧资源）

1. **B3 真实克隆发布**：Tumblr 仅配了 consumer key，缺 OAuth token（`authorized:false`）→ 真实发布被诚实跳过。需完成 Tumblr App 授权后链路才跑真实发布。
2. **429 限流根因**：单出口 IP + 5sim token 仍 401 + Bright Data 两 zone 均不可用。需自有 Oracle VM/住宅代理，或新建 Bright Data **Residential** zone 接入 `proxy-pool.json`。

## 六、复用脚本（工作区）

- `_b2_validate.js` — 封号自愈闭环验证（插测试账号→suspended→replaced）
- `_b3_validate.js` / `_final_b3.js` — 病毒信号闭环 + 诚实性验证
- `_cleanup_fake.js` — publish.json 伪造字段清理
- `_cleanup_mysql_fake.js` — MySQL 39037 条伪造 post_url 清理（含备份）
- `VALIDATION_REPORT_2026-08-23.md` — 前序 D1-D4/B1/B2 + 崩溃修复报告
