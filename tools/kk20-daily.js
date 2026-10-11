#!/usr/bin/env node
'use strict';
/**
 * kk20-daily.js — KKMatch 20 账号「每日早晚各 1 帖」定向投放执行器
 *
 * 一次运行 = 一个批次（早 20 帖 / 晚 20 帖），串起四段**真实**链路：
 *   1) 排期骨架   reports/kk20-schedule-7d.json（7 天滚动，按日期取模）
 *   2) 文案生成   Agnes `agnes-2.5-flash`（英文唯一，跨天去重）
 *   3) 配图       spawn tools/kk20-arts.py（:3010 真实生图 + PIL 本地叠字）
 *   4) 注入       POST /api/v14/content（status=ready + account_id 定向绑定）
 *
 * 定向绑定为何可行（已实测确认，非推测）：
 *   `server.js` 发布器分配账号时 `content.account_id` 是**第 1 优先级**，
 *   命中即用，失败才回落到配额感知轮询池 ⇒ 零架构改动即完成 20 账号定向。
 *
 * 媒体为何走 `images[]` 而不改 server.js（已实测确认）：
 *   `cloud-publisher.js:_resolveMediaForPublish()` 的候选列表末位是 `preview_url`，
 *   且经 `isRealMediaRef()` 过滤（排除存档 .json）+ `fs.existsSync()` **逐个探盘**。
 *   路由把 `images[0]` 落成 `preview_url`，我们传的是真实 PNG ⇒ 命中真图文通道。
 *   （P2-B5 的事故是 preview_url 指向存档 JSON，与本案不同。）
 *   ⚠️ `platform` 必须显式传 'tumblr'：路由默认按 content_type 推断，
 *      image_text 会被推断成 'instagram'，那样就发错通道了。
 *
 * 幂等：content id 确定为 `kk20-<date>-<batch>-<n>`，注入前查 content 池，命中即跳过。
 *       批次状态写在 reports/kk20-batches/<date>-<batch>.json。
 *
 * 用法：
 *   node tools/kk20-daily.js --batch morning
 *   node tools/kk20-daily.js --batch evening --date 2026-09-22
 *   node tools/kk20-daily.js --batch morning --dry-run     # 生成+配图，不注入
 *   node tools/kk20-daily.js --batch morning --limit 2     # 冒烟测试
 *   node tools/kk20-daily.js --batch morning --no-image    # 跳过配图（纯排障）
 *   node tools/kk20-daily.js --batch morning --force       # 忽略已完成标记重跑
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fetchExt } = require('../http-client');

const ROOT = path.dirname(__dirname);
const SCHEDULE = path.join(ROOT, 'reports', 'kk20-schedule-7d.json');
const CANDIDATES = path.join(ROOT, '_kk20_candidates.json');
const BATCHDIR = path.join(ROOT, 'reports', 'kk20-batches');
const CONTENT_JSON = 'D:/mscms-ws/data/content.json';
const PY = 'C:/Users/AS/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
const ARTS = path.join(ROOT, 'tools', 'kk20-arts.py');

const AGNES_BASE = 'https://api.agnes-ai.cn';
const AGNES_PROXY = process.env.AGNES_PROXY || 'http://127.0.0.1:10808';
const LLM_MODEL = process.env.KK20_LLM_MODEL || 'agnes-2.5-flash';
const API = process.env.KK20_API || 'http://127.0.0.1:3002';

/** 排期起始日：dayIndex = (date - START) mod 7，7 天滚动复用（配合跨天去重） */
const START_DATE = '2026-09-22';
const ID_PREFIX = 'kk20';
const LLM_CHUNK = 5;            // 每 5 条一次 LLM 调用：容错好且快（20 条 = 4 次）

/** 配图负面词固定：不依赖 LLM，杜绝「带文字的界面」这类必然吐乱码的构图 */
const IMAGE_NEGATIVE = [
  'text', 'letters', 'words', 'typography', 'watermark', 'logo', 'signature',
  'UI screenshot', 'app interface', 'cards', 'dashboard', 'chart axis labels',
  'numbers', 'gibberish characters', 'caption', 'subtitle',
].join(', ');

// ───────────────────────────── 小工具 ─────────────────────────────

