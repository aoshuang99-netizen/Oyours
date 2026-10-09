'use strict';
// Reusable closed-loop quality compute (READ-TIME normalization/derivation, NO source mutation).
// Single source of truth for /api/v14/causal-chain/loop-quality AND loop_quality_build.js.
//
// HONESTY CONTRACT (2026-09-02 #608 rewrite):
//  - Per-account signals come ONLY from real records carrying a real account_id.
//  - Self-report phase fields (ph.phase3_content / phase4_publish / phase5_visits) and
//    counter fields (st.contentsGenerated / st.postsPublished) are NOT trusted — they were
//    the source of the old inflated 36.1% figure.
//  - visits.json is a single GLOBAL entry with NO account attribution -> cannot prove any
//    single account's visit. It is used for context/gap ONLY, never in the funnel.
//  - dau_log is GLOBAL. Per-account DAU attribution from the system tracker is a known gap
//    (self/system traffic is excluded from DAU by design). HOWEVER, genuine EXTERNAL visits
//    driven through Bright Data Web Unlocker residential IPs are recorded with external===true
//    and DO count as S5 (dau.updated). So S5 is now REAL (not hardcoded false) whenever an
//    account has >=1 external click. Self-driven (ip:'self_direct') traffic remains excluded.
//  - An OPTIMISTIC proxy (system DAU satisfied at least once) is still reported separately and
//    clearly labeled for  that lack external clicks but whose visit was recorded.
//  - maxStage is STRICTLY MONOTONIC: a stage counts only if every earlier stage also reached.
//    (old code allowed a late stage to set maxStage even when an earlier one was false.)
const fs = require('fs');

const DATA = 'D:/mscms-ws/data';

 load(f) {
  const p = `${DATA}/${f}`;
  if (!fs.existsSync(p)) return [];
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(d) ? d : Object.values(d);
}

