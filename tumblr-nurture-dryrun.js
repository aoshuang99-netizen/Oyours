'use strict';
/**
 * tumblr-nurture-dryrun.js — 2 账号 P0+P1 真实 API 验证（dry-run，不启动循环）
 *
 * 目的：在铺开 16 号之前，确认真实 Tumblr API 调用返回 200（而非伪造），
 * 覆盖：P0 资料完善(editBlog) + P1 观察期(dashboard 浏览 + 给小博主点赞)。
 *
 * 用法：
 *   node tumblr-nurture-dryrun.js                       # 默认取前 2 个「已授权」tumblr 账号
 *   node tumblr-nurture-dryrun.js tumblr_xxx tumblr_yyy # 指定 2 个账号
 */

const path = require('path');
const WS = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19';

async  main() {
  const args = process.argv.slice(2);
  const { DataStore } = require('./data-store.js');
  const { TumblrPublisher } = require('./tumblr-publisher.js');
  const { TumblrNurtureEngine } = require('./tumblr-nurture.js');

  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const dataStore = new DataStore(path.join(WS, 'data'));
  const publisher = new TumblrPublisher(dataStore);
  const engine = new TumblrNurtureEngine({ dataStore, publisher });
  engine.load();

  let targets = args.filter(a => a.startsWith('tumblr_'));
  if (!targets.length) {
    const toks = dataStore.list('', { limit: 100 }).items.filter(t => t.oauthToken);
    targets = toks.slice(0, 2).map(t => t.id);
  }
  if (!targets.length) { console.log('❌ 没有已授权账号可 dry-run'); process.exit(1); }

  console.log(`\n=== DRY-RUN P0+P1 for ${targets.length} : ${targets.join(', ')} ===\n`);

  for (const id of targets) {
    console.log(`──────── ${id} ────────`);
    // 确保 persona + state 存在
    engine._ensurePersona({ id });
    if (!engine.states.get(id)) engine._initState(id);

    // P0: 资料完善
    console.log('[P0] 资料完善 (editBlog title/description)...');
    const p0 = await engine.runPhaseNow(id, 'P0');
    console.log('   →', JSON.stringify(p0));

    // P1: 观察期（dashboard 浏览 + 点赞小博主）
    console.log('[P1] 观察期 (dashboard 浏览 + 点赞小博主)...');
    const p1 = await engine.runPhaseNow(id, 'P1', { likes: 3 });
    console.log('   →', JSON.stringify(p1));

    const st = engine.states.get(id);
    console.log(`   状态: phase=${st.phase} totalActions=${st.totalActions} today=${JSON.stringify(st.daily[engine._todayKey()] || {})} lastApi=${JSON.stringify(st.lastApi)}`);
    console.log('');
  }
  console.log('=== DRY-RUN 完成（已执行真实 API 调用，未启动循环）===');
  process.exit(0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