function parseArgs(argv) {
  const a = { batch: null, date: null, dryRun: false, noImage: false, limit: 0, force: false, rev: '', resume: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--batch') a.batch = String(argv[++i] || '').toLowerCase();
    else if (k === '--date') a.date = String(argv[++i] || '');
    else if (k === '--rev') a.rev = String(argv[++i] || '').trim().replace(/[^a-z0-9]/gi, '');
    else if (k === '--resume') a.resume = true;
    else if (k === '--dry-run') a.dryRun = true;
    else if (k === '--no-image') a.noImage = true;
    else if (k === '--force') a.force = true;
    else if (k === '--limit') a.limit = parseInt(argv[++i] || '0', 10) || 0;
  }
  return a;
}

function todayStr() {
  // 用本机本地时区（用户在中国大陆，UTC+8）；避免 UTC 跨日导致批次归错天
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function dayIndexFor(dateStr) {
  const d0 = Date.parse(`${START_DATE}T00:00:00+08:00`);
  const d1 = Date.parse(`${dateStr}T00:00:00+08:00`);
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) throw new Error(`日期无法解析: ${dateStr}`);
  const diff = Math.round((d1 - d0) / 86400000);
  return ((diff % 7) + 7) % 7;                     // 0-based 天索引
}

function log(...args) { console.log(...args); }

/**
 * 【2026-10-09】kk20 正文由 LLM 生成，实测 0 条含 kkmatch.com 可点击链接。
 * 追加落点链接，保证对外发布帖 100% 指向活站 kkmatch.com（目标 DAU 站）。
 * 若正文已含 kkmatch 链接则不重复追加。
 */
function withKkLink(body) {
  if (!body) return body;
  if (/https?:\/\/[^\s)]*kkmatch\.com/i.test(body)) return body;
  return `${String(body).trim()}\n\n🔗 https://kkmatch.com`;
}

function getApiKey() {
  const f = path.join(process.env.USERPROFILE || process.env.HOME || '', '.workbuddy', 'config', 'agnes_api_key.txt');
  try {
    if (fs.existsSync(f)) {
      const k = fs.readFileSync(f, 'utf8').trim();
      if (k) return k;
    }
  } catch (_) { /* ignore */ }
  return process.env.AGNES_API_KEY || null;
}

/** 括号配平扫描：从 start 处的 `[`/`{` 起返回配平后的子串（跳过字符串字面量内的括号） */
function balancedSlice(s, start) {
  const open = s[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;              // 未配平 ⇒ 多半被 max_tokens 截断，交由上层重试
}

/**
 * 从 LLM 返回里抠出 JSON 数组。
 *
 * ⚠️ 实测教训（agnes-2.5-flash）：它会吐出
 *     `{\n[\n{...}\n]\n}`  —— 数组被一个**没有 key 的对象**包住。
 *   早先「取第一个开括号 + lastIndexOf(闭括号)」的写法在这种形状下必然 parse 失败
 *   （`{ [...] }` 不是合法 JSON），表现为「模型明明生成了内容却报 0 条」。
 *   现改为：对每个 `[`/`{` 起点做配平扫描并尝试解析，返回第一个能 parse 成功的片段。
 */
function extractJSON(text) {
  if (!text) return null;
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== '[' && ch !== '{') continue;
    const sub = balancedSlice(s, i);
    if (!sub) continue;
    try {
      const v = JSON.parse(sub);
      if (Array.isArray(v)) return v;
      if (v && typeof v === 'object') {
        for (const k of ['posts', 'items', 'results', 'data']) {
          if (Array.isArray(v[k])) return v[k];
        }
        if (v.n !== undefined || v.title) return [v];   // 单条裸对象
      }
    } catch (_) { /* 该起点不成立，换下一个 */ }
  }
  return null;
}

// ───────────────────────────── LLM ─────────────────────────────

const BRAND = `KKMatch (kkmatch.com) — an AI Relationship Intelligence platform.

Real product capabilities (use ONLY these as factual anchors; never invent features, prices or statistics):
- KKOS 11-dimension human model: builds an 11-dimensional profile of a person from a single conversation in under 5 minutes.
- OMi matching engine: matches people by behavioural model, not by surface-level tags or photos.
- Personality Profile (MIND · CAPSULE): a compact personality capsule you can actually read and argue with.
- Relationship Memory (TGN · TEMPORAL): a temporal graph network that remembers how a relationship evolves over time, not just its current snapshot.
- Causal Insight (NOTEARS++ · CAUSAL): goes beyond correlation — surfaces which behaviours actually cause relationship outcomes.
- Mutual Matching (DYADIC · ATTENTION): models both people at once with cross-attention, instead of scoring each person in isolation.
- Relationship Forecast (DSM · SURVIVAL): survival analysis applied to relationship trajectories — a forecast, not a horoscope.
- OMi Chemistry Lab: a microscope for real conversations.
- 4 Life Dimensions: social, career, health and financial dimensions projected over a 9-year horizon.
- Explainability: every one of the 11 dimensions comes with evidence, a 0-1 probability and an uncertainty interval (±CI). No black box.
- Enterprise-grade validation: built with academic and industry partners (HUST, Allen Institute for AI, Merriam-Webster references).
- Free 7-day trial, no credit card required.`;