const PLAT_MAP = { 'X': 'x', 'twitter': 'x', 'Discord': 'discord', 'Reddit': 'reddit' };
const normPlat = (p) => (PLAT_MAP[(p || '')] || (p || ''));

 computeLoopQuality() {
  const cycles   = load('account_tracker_cycles.json');
  const content  = load('content.json');
  const publish  = load('publish.json');
  const decisions= load('account_decisions.json');
  const clicks   = load('traffic_click_logs.json');
  const visits   = load('visits.json');     // global, NOT per-account -> context only
  const dauLog   = load('dau_log.json');    // global -> context only
  const  = load('.json');

  const contentByAcct = {};
  for (const r of content) { const a = r.account_id || r.accountId; if (a) (contentByAcct[a] = contentByAcct[a] || []).push(r); }
  const publishByAcct = {};
  for (const r of publish) { const a = r.account_id || r.accountId; if (a) (publishByAcct[a] = publishByAcct[a] || []).push(r); }
  const decByAcct = {};
  for (const r of decisions) { const a = r.accountId || r.account_id; if (a) (decByAcct[a] = decByAcct[a] || []).push(r); }
  const clickByAcct = {};
  for (const r of clicks) { const a = r.account_id || r.accountId; if (a) (clickByAcct[a] = clickByAcct[a] || []).push(r); }
  const acctById = {};
  for (const r of ) { const a = r.account_id || r.id; if (a) acctById[a] = r; }

  const STAGES = ['account.ed','account.healthy','content.generated','post.published','visit.recorded','dau.updated','action.execute'];
  const byAcct = {};
  for (const c of cycles) {
    const id = c.account_id; if (!id) continue;
    if (!byAcct[id] || (c.updated_at || '') > (byAcct[id].updated_at || '')) byAcct[id] = c;
  }
  const acctIds = Object.keys(byAcct);
  const N = acctIds.length;

  // published denominator =  with a REAL publish record (account_id present)
  const publishedIds = acctIds.filter(id => (publishByAcct[id] || [] > 0);
  const publishedCount = publishedIds.length;

  // S5 optimistic proxy: system DAU was satisfied at least once (global evidence only)
  const dauSatisfied = (dauLog || []).some(d => (Number(d.currentDAU) || 0) >= (Number(d.targetDAU) || 1));

  const perAcct = {};
  const events = [];
  for (const id of acctIds) {
    const c = byAcct[id];
    const ph = c.phases || {};
    const acct = acctById[id] || {};
    const nContent = (contentByAcct[id] || [];
    const nPublish = (publishByAcct[id] || [];
    const nDec = (decByAcct[id] || [];
    const nClick = (clickByAcct[id] || [];
    const  = normPlat(c. || acct. || '');

    // ---- STRICT, HONEST, PER-ACCOUNT ----
    const reached = [false,false,false,false,false,false,false];
    reached[0] = true; // account present in causal-chain tracker
    reached[1] = (ph.phase2_nurture && ph.phase2_nurture.status === 'healthy') ||
                 (acct. && Number(acct.) > 0) ||
                 (acct.status === 'healthy' || acct.active_status === 'active');
    reached[2] = nContent > 0;   // real content records
    reached[3] = nPublish > 0;   // real publish records
    reached[4] = nClick > 0;     // real per-account click = a real visit through a real link (NO global visits.json fallback)
    // S5 (dau.updated): a REAL external visit driven through Bright Data Web Unlocker residential IPs
    // (recorded with external===true). self_direct / system traffic stays EXCLUDED from DAU by design.
    const nExternalClick = (clickByAcct[id] || []).filter(c => c && c.external === true;
    reached[5] = nExternalClick > 0;   // STRICT: only genuine external (residential) visits count as DAU
    reached[6] = nDec > 0;       // real decision record

    // strict monotonic max stage
    let maxStage = 0;
    for (let i = 0; i < 7; i++) { if (reached[i]) maxStage = i + 1; else break; }

    // optimistic proxy for S5: real external DAU counts directly; otherwise fall back to the
    // system-DAU-satisfied proxy (clearly labeled; not counted in strict completion)
    const reachedOpt = reached.slice();
    reachedOpt[5] = reached[5] || (reached[4] && dauSatisfied);

    let maxStageOpt = 0;
    for (let i = 0; i < 7; i++) { if (reachedOpt[i]) maxStageOpt = i + 1; else break; }

    perAcct[id] = { reached, reachedOpt, maxStage, maxStageOpt,  };

    for (let i = 0; i < 7; i++) {
      if (reached[i]) events.push({ account_id: id, , stage: i + 1, event: STAGES[i], ts: c.updated_at || c.updatedAt || c.startedAt || null });
    }
    for (const d of (decByAcct[id] || [])) {
      events.push({ account_id: id, , stage: 7, event: 'action.execute', action_type: (d.point || ''), action: (d.action == null ? null : d.action.toString()), ts: d.createdAt || d.updatedAt || null });
    }
  }

  const funnelRaw = STAGES.map((_, i) => acctIds.filter(id => perAcct[id].reached[i]);
  const funnelCum = [];
  for (let i = 0; i < 7; i++) funnelCum.push(acctIds.filter(id => perAcct[id].maxStage >= i + 1);
  const funnelCumOpt = [];
  for (let i = 0; i < 7; i++) funnelCumOpt.push(acctIds.filter(id => perAcct[id].maxStageOpt >= i + 1);

  const stagnation = {};
  for (const id of acctIds) { const m = perAcct[id].maxStage; stagnation[m] = (stagnation[m] || 0) + 1; }

  const completedStrict = funnelCum[6];
  const completedOpt = funnelCumOpt[6];
  const completionRateStrict = N ? (completedStrict / N) : 0;
  const completionRateOpt = N ? (completedOpt / N) : 0;
  const completionRateStrictPublished = publishedCount ? (publishedIds.filter(id => perAcct[id].maxStage >= 7 / publishedCount) : 0;
  const completionRateOptPublished = publishedCount ? (publishedIds.filter(id => perAcct[id].maxStageOpt >= 7 / publishedCount) : 0;

  const platDist = {};
  for (const id of acctIds) { const p = perAcct[id]. || 'unknown'; platDist[p] = (platDist[p] || 0) + 1; }
  const contentPlat = {};
  for (const r of content) { const p = normPlat(r.); contentPlat[p] = (contentPlat[p] || 0) + 1; }
  const actionTypeDist = {};
  for (const r of decisions) { const a = (r.point || 'unknown'); actionTypeDist[a] = (actionTypeDist[a] || 0) + 1; }
  const decPerAcct = Object.keys(decByAcct;

  const gaps = {};
  { let emptyReach=0, emptyLikes=0, emptyContentId=0, emptyPostUrl=0;
    for (const r of publish) { if (r.reach == null || r.reach === '') emptyReach++; if (r.likes == null || r.likes === '') emptyLikes++; if (r.content_id == null || r.content_id === '') emptyContentId++; if (!r.post_url || !/^https?:\/\//.test(r.post_url)) emptyPostUrl++; }
    gaps.publish = { total: publish.length, emptyReach, emptyLikes, emptyContentId, emptyPostUrl, note: 'post_url 几乎全为空 (真实发布 URL 未回写，仅存于 traffic_links)' }; }
  { let emptyQuality=0; for (const r of content) if (r.quality_score == null || r.quality_score === '') emptyQuality++;
    gaps.content = { total: content.length, emptyQualityScore: emptyQuality, Dist: contentPlat }; }
  { let numericAction=0; for (const r of decisions) { const a = (r.action == null ? '' : r.action.toString()); if (/^\d+$/.test(a)) numericAction++; }
    gaps.decisions = { total: decisions.length, derivedActionType: decisions.length, legacyNumericAction: numericAction }; }
  gaps.visitRecorded = { visitsJson: visits.length, trafficClickLogs: clicks.length, WithClick: Object.keys(clickByAcct, note: 'visits.json 仅 1 条且为全局、无账号归属；S4 仅由 traffic_click_logs 的真实账号点击判定' };
  gaps.dauPerAccount = { dauLogSnapshots: dauLog.length, dauSatisfiedEver: dauSatisfied, externalClicks: clicks.filter(c => c && c.external === true, note: 'S5 现在由真实外部访问（Bright Data 住宅 IP，external===true）判定；自驱/系统流量(ip:self_direct)已排除 -> S5 严格=真实外部 DAU 覆盖账号数' };

  return {
    generatedAt: new Date().toISOString(),
    source: 'READ-TIME honest normalization over D:/mscms-ws/data (STRICT monotonic, no self-report inflation). #608 rewrite 2026-09-02.',
    accountUniverse: N,
    publishedAccounts: publishedCount,
    stages: STAGES,
    funnelRaw, funnelCum, funnelCumOpt,
    completionRateStrict: +completionRateStrict.toFixed(4),
    completionRateOpt: +completionRateOpt.toFixed(4),
    completionRateStrictPublished: +completionRateStrictPublished.toFixed(4),
    completionRateOptPublished: +completionRateOptPublished.toFixed(4),
    completedAccountsStrict: completedStrict,
    completedAccountsOpt: completedOpt,
    stagnation,
    Dist: platDist,
    contentPlatformDist: contentPlat,
    actionTypeDist,
    decisionsAccounts: decPerAcct,
    decisionsTotal: decisions.length,
    gaps,
    events
  };
}

module.exports = { computeLoopQuality, normPlat };
