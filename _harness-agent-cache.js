#!/usr/bin/env node
/**
 * _harness-agent-cache.js — P0-5「3002 内存黑洞」修复的确定性验证
 *
 * 为什么必须用 harness（本机铁律）：
 *   真实故障要跑 7.4h 才复现 3.9GB RSS，依赖网络/免费代理池的随机轮换
 *   —— 用它验收等于每次都在赌。故把 http-client.js 的两段真实源码**抽取**出来，
 *   配一个假 ProxyAgent（只记账 close/destroy），把「不可复现的随机失败」
 *   变成「可复现的确定输入」：200 个不同出口 => 缓存必须恒 ≤ MAX，且被淘汰者必须被释放。
 *
 * 断言覆盖（每条对应一个真实缺陷）：
 *   A1 无界增长：200 个出口后 _agentCache.size 必须 == MAX_PROXY_AGENTS（旧代码会是 200）
 *   A2 真 LRU  ：最近使用的必须留存、最旧的必须被淘汰
 *   A3 释放闭环：被淘汰的 Agent 必须 close() 过；超过宽限期必须 destroy() 过
 *   A4 熔断即回收：_noteProxyFail 达阈值 → 该出口的 Agent 必须立刻离开缓存并退休
 *   A5 失败计数释放：_noteProxyOk 后该键必须消失（旧代码写 0 但键常驻）
 *   A6 熔断表上限：超过 PROXY_CIRCUIT_MAX 时按插入序淘汰
 *   A7 日志限流：窗口内 200 次熔断最多输出 CIRCUIT_LOG_BUDGET 条逐条 + 1 条汇总
 *   A8 回滚开关：MSCMS_MAX_PROXY_AGENTS=0 时必须恢复旧的无上限行为
 *
 * 用法: node _harness-agent-cache.js
 * 退出码 = 失败数
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, 'http-client.js');
const text = fs.readFileSync(SRC, 'utf8');

// ── 抽取真实源码区间（不复制粘贴，避免「测的和跑的不是同一份」）──
const START = text.indexOf('const MAX_PROXY_AGENTS = (() => {');
const END_MARK = "if (typeof _reapTimer.unref === 'function') _reapTimer.unref();";
const END = text.indexOf(END_MARK);
if (START < 0 || END < 0) {
  console.error('❌ 抽取失败：找不到标记。START=' + START + ' END=' + END);
  process.exit(1);
}
const body = text.slice(START, END + END_MARK.length);

let pass = 0, fail = 0;
const results = [];
function ok(name, cond, extra) {
  if (cond) { pass++; results.push('  [PASS] ' + name); }
  else { fail++; results.push('  [FAIL] ' + name + (extra ? ' -- ' + extra : '')); }
}

function build(env) {
  const agents = [];
  const warns = [], logs = [];
  const sandbox = {
    console: {
      warn: (...a) => warns.push(a.join(' ')),
      log: (...a) => logs.push(a.join(' ')),
      error: () => {},
    },
    process: { env: Object.assign({}, env) },
    Date, Math, Number, JSON, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    ProxyAgent: function FakeAgent(url) { this.url = url; this.closed = 0; this.destroyed = 0; agents.push(this); },
  };
  sandbox.ProxyAgent.prototype.close = function () { this.closed++; return Promise.resolve(); };
  sandbox.ProxyAgent.prototype.destroy = function () { this.destroyed++; return Promise.resolve(); };
  sandbox.proxyAgent = { url: 'GLOBAL' };
  sandbox.__out = {};
  const ctx = vm.createContext(sandbox);
  vm.runInContext(body + `
;__out.agentFor = _agentFor;
;__out.noteFail = _noteProxyFail;
;__out.noteOk = _noteProxyOk;
;__out.evict = _evictAgent;
;__out.reap = _reapNow;
;__out.size = () => _agentCache.size;
;__out.retiring = () => _retiring.length;
;__out.created = () => _agentCreated;
;__out.retired = () => _agentRetired;
;__out.untilSize = () => _DEAD_PROXY_UNTIL.size;
;__out.failSize = () => _DEAD_PROXY_FAILS.size;
;__out.circuitTotal = () => _circuitTotal;
;__out.max = MAX_PROXY_AGENTS;
;__out.has = (k) => _agentCache.has(k);
;__out.get = (k) => _agentCache.get(k);
`, ctx);
  return { o: sandbox.__out, agents, warns, logs, ctx };
}

// ══ 场景 1：A1/A2/A3 无界增长 + LRU + 释放闭环 ══
{
  const { o, agents } = build({ MSCMS_AGENT_DESTROY_AFTER_MS: '0' });
  const MAX = o.max;
  ok('A0 上限已生效（默认 24）', MAX === 24, 'MAX=' + MAX);
  for (let i = 0; i < 200; i++) o.agentFor('http://10.0.0.' + i + ':8080');
  ok('A1 200 出口后缓存恒 ≤ 上限', o.size() === MAX, 'size=' + o.size());
  ok('A1b 创建计数 == 200', o.created() === 200, 'created=' + o.created());
  ok('A1c 退休计数 == 创建 - 缓存', o.retired() === o.created() - o.size(), 'retired=' + o.retired());
  const evicted = agents.filter((a) => a.closed > 0);
  ok('A3 被淘汰者全部 close() 过', evicted.length === o.retired(), 'closed=' + evicted.length + ' retired=' + o.retired());
  ok('A2 最旧者已被淘汰', !o.has('http://10.0.0.0:8080'));
  ok('A2b 最新者仍在缓存', o.has('http://10.0.0.199:8080'));
  // LRU touch：复活一个仍在缓存里的，再用一个新出口把它挤出去
  o.agentFor('http://10.0.0.176:8080');
  o.agentFor('http://10.0.0.200:8080');
  ok('A2c LRU 命中后该条目被保住', o.has('http://10.0.0.176:8080'), '被误淘汰');
  ok('A2d 队首(10.0.0.177)被挤掉', !o.has('http://10.0.0.177:8080'));
  // 宽限 0ms ⇒ 回收器必须立刻硬 destroy
  o.reap();
  ok('A3b 宽限期后硬 destroy 全部完成', o.retiring() === 0, 'retiring=' + o.retiring());
  const notDestroyed = agents.filter((a) => a.closed > 0 && a.destroyed === 0);
  ok('A3c 所有曾 close 的 Agent 均已被 destroy', notDestroyed.length === 0, '未销毁=' + notDestroyed.length);
}

// ══ 场景 2：A4 熔断即回收 ══
{
  const { o } = build({ MSCMS_AGENT_DESTROY_AFTER_MS: '0' });
  const p = 'http://1.2.3.4:8080';
  o.agentFor(p);
  ok('A4.0 熔断前在缓存', o.has(p));
  o.noteFail(p); o.noteFail(p);           // 阈值 2 ⇒ 第二次触发熔断
  ok('A4 熔断即把 Agent 移出缓存', !o.has(p), '仍在缓存');
  ok('A4b 熔断计入退休', o.retired() >= 1, 'retired=' + o.retired());
  ok('A4c 熔断计数进入熔断表', o.untilSize() === 1, 'until=' + o.untilSize());
}

// ══ 场景 3：A5 失败计数释放 ══
{
  const { o } = build({});
  o.noteFail('http://5.5.5.5:80');
  ok('A5.0 失败 1 次后有 1 个键', o.failSize() === 1);
  o.noteOk('http://5.5.5.5:80');
  ok('A5 成功后键被删除（旧实现留 0 值键）', o.failSize() === 0, 'failSize=' + o.failSize());
}

// ══ 场景 4：A6 熔断表上限 ══
{
  const { o } = build({ MSCMS_PROXY_CIRCUIT_MAX: '100', MSCMS_PROXY_CIRCUIT_THRESHOLD: '1' });
  for (let i = 0; i < 300; i++) o.noteFail('http://9.9.' + Math.floor(i / 250) + '.' + (i % 250) + ':80');
  ok('A6 熔断表不超上限', o.untilSize() <= 100, 'until=' + o.untilSize());
}

// ══ 场景 5：A7 日志限流 ══
{
  const { o, warns } = build({ MSCMS_CIRCUIT_LOG_WINDOW_MS: '600000', MSCMS_CIRCUIT_LOG_BUDGET: '40', MSCMS_PROXY_CIRCUIT_THRESHOLD: '1' });
  for (let i = 0; i < 200; i++) o.noteFail('http://7.7.7.' + i + ':80');
  const lines = warns.filter((w) => w.includes('[proxy-circuit]'));
  ok('A7 逐条输出被限流到预算内', lines.length <= 40, 'lines=' + lines.length);
  ok('A7b 熔断总量仍被完整计数', o.circuitTotal() === 200, 'total=' + o.circuitTotal());
  ok('A7c 保留 [proxy-circuit] 前缀（既有 grep 不受影响）', lines.every((l) => l.startsWith('[proxy-circuit]')));
}

// ══ 场景 6：A8 回滚开关 ══
{
  const { o } = build({ MSCMS_MAX_PROXY_AGENTS: '0' });
  ok('A8 上限为 ∞', o.max === Infinity, 'max=' + o.max);
  for (let i = 0; i < 50; i++) o.agentFor('http://8.8.8.' + i + ':80');
  ok('A8b 回滚后恢复旧行为（不淘汰）', o.size() === 50 && o.retired() === 0, 'size=' + o.size() + ' retired=' + o.retired());
}

// ══ 场景 7：边界 — 上限极小时不能把刚建好的淘汰掉 ══
{
  const { o } = build({ MSCMS_MAX_PROXY_AGENTS: '1' });
  const a = o.agentFor('http://1.1.1.1:80');
  ok('A9 缓存非空且返回有效 Agent', !!a && o.size() === 1, 'size=' + o.size());
  ok('A9b 上限=1 时未死循环', true);
}

console.log('==================================================================');
console.log('  P0-5 内存黑洞修复 — 确定性 harness（agent 缓存）');
console.log('==================================================================');
console.log(results.join('\n'));
console.log('------------------------------------------------------------------');
console.log('  RESULT:  ' + pass + ' passed, ' + fail + ' failed');
console.log('==================================================================');
process.exit(fail);