const CATEGORY_BRIEF = {
  provocative: 'Take a contrarian, spicy stance about dating / self-knowledge. Challenge a belief the reader holds. Provocative but never offensive, never shaming.',
  fun: 'Playful and light. Frame the product capability as a game, a challenge or a small experiment the reader can try right now.',
  'tech-trends': 'Talk like a builder who ships AI systems. Mention the technical angle (causal inference, temporal graph, survival model, interpretability) in plain language — no jargon dumps.',
  humanities: 'Quiet, observant, human. Write about how people actually relate: misread signals, unspoken needs, slow drift. Warm, never clinical.',
  humor: 'A short comedy bit. Self-aware, dry, observational. The joke should land in the first two lines.',
  memes: 'Internet-native voice. Short lines, screenshot-able phrasing, a punchline. Do not reference specific real people or brands.',
};

const GENRE_BRIEF = {
  question: 'Open with a direct hook question in the first line.',
  listicle: 'Structure the body as a tight list of 3-5 short items.',
  contrast: 'Build a before/after or A-vs-B contrast.',
  story: 'Tell a tiny first-person slice-of-life story, then land the point.',
  data: 'Lead with a number or a measurable claim drawn from the product capability description (no invented statistics — reframe the capability, do not fabricate data).',
  'self-deprecating': 'Admit a personal failure or blind spot, then pivot to the insight.',
  conversation: 'Write it as a snatch of dialogue or an imagined reply thread.',
};

/**
 * 调 LLM 并解析出 JSON 数组。
 *
 * `validate` 是关键：只判断「能不能 parse」远远不够 —— 模型会返回**形状合法但内容不对**
 * 的结果（字符串数组、只带 n 的骨架），解析成功、条目也够，却全是空字段。
 * 实测早批 5/5 全缺字段，只看「收到 5 条」根本无法定位。传 validate 即可把这类
 * 输出判为失败并进入重试。
 *
 * 重试时把失败原因**作为对话反馈追加回去**（比单纯降 temperature 有效得多）。
 */
