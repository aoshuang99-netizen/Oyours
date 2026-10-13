#!/usr/bin/env node
'use strict';
/**
 * _queue_persist_verify.js —— 确定性 harness：验证 publishQueue 落盘/恢复（P0-Q1）
 *
 * 为什么用 harness：真实运行里「重启丢队列」依赖进程崩溃时机，无法复现。
 * 这里用临时 dataDir 构造**确定的输入快照**，秒级断言全部分支。
 *
 * 覆盖分支：
 *   A 未来 deferred        ⇒ 必须恢复
 *   B 无 scheduledAt       ⇒ 不恢复（交给 _recoverStaleQueued）
 *   C 已在 publish.json    ⇒ 不恢复（防重复外发）
 *   D 缺 content/account   ⇒ 不恢复
 *   E scheduledAt 已过期   ⇒ 恢复（且不会被推迟到未来）
 *   对照：删掉 publish.json 台账后 C 应变为「恢复」⇒ 证明防护真的在起作用
 *   round-trip：_persistQueue 写出的文件能被 _restoreQueue 读回
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// 必须在 require 之前隔离数据目录：cloud-publisher 的 DEADLIST_FILE 是模块级常量，
// 在 require 时按 MSCMS_DATA_DIR 求值；不隔离就会触碰真实 D:/mscms-ws/data 的黑名单。
process.env.MSCMS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qroot-'));
const { DataStore } = require('./data-store.js');
const { CloudPublisher } = require('./cloud-publisher.js');

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('  ✅ ' + msg); } else { fail++; console.log('  ❌ ' + msg); } };

function buildFixture(withLedger = true) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qtest-'));
  fs.writeFileSync(path.join(tmp, 'content.json'), JSON.stringify([
    { id: 'c_ok', platform: 'tumblr', body: 'hello', status: 'queued' },
    { id: 'c_done', platform: 'tumblr', body: 'world', status: 'queued' },
  ]));
  fs.writeFileSync(path.join(tmp, 'accounts.json'), JSON.stringify([
    { id: 'a1', platform: 'tumblr', status: 'active' },
    { id: 'a2', platform: 'tumblr', status: 'active' },
  ]));
  fs.writeFileSync(path.join(tmp, 'publish.json'), JSON.stringify(withLedger ? [
    { id: 'pub_' + (Date.now() - 3600e3) + '_deadbeef', account_id: 'a2', content_id: 'c_done', publish_url: 'https://example.tumblr.com/post/1' },
  ] : []));
  const future = new Date(Date.now() + 3600e3).toISOString();
  const past = new Date(Date.now() - 600e3).toISOString();
  fs.writeFileSync(path.join(tmp, 'publish_queue.json'), JSON.stringify({
    savedAt: new Date().toISOString(),
    count: 5,
    items: [
      { id: 't_A', content: { id: 'c_ok' }, account: { id: 'a1' }, platform: 'tumblr', scheduledAt: future, status: 'pending', quotaDeferCount: 2 },
      { id: 't_B', content: { id: 'c_ok' }, account: { id: 'a1' }, platform: 'tumblr', scheduledAt: null, status: 'pending' },
      { id: 't_C', content: { id: 'c_done' }, account: { id: 'a2' }, platform: 'tumblr', scheduledAt: future, status: 'pending' },
      { id: 't_D', content: null, account: null, platform: 'tumblr', scheduledAt: future, status: 'pending' },
      { id: 't_E', content: { id: 'c_done' }, account: { id: 'a1' }, platform: 'tumblr', scheduledAt: past, status: 'pending' },
    ],
  }));
  return tmp;
}

function restoreWith(tmp) {
  const ds = new DataStore(tmp);
  const cp = new CloudPublisher({ dataStore: ds });
  const n = cp._restoreQueue();
  return { cp, ds, n };
}

console.log('=== ① 有台账（正常场景）===');
{
  const tmp = buildFixture(true);
  const { cp, n } = restoreWith(tmp);
  const ids = cp.publishQueue.map((t) => t.id).sort();
  console.log('  恢复条数 =', n, ' ids =', ids.join(','));
  ok(ids.includes('t_A'), 'A 未来 deferred ⇒ 恢复 ✅');
  ok(!ids.includes('t_B'), 'B 无 scheduledAt ⇒ 不恢复 ✅');
  ok(!ids.includes('t_C'), 'C 已在 publish.json 台账 ⇒ 不恢复（防重复外发）✅');
  ok(!ids.includes('t_D'), 'D 缺 content/account ⇒ 不恢复 ✅');
  ok(ids.includes('t_E'), 'E scheduledAt 已过期 ⇒ 恢复 ✅');
  ok(n === 2, `只恢复 2 条（实际 ${n}）✅`);
  const tA = cp.publishQueue.find((t) => t.id === 't_A');
  ok(tA && tA.quotaDeferCount === 2, 'A 的 quotaDeferCount 保留 ✅');
  ok(tA && tA.content && tA.content.body === 'hello', 'A 的 content 从 dataStore 重新取（含 body）✅');
  const tE = cp.publishQueue.find((t) => t.id === 't_E');
  ok(tE && Date.parse(tE.scheduledAt) <= Date.now(), 'E 的 scheduledAt 未被推迟到未来 ✅');
  ok(!!(tE && tE.restoredAt), 'E 带 restoredAt 标记 ✅');
}

console.log('\n=== ② 对照：无台账 ⇒ C 应变为「恢复」（证明防护真的在起作用）===');
{
  const tmp = buildFixture(false);
  const { cp, n } = restoreWith(tmp);
  const ids = cp.publishQueue.map((t) => t.id).sort();
  console.log('  恢复条数 =', n, ' ids =', ids.join(','));
  ok(ids.includes('t_C'), 'C 在无台账时被恢复 ⇒ 台账防护是有效条件（非恒真）✅');
  ok(n === 3, `恢复 3 条（实际 ${n}）✅`);
}

console.log('\n=== ③ round-trip：_persistQueue 写出的快照能被 _restoreQueue 读回 ===');
{
  const tmp = buildFixture(true);
  const ds = new DataStore(tmp);
  const cp = new CloudPublisher({ dataStore: ds });
  cp.publishQueue.push({
    id: 't_rt', content: { id: 'c_ok' }, account: { id: 'a1' }, platform: 'tumblr',
    scheduledAt: new Date(Date.now() + 7200e3).toISOString(), status: 'pending',
    retryCount: 1, maxRetries: 3, quotaDeferCount: 5, publishNote: 'n',
  });
  cp._persistQueue();
  const written = JSON.parse(fs.readFileSync(path.join(tmp, 'publish_queue.json'), 'utf8'));
  console.log('  写出 count =', written.count, ' savedAt =', written.savedAt);
  ok(written.count === 1 && written.items[0].id === 't_rt', '落盘内容正确 ✅');
  ok(written.items[0].quotaDeferCount === 5 && written.items[0].retryCount === 1, '关键字段完整 ✅');
  // 用第二个实例读回
  const cp2 = new CloudPublisher({ dataStore: ds });
  cp2._restoreQueue();
  ok(cp2.publishQueue.length === 1 && cp2.publishQueue[0].id === 't_rt', '读回一致 ✅');
}

console.log('\n=== ④ 边界：文件不存在 / 内容损坏 不应抛错 ===');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qtest2-'));
  const ds = new DataStore(tmp);
  const cp = new CloudPublisher({ dataStore: ds });
  let threw = false;
  try { ok(cp._restoreQueue() === 0, '快照缺失 ⇒ 返回 0 不抛错 ✅'); } catch (e) { threw = true; }
  fs.writeFileSync(path.join(tmp, 'publish_queue.json'), '{ broken json');
  try { ok(cp._restoreQueue() === 0, 'JSON 损坏 ⇒ 返回 0 不抛错 ✅'); } catch (e) { threw = true; console.log('  ❌ 损坏快照抛错:', e.message); fail++; }
  try { cp._persistQueue(); ok(true, '_persistQueue 可正常写出 ✅'); } catch (e) { console.log('  ❌ persist 抛错:', e.message); fail++; }
}

console.log(`\n=== 汇总：PASS ${pass} / FAIL ${fail} ===`);
process.exit(fail ? 1 : 0);
