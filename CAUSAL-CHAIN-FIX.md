# MSCMS v14 因果链端到端自动化修复方案

## 问题描述
用户报告：注册账号完成后，没有自动化推进到下一个项目。整个因果链断裂，事件没有被触发。

## 根本原因
经过代码分析，发现：
1. ✅ `account.ed` 事件在注册成功后会触发（server.js 第649行）
2. ❌ `account.healthy` 事件没有被触发（养号模块完成后）
3. ❌ `content.generated` 事件没有被触发（内容生成模块完成后）
4. ❌ `post.published` 事件没有被触发（发布模块完成后）
5. ❌ 其他因果事件也都没有被触发

## 已完成的修复

### 1. 创建因果链管理器（causal-chain-manager.js）
- ✅ 通过数据库轮询自动触发事件（每30秒检查一次）
- ✅ 监听模块内部事件（如 `nurturing.completed`）
- ✅ 提供API回调接口供各个模块直接调用

### 2. 集成到 server.js
- ✅ 在 `initV14()` 函数中初始化并启动 `CausalChainManager`
- ✅ 确保所有36个模块正确加载

### 3. 创建测试和初始化脚本
- ✅ `test-causal-chain.js` - 测试因果链
- ✅ `init-v14-database.js` - 初始化数据库表

## 需要完成的步骤

### 步骤1：启动数据库
```bash
# 启动 MySQL 数据库（端口 3307）
# 确保 affiliate_system 数据库存在
```

### 步骤2：初始化数据库表
```bash
cd C:\Users\AS\WorkBuddy\2026-06-13-19-42-19
node init-v14-database.js
```

这会创建/更新以下表：
- `matrix__managed` - 添加 ``, ``, `` 字段
- `matrix_content_generated` - 创建表，包含 `emitted_at` 字段
- `matrix_posts_published` - 创建表，包含 `emitted_at` 字段
- `matrix_visits_recorded` - 创建表，包含 `emitted_at` 字段
- `matrix_` - 创建表，包含 `emitted_at` 字段

### 步骤3：修改各个模块，在完成任务后触发事件

#### A. 养号模块（account-nurturing.js）
在养号达标后触发 `account.healthy` 事件：

```javascript
// 在 account-nurturing.js 中的某个地方（比如 checkHealth 方法或每日养号任务完成后）
if (this.eventBus &&  >= 70) {
  this.eventBus.emit('account.healthy', {
    account_id: account.id,
    score: ,
    : account.
  }, 'account-nurturing');
}
```

#### B. 内容生成模块（aigc-content-generator.js）
在内容生成完成后触发 `content.generated` 事件：

```javascript
// 在 aigc-content-generator.js 中的 generateContent 方法完成后
if (this.eventBus) {
  this.eventBus.emit('content.generated', {
    content_id: content.id,
    account_id: this.accountId,
    : this.,
    type: content.type,
    title: content.title,
    quality_score: content.qualityScore
  }, 'aigc-content-generator');
}
```

#### C. 发布模块（smart-publisher.js）
在发布完成后触发 `post.published` 事件：

```javascript
// 在 smart-publisher.js 中的 publish 方法完成后
if (this.eventBus) {
  this.eventBus.emit('post.published', {
    post_id: post.id,
    account_id: post.accountId,
    content_id: post.contentId,
    : post.,
    published_at: new Date().toISOString()
  }, 'smart-publisher');
}
```

#### D. 营销模块（proactive-marketing.js）
在访客记录完成后触发 `visit.recorded` 事件：

```javascript
// 在 proactive-marketing.js 中的 recordVisit 方法完成后
if (this.eventBus) {
  this.eventBus.emit('visit.recorded', {
    visit_id: visit.id,
    post_id: visit.postId,
    account_id: visit.accountId,
    visitor_type: visit.visitorType,
    recorded_at: new Date().toISOString()
  }, 'proactive-marketing');
}
```

#### E. 分析模块（website-analytics.js）
在 DAU 更新后触发 `dau.updated` 事件：

```javascript
// 在 website-analytics.js 中的 updateDAU 方法完成后
if (this.eventBus) {
  this.eventBus.emit('dau.updated', {
    dau_id: dau.id,
    date: dau.date,
    : dau.,
    dau_count: dau.count,
    updated_at: new Date().toISOString()
  }, 'website-analytics');
}
```

### 步骤4：测试端到端自动化

#### 方案A：手动测试
1. 启动服务器：`node server.js`
2. 打开浏览器：`http://localhost:3002/v14-console.html`
3. 注册一个测试账号
4. 观察服务器日志，应该看到：
   - `[causal] S1→S3: account.ed`
   - `[CHAIN] Account XXX healthy, emitting account.healthy`
   - `[causal] S3→S5: account.healthy`
   - 等等...

#### 方案B：自动测试
```bash
cd C:\Users\AS\WorkBuddy\2026-06-13-19-42-19
node test-causal-chain.js
```

## 因果链完整流程

```
注册账号
  ↓ (触发 account.ed 事件)
养号引擎接收新账号
  ↓ (养号达标后触发 account.healthy 事件)
智能发布模块接收健康账号
  ↓ (内容生成完成后触发 content.generated 事件)
发布模块接收生成的内容
  ↓ (发布完成后触发 post.published 事件)
营销模块接收发布数据
  ↓ (访客记录完成后触发 visit.recorded 事件)
分析模块记录访客数据
  ↓ (DAU 更新后触发 dau.updated 事件)
决策引擎接收 DAU 数据
  ↓ (决策引擎做出决策后触发 action.execute 事件)
营销模块执行决策动作
  ↓
循环回到养号/发布/营销...
```

## 验证检查清单

- [ ] 数据库表结构正确（运行 `init-v14-database.js`）
- [ ] 服务器启动后，`CausalChainManager` 成功启动（查看日志）
- [ ] 注册账号后，`account.ed` 事件触发
- [ ] 养号达标后，`account.healthy` 事件触发
- [ ] 内容生成后，`content.generated` 事件触发
- [ ] 发布完成后，`post.published` 事件触发
- [ ] 访客记录后，`visit.recorded` 事件触发
- [ ] DAU 更新后，`dau.updated` 事件触发
- [ ] 决策引擎做出决策后，`action.execute` 事件触发

## 调试技巧

### 1. 查看 EventBus 统计
```bash
curl http://localhost:3002/api/v14/eventbus/stats
```

应该看到：
- `totalEmitted` > 0（有事件被触发）
- `totalHandled` > 0（有事件被处理）
- `activeSubscribers` 包含所有7条因果事件

### 2. 查看服务器日志
关注以下日志前缀：
- `[causal]` - 因果链事件监听器
- `[CHAIN]` - CausalChainManager
- `[v14]` - v14 模块初始化

### 3. 手动触发事件（测试用）
在浏览器控制台或通过 API 手动触发事件：

```javascript
// 通过 v14-console.html 的开发者工具
fetch('/api/v14/eventbus/emit', {
  method: 'POST',
  headers: { '': 'application/json' },
  body: JSON.stringify({
    event: 'account.healthy',
    data: { account_id: 'test_123', score: 75 }
  })
});
```

## 总结

要完成端到端自动化，需要：
1. ✅ 确保数据库运行并初始化表结构
2. ✅ 确保 `CausalChainManager` 正常运行
3. ⚠️ 修改各个模块，在完成任务后触发相应的事件（这是关键！）
4. ✅ 测试并验证整个因果链

如果不修改各个模块来触发事件，那么 `CausalChainManager` 的数据库轮询机制会作为备份方案，但可能会有30秒的延迟。