async function llmJSON(messages, { maxTokens = 2600, temperature = 0.95, tries = 3, validate = null } = {}) {
  const key = getApiKey();
  if (!key) throw new Error('AGNES_API_KEY_MISSING');
  const msgs = messages.slice();
  let lastErr = null;
  for (let t = 0; t < tries; t++) {
    try {
      const resp = await fetchExt(`${AGNES_BASE}/v1/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: LLM_MODEL,
          messages: msgs,
          max_tokens: maxTokens,
          temperature: Math.max(0.4, temperature - t * 0.2),   // 重试逐步收敛
        }),
        timeout: 300000,
      }, AGNES_PROXY);
      const txt = await resp.text();
      if (!resp.ok) throw new Error(`LLM HTTP ${resp.status}: ${txt.slice(0, 200)}`);
      let data; try { data = JSON.parse(txt); } catch (_) { throw new Error('LLM 返回非 JSON'); }
      const content = data?.choices?.[0]?.message?.content || '';
      const parsed = extractJSON(content);
      if (!parsed) throw new Error(`LLM 输出无法解析为 JSON: ${content.slice(0, 180)}`);
      if (validate && !validate(parsed)) throw new Error('输出结构不符预期（条目缺 title/body/image_prompt）');
      return { parsed, usage: data.usage || null, content };
    } catch (e) {
      lastErr = e;
      log(`   ⚠️ LLM 第 ${t + 1}/${tries} 次失败: ${e.message}`);
      if (t < tries - 1) {
        msgs.push({ role: 'assistant', content: `(previous reply rejected: ${String(e.message).slice(0, 140)})` });
        msgs.push({
          role: 'user',
          content: 'Your previous reply was rejected. Reply with ONLY a valid JSON array that starts with "[" and ends with "]". '
            + 'Do NOT wrap it in an object. Every element MUST contain the keys: n, title, body, tags, subtitle_en, image_prompt.',
        });
      }
      await new Promise((r) => setTimeout(r, 1500 * (t + 1)));
    }
  }
  throw lastErr;
}

/** 判据：数组非空，且首条带可用内容字段 */
function looksLikePosts(v) {
  return Array.isArray(v) && v.length > 0 && v[0] && typeof v[0] === 'object'
    && (v[0].title || v[0].body || v[0].image_prompt);
}

/** 收集最近若干批次的标题，作为「禁止复用」清单（跨天去重的关键） */
function recentTitles(excludeFile) {
  const out = [];
  try {
    const files = fs.readdirSync(BATCHDIR)
      .filter((f) => f.endsWith('.json') && !f.includes('run'))
      .sort().reverse().slice(0, 4);
    for (const f of files) {
      const p = path.join(BATCHDIR, f);
      if (excludeFile && path.resolve(p) === path.resolve(excludeFile)) continue;
      try {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        for (const it of (d.items || [])) if (it.title_en) out.push(it.title_en);
      } catch (_) { /* ignore */ }
    }
  } catch (_) { /* ignore */ }
  return out.slice(0, 60);
}

function buildMessages(slots, avoidTitles) {
  const sys = `${BRAND}

You are KKMatch's lead social copywriter. You write for Tumblr: English only, first person, conversational, zero corporate tone. Tumblr readers reward specificity, self-awareness and dry humour; they punish ad-speak.

Hard rules:
- Your ENTIRE reply must be ONE JSON array. It must literally start with "[" and end with "]".
  Do NOT wrap the array in an object, do NOT add a wrapper key such as "posts", do NOT use a
  markdown code fence, and do NOT write any prose before or after the array.
- EVERY user-visible string must be plain ASCII English. No Chinese characters anywhere, in any field.
- Never invent product features, statistics, prices, user counts, or research results. Only reframe the capabilities listed above.
- Never claim to be a real person, never cite real individuals or brands.
- Do not use the words "delve", "elevate", "unlock", "game-changer", "revolutionary", "in today's world".`;

  const schema = `Return a JSON array with exactly ${slots.length} objects, in the same order as given, each shaped:
{
  "n": <the slot number given below>,
  "title": "<= 80 chars, the hook. NO hashtags, NO emoji, no trailing period",
  "body": "2-4 short paragraphs separated by \\n\\n. 60-140 words. Conversational. End with a question or a soft call to action.",
  "tags": ["5-8 lowercase tumblr tags, no # prefix, mix 2 broad (e.g. dating, psychology) with 3-6 specific/情景 tags"],
  "subtitle_en": "<= 65 chars. Second line for the cover image. A concrete, curiosity-driving hook, NOT a repeat of the title",
  "image_prompt": "English, one sentence, describes an ABSTRACT editorial illustration only"
}`;

  const imageRules = `About image_prompt — this is critical:
- Describe an abstract, text-free illustration: silhouettes, geometric line-art, soft gradients, glowing nodes/threads, negative space.
- ABSOLUTELY FORBIDDEN to depict: user interfaces, app screens, chat bubbles, cards, dashboards, charts with axis labels, books with visible type, signs, labels, or ANY rendered letters. The image model will emit gibberish glyphs if you do.
- Always end the prompt with: ", no text, no letters, no words, no numerals, no watermark, minimal editorial tech illustration, soft blue and warm amber palette, 1:1 composition".`;

  const briefs = slots.map((s) => `#${s.n}
  category    : ${s.category_en} — ${CATEGORY_BRIEF[s.category_en] || 'Write in a fresh voice.'}
  angle       : ${s.anchor}
  format      : ${s.genre} — ${GENRE_BRIEF[s.genre] || ''}
  image style : ${s.image_style}
  required CTA: "${s.cta}" (do NOT paste this into body verbatim; echo its intent naturally in the final line)`).join('\n\n');

  let avoid = '';
  if (avoidTitles.length) {
    avoid = `\n\nAlready published in recent days — do NOT reuse these angles, openings or phrasings:\n- ${avoidTitles.slice(0, 40).join('\n- ')}`;
  }

  const user = `${schema}

${imageRules}

Write ${slots.length} distinct posts. They must not share opening words, structural gimmicks, or imagery. Cover the categories below exactly as assigned.

${briefs}${avoid}`;

  return [{ role: 'system', content: sys }, { role: 'user', content: user }];
}

// ─────────────────────── content 池查重 ───────────────────────

function loadExistingIds() {
  const ids = new Set();
  try {
    const raw = fs.readFileSync(CONTENT_JSON, 'utf8');
    const arr = JSON.parse(raw);
    const list = Array.isArray(arr) ? arr : (arr.items || Object.values(arr));
    for (const c of list) if (c && c.id) ids.add(String(c.id));
  } catch (e) {
    log(`   ⚠️ content.json 读取失败（查重降级）: ${e.message}`);
  }
  return ids;
}

// ───────────────────────────── 主流程 ─────────────────────────────

async function main() {
  const args = parseArgs(process.argv);
  const date = args.date || todayStr();
  if (!args.batch || !['morning', 'evening'].includes(args.batch)) {
    console.error('用法: node tools/kk20-daily.js --batch morning|evening [--date YYYY-MM-DD] [--dry-run] [--limit N]');
    process.exit(2);
  }

  const windowLabel = args.batch === 'morning' ? '早' : '晚';
  const batchFile = path.join(BATCHDIR, `${date}-${args.batch}.json`);
  fs.mkdirSync(BATCHDIR, { recursive: true });

  log(`\n═══ KKMatch 每日投放 · ${date} · ${args.batch}（${windowLabel}批）═══`);

  // 幂等闸门。⚠️ 必须排除 --limit：否则 2 条冒烟测试的记录会被当成「整批已完成」，
  //    后续正式批次会被静默跳过（实测踩到）。
  if (!args.force && !args.limit && fs.existsSync(batchFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
      if (prev.injected > 0 && prev.injected >= (prev.items || []).length) {
        log(`⏭  本批次已完成（injected=${prev.injected}），跳过。用 --force 强制重跑。`);
        return;
      }
    } catch (_) { /* 损坏则继续重跑 */ }
  }

  // 1) 排期
  const sch = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const di = dayIndexFor(date);
  const day = sch.days[di];
  if (!day) throw new Error(`排期缺少第 ${di + 1} 天`);
  let slots = day.slots.filter((s) => s.window === windowLabel);
  if (args.limit > 0) slots = slots.slice(0, args.limit);

  // 2) 账号定向
  const cands = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  const accFor = (seq) => {
    const c = cands[seq % cands.length];
    if (!c) throw new Error(`候选账号索引越界: ${seq}`);
    return { id: c.id, blogName: c.blogName, username: c.username };
  };

  log(`排期 day${di + 1} · ${args.batch} 批 ${slots.length} 槽 · 账号池 ${cands.length}`);

  // 3) 文案（分块调 LLM）
  const avoid = recentTitles(batchFile);
  if (avoid.length) log(`跨天去重：已知 ${avoid.length} 条历史标题将作为「禁止复用」清单`);

  // --resume：文案已在批内生成过（仅配图/注入阶段失败）时直接复用，
  //   避免重烧 LLM 调用与消耗「跨天去重」的名义唯一性。
  // ⚠️ 跳过生成的守卫**必须用独立标志**，不能用 `!items.length` —— 那会在第一个 chunk
  //    生成完（items 变非空）时立刻终止整个循环，20 槽只产出 5 条（实测踩到）。
  let items = [];
  let resumed = false;
  if (args.resume && fs.existsSync(batchFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
      if (Array.isArray(prev.items) && prev.items.length) {
        items = prev.items.map((x) => {
          const y = Object.assign({}, x);
          delete y.image_error;          // 清掉上轮配图失败标记，让本轮重试
          return y;
        });
        if (args.limit) items = items.slice(0, args.limit);
        resumed = true;
        log(`♻️  --resume：复用批内已有 ${items.length} 条文案（跳过 LLM）`);
      }
    } catch (e) {
      log(`   ⚠️ --resume 读取批次失败，回退到 LLM: ${e.message}`);
    }
  }
  for (let i = 0; !resumed && i < slots.length; i += LLM_CHUNK) {
    const chunk = slots.slice(i, i + LLM_CHUNK).map((s, k) => ({ ...s, n: i + k + 1 }));
    log(`\n[LLM] 生成第 ${i + 1}-${i + chunk.length} 条 …`);
    const messages = buildMessages(chunk, avoid);
    const { parsed, usage, content: rawContent } = await llmJSON(messages, { validate: looksLikePosts });
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed.items || parsed.posts || (parsed.n !== undefined || parsed.title ? [parsed] : []));
    if (arr.length !== chunk.length) {
      log(`   ⚠️ 期望 ${chunk.length} 条，实收 ${arr.length} 条 —— 改用 n 字段匹配（见下）`);
    }
    // 结构体检：条目不少但字段不可用 ⇒ 形状不对（实测模型可能返回字符串数组、
    // 或只带 n 的骨架）。必须打印原始返回，否则只剩「全部缺字段」这种无法定位的结论。
    const _first = arr[0];
    if (arr.length && !(_first && typeof _first === 'object' && (_first.title || _first.body || _first.image_prompt))) {
      log(`   ⚠️ 返回结构异常（首条类型 ${typeof _first}）原始返回前 600 字:`);
      log('   ┌────────────────────────────────────────');
      log(String(rawContent).slice(0, 600).split('\n').map((l) => '   │ ' + l).join('\n'));
      log('   └────────────────────────────────────────');
    }
    // ⚠️ 必须按 `n` 匹配，**不能用数组下标**：实测模型会多返条目（曾对 5 个槽返回 6 条），
    //    纯 index 对齐会整体错位，把最后一条挤成「缺 image_prompt」，进而让整批被质检拦下。
    const byN = new Map();
    for (const g of arr) {
      if (g && typeof g === 'object' && g.n !== undefined) byN.set(Number(g.n), g);
    }
    let unmatched = 0;
    for (let k = 0; k < chunk.length; k++) {
      const src = chunk[k];
      let g = byN.get(Number(src.n));
      if (!g) { g = arr[k] || {}; unmatched++; }
      const acc = accFor(src.account_seq);
      items.push({
        n: src.n,
        slot: src.slot,
        window: args.batch,
        target_time: `${src.time}+${src.offset_min}min`,
        category: src.category,
        category_en: src.category_en,
        anchor: src.anchor,
        anchor_idx: src.anchor_idx,
        genre: src.genre,
        image_style: src.image_style,
        cta: src.cta,
        account_seq: src.account_seq,
        account_id: acc.id,
        blog_name: acc.blogName,
        // title / subtitle 是**单行**字段：模型偶尔夹带换行，而 PIL 的
        // ImageDraw.textlength() 对含 \n 的串会抛 "can't measure length of multiline text"，
        // 直接导致整张图配图失败（实测 20 条挂 2 条）。这里与 wrap() 双层防御。
        title_en: String(g.title || '').replace(/\s*\n\s*/g, ' ').trim(),
        body_en: String(g.body || '').trim(),
        subtitle_en: String(g.subtitle_en || '').replace(/\s*\n\s*/g, ' ').trim(),
        tags: Array.isArray(g.tags) ? g.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8) : [],
        image_prompt: `${String(g.image_prompt || '').trim()}`.replace(/,\s*$/, ''),
        image_negative: IMAGE_NEGATIVE,
        // 幂等键。注意 DataStore 没有 DELETE 端点 ⇒ 重投同一槽位只能换 id 后缀（--rev r2）。
        content_id: `${ID_PREFIX}-${date}-${args.batch}-${src.n}${args.rev ? '-' + args.rev : ''}`,
        llm_usage: usage,
      });
    }
    log(`   ✅ 收到 ${arr.length} 条`);
  }

  // ── 硬校验 1：对缺字段的槽位做一次「补生成」──
  // 模型输出条数会抖动（实测曾对 5 个槽返回 6 条），即便按 n 匹配也可能漏字段。
  // 单条缺字段不该让整批停摆 —— 每日调度要的是「尽量发出去 + 如实上报缺口」。
  const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/;
  const problemsOf = (it) => {
    const p = [];
    if (!it.title_en) p.push('缺 title');
    if (!it.body_en) p.push('缺 body');
    if (!it.image_prompt) p.push('缺 image_prompt');
    for (const f of ['title_en', 'body_en', 'subtitle_en', 'image_prompt']) {
      if (CJK.test(it[f] || '')) p.push(`${f} 含中文`);
    }
    if ((it.tags || []).some((t) => CJK.test(t))) p.push('tags 含中文');
    return p;
  };

  const lack = items.filter((it) => !it.title_en || !it.body_en || !it.image_prompt);
  if (lack.length) {
    log(`\n[LLM] 补生成 ${lack.length} 条（首轮字段缺失）: ${lack.map((x) => '#' + x.n).join(', ')}`);
    try {
      const repairSlots = lack.map((it) => ({
        n: it.n, category_en: it.category_en, anchor: it.anchor,
        genre: it.genre, image_style: it.image_style, cta: it.cta,
      }));
      const { parsed } = await llmJSON(buildMessages(repairSlots, avoid), { validate: looksLikePosts });
      const arr2 = Array.isArray(parsed) ? parsed : (parsed.items || parsed.posts || []);
      const byN2 = new Map();
      for (const g of arr2) if (g && typeof g === 'object' && g.n !== undefined) byN2.set(Number(g.n), g);
      for (const it of lack) {
        const g = byN2.get(Number(it.n));
        if (!g) continue;
        if (!it.title_en && g.title) it.title_en = String(g.title).trim();
        if (!it.body_en && g.body) it.body_en = String(g.body).trim();
        if (!it.subtitle_en && g.subtitle_en) it.subtitle_en = String(g.subtitle_en).trim();
        if (!it.image_prompt && g.image_prompt) it.image_prompt = String(g.image_prompt).trim();
        if ((!it.tags || !it.tags.length) && Array.isArray(g.tags)) {
          it.tags = g.tags.map((t) => String(t).replace(/^#/, '').trim()).filter(Boolean).slice(0, 8);
        }
      }
      log('   补生成完成');
    } catch (e) {
      log(`   ⚠️ 补生成失败（继续，缺口将如实上报）: ${e.message}`);
    }
  }

  // ── 硬校验 2：仍不合格者剔除，不整批失败 ──
  const finalItems = [];
  const dropped = [];
  for (const it of items) {
    const p = problemsOf(it);
    if (p.length) dropped.push({ n: it.n, account_seq: it.account_seq, account_id: it.account_id, problems: p });
    else finalItems.push(it);
  }
  if (dropped.length) {
    log(`\n⚠️ 剔除 ${dropped.length} 条不合格内容:`);
    dropped.slice(0, 10).forEach((d) => log(`   · #${d.n} (${d.account_id}): ${d.problems.join(', ')}`));
  }
  if (!finalItems.length) throw new Error('CONTENT_QC_FAILED: 全部不合格');
  if (dropped.length > Math.ceil(items.length / 2)) {
    throw new Error(`CONTENT_QC_FAILED: 不合格比例过高（${dropped.length}/${items.length}）`);
  }

  // 把剔除后的集合写回 items（保持后续代码单一口径，避免两处变量分叉）
  items.length = 0;
  items.push(...finalItems);
  log(`\n✅ 质检通过：${items.length} 条，全英文，字段齐备${dropped.length ? `（剔除 ${dropped.length} 条）` : ''}`);

  // 4) 落盘文案（配图阶段会原地回写 image）
  const doc = {
    date, batch: args.batch, dayIndex: di + 1,
    generatedAt: new Date().toISOString(),
    api: API, platform: 'tumblr', content_type: 'image_text',
    items, dropped,
    art_ok: 0, art_fail: 0, injected: 0, inject_failed: 0, results: [],
  };
  fs.writeFileSync(batchFile, JSON.stringify(doc, null, 1), 'utf8');
  log(`文案已落盘: ${batchFile}`);

  // 5) 配图
  if (!args.noImage) {
    log(`\n[ART] 调 :3010 真实生图 + PIL 叠字（${items.length} 张，串行）…`);
    const r = spawnSync(PY, [ARTS, '--batch', batchFile], { stdio: 'inherit' });
    if (r.status !== 0) log(`   ⚠️ 配图脚本退出码 ${r.status}（继续，缺图者降级为纯文本）`);
    const after = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
    Object.assign(doc, { items: after.items, art_ok: after.art_ok, art_fail: after.art_fail });
  } else {
    log('\n[ART] 已跳过（--no-image）');
  }

  // 6) 注入
  if (args.dryRun) {
    log('\n[INJECT] --dry-run，跳过注入。');
    fs.writeFileSync(batchFile, JSON.stringify(doc, null, 1), 'utf8');
    log(`\n✅ 干跑完成：文案 ${items.length} 条，配图 ${doc.art_ok}/${items.length}`);
    return;
  }

  const existing = loadExistingIds();
  log(`\n[INJECT] content 池已有 ${existing.size} 条，开始注入（定向 account_id）…`);

  let ok = 0, skip = 0, fail = 0, skippedGate = 0;
  for (const it of doc.items) {
    if (existing.has(it.content_id)) {
      log(`   ⏭  #${it.n} 已存在（${it.content_id}）`);
      doc.results.push({ n: it.n, id: it.content_id, status: 'skipped' });
      skip++;
      continue;
    }
    // ── 发布前门禁（2026-10-09 接入）────────────────────────────────────
    // 为什么要在这里再加一道：注入 API 只是落库，真正外发由发布器异步做，
    // 但【生成时】就能判定的质量问题必须在生成侧拦下来，否则脏内容会先进池、
    // 再被别的路径捡去发。阈值与 tools/content-gate.js 一致（AI>=25 阻断）。
    const bodyForGate = withKkLink(it.body_en);
    let gateBlocked = null;
    try {
      const { gate } = require('./content-gate.js');
      const g = gate({ id: it.content_id, title: it.title_en, body: bodyForGate });
      if (g.verdict === 'BLOCK') {
        gateBlocked = g.reasons.map(r => `${r.code}(${r.detail})`).join('; ') +
          ' | ' + g.ai_hits.slice(0, 3).map(h => h.id + ':' + h.why).join(' / ');
      } else if (g.ai_score >= 18) {
        log(`   ℹ️ #${it.n} AI 味 ${g.ai_score}（低于阈值，记录留档）`);
      }
    } catch (e) {
      log(`   ⚠️ #${it.n} 门禁异常：${e.message}`);
      gateBlocked = 'gate error: ' + e.message; // 保守拒发
    }
    if (gateBlocked) {
      log(`   🚫 #${it.n} 门禁拦下，不注入：${gateBlocked}`);
      doc.results.push({ n: it.n, id: it.content_id, account_id: it.account_id, status: 'gate_blocked', reason: gateBlocked });
      skippedGate++;
      continue;
    }
    const payload = {
      id: it.content_id,
      platform: 'tumblr',                       // ⚠️ 必须显式，否则 image_text 默认推断为 instagram
      content_type: 'image_text',
      title: it.title_en,
      body: withKkLink(it.body_en),              // 【2026-10-09】追加 kkmatch.com 落点链接
      tags: it.tags,
      images: it.image ? [it.image] : [],       // 路由落成 preview_url → 发布器末位候选探盘命中
      status: 'ready',                          // ⚠️ 必须显式，缺省是 editing（不进管线）
      account_id: it.account_id,                // ⚠️ 定向绑定：发布器第 1 优先级
      quality_score: 92,
      generated_at: doc.generatedAt,
    };
    try {
      const resp = await fetchExt(`${API}/api/v14/content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        timeout: 30000,
      });
      const txt = await resp.text();
      let j = null; try { j = JSON.parse(txt); } catch (_) { /* ignore */ }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${txt.slice(0, 160)}`);
      // ⚠️ 路由实际返回 `{ success:true, record:{...} }`（实测确证），
      //    早先按 `j.item` 取值会全部落到 '?'，虽不影响成功判定却掩盖了落库真相。
      const rec = j?.record || j?.item || j || {};
      const savedStatus = rec.status || '?';
      const savedAcct = rec.account_id || '?';
      const savedMedia = rec.media_path || '(media_path 缺失)';
      log(`   ✅ #${it.n} ${it.content_id} → status=${savedStatus} account=${savedAcct}`);
      log(`         media_path=${savedMedia}`);
      if (savedStatus !== 'ready') log(`   ⚠️ #${it.n} status 未落成 ready（${savedStatus}）⇒ 不会进发布管线！`);
      if (savedAcct !== it.account_id) log(`   ⚠️ #${it.n} account_id 与定向不一致（期望 ${it.account_id}）`);
      doc.results.push({ n: it.n, id: it.content_id, account_id: it.account_id, status: 'injected', saved_status: savedStatus, saved_account: savedAcct, media_path: rec.media_path || null, image: it.image || null });
      ok++;
    } catch (e) {
      log(`   ❌ #${it.n} ${it.content_id} 注入失败: ${e.message}`);
      doc.results.push({ n: it.n, id: it.content_id, account_id: it.account_id, status: 'failed', error: e.message });
      fail++;
    }
  }

  doc.injected = ok;
  doc.inject_skipped = skip;
  doc.inject_failed = fail;
  doc.gate_blocked = skippedGate;
  doc.finishedAt = new Date().toISOString();
  fs.writeFileSync(batchFile, JSON.stringify(doc, null, 1), 'utf8');

  log(`\n═══ 批次完成 ═══`);
  log(`  注入成功 ${ok} · 已存在跳过 ${skip} · 门禁拦下 ${skippedGate} · 失败 ${fail} · 配图 ${doc.art_ok}/${doc.items.length}`);
  log(`  记录: ${batchFile}`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\n❌ 批次失败: ${e.message}`);
  process.exit(1);
});
