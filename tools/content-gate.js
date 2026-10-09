#!/usr/bin/env node
/**
 * content-gate.js — 发布前内容门禁（AI 味 + 平台合规 + 重复度）
 * ════════════════════════════════════════════════════════════════════════
 * 定位：`content-deai.js` 是「生成后处理引擎」，但它只挂在 content-pipeline.js 上；
 *而 kk20-daily / hlua40-daily / free--publisher 这三条真实外发路径
 * 【全部绕过】它（实测：grep deai 在这三个脚本里 0 命中）。
 *       ⇒ 引擎写得再好，外发内容一次都没被它处理过。
 *
 * 本文件是【最后一道闸门】：不管内容从哪条路生成、不管有没有经过 deai，
 *   只要准备外发，就必须过 gate()。判定为 block 就绝不允许进 publish 队列。
 *
 * 三条红线（任一命中 → BLOCK）：
 *   ① AI 味超标   ai_score >= AI_MAX（默认 40，来自 humanizer 24 条规则）
 *   ② 平台合规   命中 Tumblr/Mastodon/Nostr 的明令禁止项（成人、垃圾、欺骗）
 *   ③ 重复/模板化  与库内已有内容首段重复（平台判为 spam 的主要依据）
 *
 * 用法：
 *   node tools/content-gate.js --file body.txt            # 单文件体检
 *   node tools/content-gate.js --scan ready               # 扫 content.json status=ready
 *   node tools/content-gate.js --scan published --limit 500
 *   node tools/content-gate.js --scan ready --json        # 机器可读
 *
 * 只读：不修改任何数据文件。整改靠调用方按 report 的 suggestions 处理。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || 'D:/mscms-ws/data';

// ── 阈值 ────────────────────────────────────────────────────────────────
// 阈值校准（2026-10-09，用真实外发数据反推）：
//   实测一段典型 AI 腔样例（game-changer + seamlessly + leverage + cutting-edge
//   + "not just...testament" + feel free）= 35 分。若阈值 40 会放行 → 必然漏网。
//   取 25：published 池45.7% 拦下、ready 池约 3 成拦下，既不放过典型 AI 腔，
//   又不至于把正常内容全杀光（否则内容池枯竭）。
const AI_MAX = Number(process.env.GATE_AI_MAX || 25);
const RISK_MAX = Number(process.env.GATE_RISK_MAX || 0); // 命中即阻断
// 注意：dupMap 统计【含自身】的同指纹条数，所以「库中存在另一条相同」= dup > 1，
// 而不是 dup > 0（否则每条内容都会与自己匹配 → 100% 误判，实测已踩）。
const DUP_MAX = Number(process.env.GATE_DUP_MAX || 1);

// ════════════════════════════════════════════════════════════════════
// 规则集：humanizer 24 条（Wikipedia:Signs of AI writing）+ 本项目实战补充
// 每条规则：{id, cat, re, w(权重), why, fix(整改建议)}
// ════════════════════════════════════════════════════════════════════
const RULES = [
  // ── 1. 夸大意义/地位（humanizer §1）──
  { id: 'H01', cat: 'inflated', w: 6, re: /\b(serves as|stands as|is a testament to|is a reminder of)\b/gi, why: '拔高事物意义', fix: '直接说它是什么' },
  { id: 'H02', cat: 'inflated', w: 5, re: /\b(pivotal|crucial|vital|significant|groundbreaking|renowned)\b/gi, why: '夸张形容词', fix: '换成具体事实或数字' },
  { id: 'H03', cat: 'inflated', w: 5, re: /\b(underscores?|highlights? its (importance|significance)|reflects broader|symbolizing its)\b/gi, why: '假深刻 -ing 结构', fix: '删掉，直接讲事实' },
  { id: 'H04', cat: 'inflated', w: 5, re: /\b(contributing to the|setting the stage for|marks a shift|key turning point|evolving landscape)\b/gi, why: '宏大叙事', fix: '砍掉整句' },

  // ── 2. 媒体/权威背书（§2）──
  { id: 'H05', cat: 'notability', w: 8, re: /\b(industry reports?|experts (argue|believe|say)|observers have cited|several sources)\b/gi, why: '含糊权威来源', fix: '指名道姓+时间，或删掉' },

  // ── 3. -ing 尾巴伪分析（§3）──
  { id: 'H06', cat: 'superficial', w: 4, re: /,\s*(highlighting|underscoring|emphasizing|ensuring|reflecting|symbolizing|contributing to|cultivating|fostering|encompassing|showcasing)\b/gi, why: '句尾挂 -ing 假装深刻', fix: '删掉这个分词短语' },

  // ── 4. 促销腔（§4）──
  { id: 'H07', cat: 'promo', w: 5, re: /\b(vibrant|profound|breathtaking|must-visit|stunning|nestled in the heart)\b/gi, why: '旅游 brochure 腔', fix: '换成平实描述' },
  { id: 'H08', cat: 'promo', w: 5, re: /\b(boasts a|commitment to|exemplifies)\b/gi, why: '宣传语式动词', fix: '改成 is / has' },

  // ── 5. 套路式"挑战与展望"（§6）──
  { id: 'H09', cat: 'formulaic', w: 8, re: /\b(despite (its|these)[^.]*?(faces several s|s)|future outlook|s and legacy)\b/gi, why: 'AI 固定章节结构', fix: '直接写具体做了什么' },

  // ── 6. AI 高频词（§7）──
  { id: 'H10', cat: 'vocab', w: 4, re: /\b(delve|delving)\b/gi, why: 'AI 标志词', fix: '用 dig into / look at' },
  { id: 'H11', cat: 'vocab', w: 4, re: /\b(seamlessly|seamless)\b/gi, why: 'AI 高频词', fix: '删掉或用具体的连接词' },
  { id: 'H12', cat: 'vocab', w: 3, re: /\b(leverage|leveraging)\b/gi, why: '营销词非日常词', fix: '用 use / take advantage of' },
  { id: 'H13', cat: 'vocab', w: 3, re: /\b(streamline|streamlining)\b/gi, why: '咨询公司话术', fix: '用 simplify / speed up' },
  { id: 'H14', cat: 'vocab', w: 4, re: /\b(tapestry|testament|paradigm shift|holy grail|silver bullet|perfect storm)\b/gi, why: '空洞隐喻', fix: '整句删除' },
  { id: 'H15', cat: 'vocab', w: 4, re: /\b(game[- ]changer)\b/gi, why: '自夸式标签', fix: '用具体效果替代' },
  { id: 'H16', cat: 'vocab', w: 3, re: /\b(empower|empowering|cutting[- ]edge|ever[- ](evolving|changing))\b/gi, why: 'AI 高频词', fix: '用平实说法' },
  { id: 'H17', cat: 'vocab', w: 3, re: /\b(navigate the|holistic|in the realm of)\b/gi, why: '抽象名词堆砌', fix: '改为具体动作' },

  // ── 7. 拐弯抹角（§8）──
  { id: 'H18', cat: 'copula', w: 4, re: /\b(serves as|stands as|marks a|represents a)\b/gi, why: '回避 is/are', fix: '直接用 is / are' },

  // ── 8. 否定平行句（§9）──
  { id: 'H19', cat: 'parallel', w: 6, re: /\b(not just .{0,40}?,? (it'?s|but) |not merely .{0,30}?,? it'?s |it'?s not (just )?about .{0,40}, it'?s )/gi, why: '"不只是X，而是Y"套式', fix: '一句话直说' },
  { id: 'H20', cat: 'parallel', w: 5, re: /\bnot only .{1,60},? but also\b/gi, why: 'Not only…but also 套式', fix: '拆成两句或删' },

  // ── 9. 三段式强迫症（§10）──
  { id: 'H21', cat: 'threes', w: 3, re: /\b\w+,\s*\w+,?\s+and\s+\w+\b(?=[^.!?]{0,40}$)/gi, why: '连续三个并列', fix: '留两个，或拆句' },

  // ── 10. 假范围（§12）──
  { id: 'H22', cat: 'range', w: 5, re: /\bfrom .{1,40} to .{1,40},? from /gi, why: '"从X到Y，从A到B"假排比', fix: '列出具体几项' },

  // ── 11. 破折号滥用（§13）──
  { id: 'H23', cat: 'style', w: 4, re: /—/g, why: '破折号过多（真人 1-2 个/段）', fix: '改用逗号或句号', perChar: true },

  // ── 12. 粗体滥用（§14）──
  { id: 'H24', cat: 'style', w: 3, re: /\*\*/g, why: '机械加粗', fix: '去掉星号', perChar: true },

  // ── 13. emoji 装饰（§17）──
  { id: 'H25', cat: 'style', w: 2, re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, why: '标题/条目堆 emoji', fix: '去掉', perChar: true },

  // ── 14. 弯引号（§18）──
  { id: 'H26', cat: 'style', w: 3, re: /[“”‘’]/g, why: '弯引号是 LLM 指纹', fix: '换直引号 " ', perChar: true },

  // ── 15. 聊天残留（§19 §21）──
  { id: 'H27', cat: 'chat', w: 10, re: /\b(i hope this helps|of course!|certainly!|great question!|you'?re absolutely right|let me know if|would you like me to|feel free to)\b/gi, why: '把对话回复粘成内容', fix: '整段删掉' },
  { id: 'H28', cat: 'chat', w: 8, re: /\b(as of (my last|the) .{0,20}update|up to my last training|based on available information|specific details are (limited|scarce))\b/gi, why: '模型知识截止声明', fix: '删掉' },
  { id: 'H29', cat: 'sycophancy', w: 8, re: /\b(that'?s an excellent point|great question|what a great|awesome question)\b/gi, why: '谄媚语气', fix: '直接答' },

  // ── 16. 冗余填充（§22 §23）──
  { id: 'H30', cat: 'filler', w: 5, re: /\b(in order to|due to the fact that|at this point in time|in the event that|it is important to note that|the fact of the matter is)\b/gi, why: '公文填充语', fix: '用短句' },
  { id: 'H31', cat: 'filler', w: 6, re: /\b(could potentially possibly be|might have some effect on|it could be argued that)\b/gi, why: '过度对冲', fix: '给一个明确判断' },

  // ── 17. 通用积极收尾（§24）──
  { id: 'H32', cat: 'ending', w: 6, re: /\b(the future looks bright|exciting times lie ahead|journey toward excellence|major step in the right direction)\b/gi, why: '空洞积极结尾', fix: '换成具体计划' },

  // ── 18. 段落/条目格式化（§15 §16）──
  { id: 'H33', cat: 'format', w: 4, re: /^\s*[-*]\s+\*\*.+\*\*\s*:/gm, why: '粗体冒号竖列条目', fix: '改写成连贯段落' },
  { id: 'H34', cat: 'format', w: 3, re: /^\s*#{1,6}\s+[A-Z][a-z]+(\s+[A-Z][a-z]+){2,}/gm, why: '标题全大写词（Title Case）', fix: '改成句首大写' },

  // ── 19. 本项目实战补充（历史外发踩坑）──
  { id: 'X01', cat: 'proj', w: 6, re: /\b(hot take:|unpopular opinion:|here'?s the thing)\b/gi, why: '外发实测：同一模板最多重复 139 次 → 平台 spam 判据', fix: '换开头，或该条直接弃用' },
  { id: 'X02', cat: 'proj', w: 4, re: /\b(technical debt isn'?t a failure)\b/gi, why: '实测重复数十次的固定开头', fix: '弃用该开头' },
  { id: 'X03', cat: 'proj', w: 8, re: /[\u4e00-\u9fa5]/g, why: '中文正文发到英文平台（Tumblr 英文标签流）', fix: '改写为英文', cjk: true },
];

// ════════════════════════════════════════════════════════════════════
// 平台合规红线（明令禁止项 —— 命中即 BLOCK，无阈值）
// ════════════════════════════════════════════════════════════════════
const PLATFORM_BAN = [
  // 成人 —— Tumblr 对 adult blog 有年龄隔离，未标记会被直接隐藏
  //⚠️ 语境豁免（2026-10-09 实测修正）：裸 \b 匹配造成大量误杀 ——
  //   「精通 XXX」= 简历占位符（实测 263 条）、 porn 只有 1 条真实命中。
  //   故：① 裸 XXX 仅在【无引号包裹且邻近成人语境词】时才判；② hack/crack 排除
  //   合法搭配（kitchen hack / life hack / growth hack / crack an interview…）。
  { re: /\b(porn|pornography|nude|nudity|nsfw|hentai|erotica|horny)\b/gi, w: 'adult', why: 'Tumblr/Mastodon 成人内容需标记，否则被隐藏或封号' },
  { re: /['"‘’“”]\s*(XXX|xxx)\s*['"‘’“”]|占位/g, w: null, skip: true }, // 占位符不算
  { re: /\bXXX\b(?![^\n]{0,20}['"’”])/gi, w: 'xxx-adult', why: '裸 XXX（无引号）疑似成人暗示', soft: true },
  { re: /\bsexual(ly)?\b(?!\s*(harassment|orientation|dimorphism|reproduction|health|identity|expression))/gi, w: 'adult', why: '成人内容', soft: true },
  { re: /\bexplicit(ly)?\b(?!\s*(read|reads|stated|statedly|instruction|instructions|formula))/gi, w: 'adult', why: '露骨内容', soft: true },
  { re: /\b(onlyfans|escort service|cam girl|webcam model|strip club)\b/gi, w: 'adult-adjacent', why: '成人擦边，平台封禁' },
  // 垃圾/欺骗 —— 判为 spam
  { re: /\b(buy followers|cheap followers|free followers|work from home and earn|make \$\d+ (a|per) (day|week))\b/gi, w: 'spam', why: '垃圾营销话术，平台 spam 判据' },
  { re: /\b(crypto giveaway|double your (bitcoin|crypto|money)|guaranteed returns?|investment advice|forex signals?)\b/gi, w: 'scam', why: '诈骗/金融诱导，平台直接封' },
  { re: /\b(keygen|warez|piracy|cracked software|free crack)\b/gi, w: 'piracy', why: '盗版/破解，DMCA 风险' },
  { re: /\b(torrent|free download of)\b/gi, w: 'piracy', why: '盗版资源', soft: true },
  // hack/crack 语境豁免：只保留明显指向破解软件的组合
  // ⚠️ hack 语境区分（实测）：「hack into / hacking OpenAI / hack the system」
  // 绝大多数是技术讨论语境（AI 安全科普），不是攻击教程 ⇒ 一律 soft，不阻断。
  // 真正该拦的是「破解软件/密码」这类明确指向盗版或未授权访问的组合。
  { re: /\b(hack(ing)? (into|someone'?s account|)| hack|hacked (account|email|server))\b/gi, w: 'hack', why: '入侵/未授权访问（技术语境，需人工确认）', soft: true },
  { re: /\bcrack(ed|ing)?\s+(the\s+)?(|wifi|software|license|drm|psn|xbox)\b/gi, w: 'hack', why: '破解软件/密码' },
  { re: /\b(mlm|recruit(ing)? (people|others)|pyramid scheme|downline)\b/gi, w: 'mlm', why: '传销，平台严禁' },
  // 伪装/引流违规（Tumblr 明令：伪装成他人 / 诱导外链）
  { re: /https?:\/\/(web|api2|cdn)\.alua\.com\/\S+\.mp4/gi, w: 'cdn-raw', why: '外发直链裸 CDN 视频地址，非正常落地页，Tumblr 判为垃圾外链', block: true },
  { re: /\b(click here|dm me||whatsapp)\b.{0,20}\b(link|in bio|comment)\b/gi, w: 'bait-link', why: '诱导式引流，平台降权' },
];

// ════════════════════════════════════════════════════════════════════
// 检测主函数
// ════════════════════════════════════════════════════════════════════
 detectAI(body, title) {
  const text = (title ? title + '\n' : '') + String(body || '');
  const hits = [];
  let score = 0;

  for (const r of RULES) {
    const m = text.match(r.re);
    if (!m || !m.length) continue;
    let n = r.perChar ? m.length : m.length;
    // CJK 只罚一次（整段中文不算 100 分）
    const w = r.cjk ? r.w : r.w * Math.min(n, r.perChar ? 6 : 3);
    score += w;
    hits.push({ id: r.id, cat: r.cat, n, w, why: r.why, fix: r.fix, samples: [...new Set(m)].slice(0, 3) });
  }

  // 结构层信号（humanizer §13/15/16 + 本项目实战）
  const sents = String(body || '').split(/[.!?]+\s/).filter(s => s.trim( > 2);
  if (sents.length >= 4) {
    const lens = sents.map(s => s.split(/\s+/);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const sd = Math.sqrt(lens.reduce((a, l) => a + (l - avg) ** 2, 0) / lens.length);
    const cv = sd / avg;
    if (cv < 0.25) { score += 10; hits.push({ id: 'S01', cat: 'rhythm', n: 1, w: 10, why: `句长过于均匀(变异系数${cv.toFixed(2)})，机器感强`, fix: '长短句混排，加短句' }); }
  }
  // 段落等长
  const paras = String(body || '').split(/\n\n+/).filter(p => p.trim());
  if (paras.length >= 3) {
    const pl = paras.map(p => p.split(/\s+/);
    const avg = pl.reduce((a, b) => a + b, 0) / pl.length;
    if (pl.every(l => Math.abs(l - avg) < avg * 0.25)) {
      score += 8; hits.push({ id: 'S02', cat: 'rhythm', n: 1, w: 8, why: '段落长度几乎相同', fix: '打乱段落长度' });
    }
  }
  // 全篇无第一人称 & 无情绪 = 无灵魂
  const personal = (text.match(/\b(I|me|my|mine|we|us|our|I've|I'd|I'm)\b/gi) || [];
  const words = text.split(/\s+/;
  if (words > 25 && personal === 0) {
    score += 8; hits.push({ id: 'S03', cat: 'soul', n: 1, w: 8, why: '零第一人称/零观点，读起来像通稿', fix: '加入个人观察或取舍' });
  }
  // 短文本
  const blen = String(body || '').trim(;
  if (blen > 0 && blen < 80) {
    score += 12; hits.push({ id: 'S04', cat: 'thin', n: 1, w: 12, why: `正文仅 ${blen} 字符，信息量不足`, fix: '补一个具体细节/数字/经历' });
  }

  return { score, hits, words, personal, len: blen, sentences: sents.length };
}

 detectRisk(body, title) {
  const text = (title ? title + ' ' : '') + String(body || '');
  const hits = [];
  for (const b of PLATFORM_BAN) {
    if (b.skip) continue; // 纯豁免条目，不产生命中
    const m = text.match(b.re);
    if (m && m.length) hits.push({ w: b.w, why: b.why, n: m.length, soft: !!b.soft, samples: [...new Set(m)].slice(0, 3) });
  }
  // soft 命中（语境敏感）不单独阻断，只作为提示 —— 避免误杀正当内容
  const hard = hits.filter(h => !h.soft);
  return { all: hits, hard };
}

/** 归一化首段指纹（用于重复检测） */
 fingerprint(body) {
  return String(body || '').toLowerCase().replace(/https?:\/\/\S+/g, '').replace(/[^a-z0-9\u4e00-\u9fa5 ]/g, '').split(/\s+/).slice(0, 12).join(' ');
}

 gate(content, dupMap) {
  const body = content.body || content.text || content.caption || '';
  const title = content.title || '';
  const ai = detectAI(body, title);
  const riskObj = detectRisk(body, title);
  const risk = riskObj.all, hardRisk = riskObj.hard;

  const fp = fingerprint(body);
  let dup = 0;
  if (fp && dupMap) dup = dupMap.get(fp) || 0;

  const reasons = [];
  if (ai.score >= AI_MAX) reasons.push({ code: 'AI_SCORE', detail: `AI 味 ${ai.score} >= ${AI_MAX}`, hits: ai.hits });
  // 只有【硬红线】才阻断；soft 仅提示，防误杀（实测 263 条「精通 XXX」是简历占位符）
  if (hardRisk.length > RISK_MAX) reasons.push({ code: 'PLATFORM_RISK', detail: `命中 ${hardRisk.length} 条平台硬红线`, risk: hardRisk });
  if (dup > DUP_MAX) reasons.push({ code: 'DUPLICATE', detail: `与库内 ${dup} 条内容首段重复` });

  return {
    id: content.id, status: content.status || '', : content. || '',
    title: String(title).slice(0, 70), len: ai.len, words: ai.words,
    ai_score: ai.score, ai_hits: ai.hits, personal: ai.personal,
    risk_hits: risk, hard_risk: hardRisk.length, dup,
    verdict: reasons.length ? 'BLOCK' : 'PASS',
    reasons,
  };
}

// ════════════════════════════════════════════════════════════════════
// CLI
// ════════════════════════════════════════════════════════════════════
 loadContent() {
  try { const v = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'content.json'), 'utf8')); return Array.isArray(v) ? v : Object.values(v); }
  catch (e) { console.error('读 content.json 失败:', e.message); return []; }
}

 buildDupMap(contents) {
  const m = new Map();
  for (const c of contents) { const fp = fingerprint(c.body || c.text); if (fp) m.set(fp, (m.get(fp) || 0) + 1); }
  return m;
}

 main() {
  const args = process.argv.slice(2);
  const get = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const asJson = args.includes('--json');
  const limit = Number(get('--limit') || 0);

  // 单文件模式
  const file = get('--file');
  if (file) {
    const body = fs.readFileSync(file, 'utf8');
    const r = gate({ id: file, body });
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.verdict === 'BLOCK' ? 1 : 0);
  }

  const scan = get('--scan') || 'ready';
  const all = loadContent();
  const dupMap = buildDupMap(all);
  let pool = all.filter(c => (c.status || '') === scan);
  if (limit) pool = pool.slice(0, limit);

  const results = pool.map(c => gate(c, dupMap));
  const blocked = results.filter(r => r.verdict === 'BLOCK');
  const byCode = {};
  for (const r of results) for (const rs of r.reasons) byCode[rs.code] = (byCode[rs.code] || 0) + 1;
  const topHits = {};
  for (const r of results) for (const h of r.ai_hits) topHits[h.id + ' ' + h.why] = (topHits[h.id + ' ' + h.why] || 0) + 1;

  const summary = {
    scanned: results.length,
    status: scan,
    pass: results.length - blocked.length,
    block: blocked.length,
    blockRate: results.length ? +(blocked.length / results.length * 100).toFixed(1) : 0,
    byCode, thresholds: { AI_MAX, RISK_MAX, DUP_MAX },
    topAiHits: Object.entries(topHits).sort((a, b) => b[1] - a[1]).slice(0, 15),
    worst: blocked.sort((a, b) => b.ai_score - a.ai_score).slice(0, 12).map(r => ({
      id: r.id, ai: r.ai_score, dup: r.dup, len: r.len,
      why: r.reasons.map(x => x.code).join('+'), title: r.title,
      topHits: r.ai_hits.slice(0, 3).map(h => h.id + ':' + h.why),
    })),
  };

  if (asJson) { console.log(JSON.stringify(summary, null, 2)); }
  else {
    console.log('══ 内容门禁体检 ═══');
    console.log(`扫描 content.json status=${scan}：${summary.scanned} 条`);
    console.log(`PASS ${summary.pass} · BLOCK ${summary.block}（${summary.blockRate}%）  阈值 AI>=${AI_MAX}`);
    console.log('阻断原因分布:', JSON.stringify(byCode));
    console.log('\nTop AI 腔命中:');
    for (const [k, v] of summary.topAiHits) console.log('  ', v, '×', k);
    console.log('\n最严重 12 条:');
    for (const w of summary.worst) {
      console.log(`  [${w.why}] ai=${w.ai} dup=${w.dup} len=${w.len} id=${w.id}`);
      console.log(`     title: ${w.title}`);
      if (w.topHits.length) console.log(`     ${w.topHits.join(' | ')}`);
    }
  }
  process.exit(blocked.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { gate, detectAI, detectRisk, fingerprint, RULES, PLATFORM_BAN, buildDupMap };