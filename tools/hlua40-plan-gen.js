#!/usr/bin/env node
'use strict';
/**
 * hlua40-plan-gen.js v2 — 「40 账号 × 早晚各 1 篇 × 主推一位达人 × 找聊天伙伴」7 天排期生成器
 *                        （确定性、可复算、带断言）
 *
 * 用户诉求 → 数学：
 *   · 40 个活跃账号，每天早晚各 1 篇 ⇒ 80 槽/天
 *   · 每一篇主题不同、内容不同、标签不同 ⇒「组合唯一性」断言，不是文案承诺
 *   · 每一篇主推一位首页达人 ⇒ 每篇绑定 (达人, 功能角度, 体裁) 三元组
 *   · v2 新增：**每一篇引用该达人的一条真实作品**（视频优先）⇒ refs 来自抓取数据
 *   · v2 新增：话术为**第一人称征友 / 找聊天伙伴**（一个人无聊 → 主动邀聊 → 来聊）
 *
 * 组合空间：
 *   SPACE = 达人 40 × 功能角度 20 × 体裁 7 = 5600
 *   单游标 + 步长 13（gcd(13,5600)=1）⇒ 连续 5600 次抽样两两不同；本窗口 560 槽 ⇒ 富余 10 倍
 *   ⚠️ 反面教材（已实测踩过）：按维度各自取互质步长（anchor=(k*7)%12、genre=(k*3)%7）
 *      的联合周期只有 lcm = 84 ⇒ 第 3 天开始复读。**多个「各自互质」推不出联合不重复**。
 *
 * 引用素材（v2）：
 *   达人池里每位达人带 refs[]，kind ∈ {video-file, video-post, video-cdn, image-post}。
 *   30/40 位达人有真实视频作品；10 位无视频 ⇒ 降级引用其图片作品，且**句式不同**
 *   （绝不把图片说成视频）。refs 全部来自 D:/alua_scraped_data 抓取结果，**不构造 URL**。
 *
 * 账号↔槽位：slot s ∈ [0,80) → 账号 = [s % 40]，时段 = s<40 ? morning : evening
 *   同日同达人的两篇相隔 40 槽 ⇒ Δj = 13×40 mod 5600 = 520；520 mod 7 = 2 ≠ 0
 *   ⇒ 引用句式与 when 短语必然不同（已由断言 9 实测），同一达人的两篇不会读起来一样。
 *
 * 语言：**英文唯一**（Tumblr 主受众）。中文仅出现在本文件内部注释与聚合 key。
 *
 * 用法：
 *   node tools/hlua40-plan-gen.js                 # 打印 Day1 排期 + 统计
 *   node tools/hlua40-plan-gen.js --check         # 只跑断言（失败退出码非 0）
 *   node tools/hlua40-plan-gen.js --json          # 写出 reports/hlua40-schedule-7d.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const REPORTS = path.join(ROOT, 'reports');

const BRAND = 'hlua.cc.cd';
const SITE = 'https://www.hlua.cc.cd/';
const DAYS = 7;
const SLOTS_PER_DAY = 80;      // 40 账号 × 2 时段
const MORNING_SIZE = 40;

// ── 功能角度：取自站点真实结构（sitemap + 首页文案）────────────────────
//    sitemap: / /app /landing /creators /blog /pricing /referral /ai-chat
//             /about /safety /terms /privacy  ·  首页: "Discover Exclusive
//             Creators & Premium Content"、"Dating, reimagined by emotional AI"
const ANGLES = [
  { key: 'creator-discovery',  feature: '/creators',  theme: 'How to find creators who actually match your vibe',      hook: 'Discovery is the hardest part of any creator  — here is how the directory is organised.', tags: ['creatordiscovery', 'findyourcreator', 'creatordirectory', 'hlua', 'onlinematch'] },
  { key: 'creator-spotlight',  feature: '/creators',  theme: 'Creator spotlight: {name}',                              hook: '{name} is one of the profiles people keep coming back to — here is why.',                       tags: ['creatorspotlight', 'profileoftheday', '{nametag}', 'hlua', 'meetcreators'] },
  { key: 'ai-chat',            feature: '/ai-chat',   theme: 'What emotional-AI chat actually changes in dating',      hook: 'Not another chatbot: the point is emotional context carrying across conversations.',            tags: ['aichat', 'emotionalai', 'aicompanion', 'hlua', 'chattech'] },
  { key: 'always-on',          feature: '/ai-chat',   theme: 'The 2am problem: who is actually awake to talk to',      hook: 'Companionship should not be limited by the other side of the world being asleep.',              tags: ['alwayson', 'lateNightChat', 'neveralone', 'hlua', '247chat'] },
  { key: 'emotional-matching', feature: '/',          theme: 'Dating, reimagined by emotional AI',                     hook: 'Matching on emotional signals instead of a swipe counter.',                                    tags: ['emotionaldating', 'smartmatching', 'aiding', 'hlua', 'modernDating'] },
  { key: 'premium-content',    feature: '/pricing',   theme: 'What "premium content" means on a creator ',     hook: 'The difference between the free layer and the subscriber layer, honestly explained.',           tags: ['premiumcontent', 'subscriberperks', 'creator', 'hlua', 'membership'] },
  { key: 'subscription-value', feature: '/pricing',   theme: 'Subscription maths: what you actually get per month',    hook: 'Breaking down a membership into what it unlocks day to day.',                                  tags: ['subscriptionvalue', 'membershipmath', 'worthit', 'hlua', 'premiumchat'] },
  { key: 'free-start',         feature: '/pricing',   theme: 'Starting free is the whole point',                       hook: 'You can browse and chat before you ever think about paying.',                                  tags: ['startfree', 'freetochat', 'trybeforeyoupay', 'hlua', 'noCardNeeded'] },
  { key: 'app-experience',     feature: '/app',        theme: 'Inside the app: three things people use every day',     hook: 'A walk through the parts of the product that get opened daily.',                               tags: ['appwalkthrough', 'dailyapp', 'producttour', 'hlua', 'apptips'] },
  { key: 'mobile-ready',       feature: '/landing',    theme: 'Desktop or phone — same account, same conversations',   hook: 'Why the flow was built mobile-first and what that changes.',                                   tags: ['mobilefirst', 'anydevice', 'seamlesschat', 'hlua', 'ondemand'] },
  { key: 'safety-verified',    feature: '/safety',     theme: 'Verified creators and the 18+ line',                    hook: 'Age checks and verification exist for a reason — here is how they work.',                      tags: ['creatorsafety', 'verifiedcreators', '18plus', 'hlua', 'trustandsafety'] },
  { key: 'privacy-first',      feature: '/privacy',    theme: 'What a creator  should never do with your data', hook: 'A short, non-lawyerly read of the privacy basics that matter.',                              tags: ['privacyfirst', 'dataprivacy', 'securechat', 'hlua', 'privacybasics'] },
  { key: 'referral-rewards',   feature: '/referral',   theme: 'Invite culture: how referral rewards actually work',    hook: 'The mechanics of invite rewards, without the hype.',                                           tags: ['referralrewards', 'invitefriends', 'shareandearn', 'hlua', 'rewards'] },
  { key: 'blog-guides',        feature: '/blog',        theme: 'The guides worth reading before you subscribe',         hook: 'Three reads that make the first week on a creator  much better.',                     tags: ['creatorguides', 'howtoguide', 'readfirst', 'hlua', 'tips'] },
  { key: 'creator-economy',    feature: '/creators',   theme: 'What creators actually earn on (and get from) a ', hook: 'Payouts, audience ownership and why creators pick one  over another.',              tags: ['creatoreconomy', 'creatorincome', 'behindthescenes', 'hlua', 'creatorsupport'] },
  { key: 'niche-cosplay',      feature: '/creators',   theme: 'Cosplay and anime creators are quietly winning discovery', hook: 'Why costume-and-character creators convert followers so well.',                             tags: ['cosplay', 'animecreators', 'cosplaycommunity', 'hlua', 'characterart'] },
  { key: 'niche-fitness',      feature: '/creators',   theme: 'Fitness and lifestyle creators: the daily-post formula', hook: 'Consistency beats production value — the data from lifestyle profiles.',                       tags: ['fitnesscreator', 'lifestylecreator', 'dailyprogress', 'hlua', 'wellnessjourney'] },
  { key: 'niche-photography',  feature: '/creators',   theme: 'Editorial photography creators and the lighting obsession', hook: 'What separates a profile that looks premium from one that does not.',                       tags: ['editorialphotography', 'photographycreator', 'lightingmatters', 'hlua', 'portraitwork'] },
  { key: 'niche-gaming',       feature: '/creators',   theme: 'Game streaming creators on creator s',           hook: 'Streamers are using companion s to keep the conversation going after stream.',          tags: ['gamingcreator', 'streamerlife', 'communitybuilding', 'hlua', 'afterstream'] },
  { key: 'chat-etiquette',     feature: '/ai-chat',    theme: 'How to open a conversation that does not get ignored',   hook: 'The first three lines decide everything — a practical checklist.',                              tags: ['chatetiquette', 'firstmessage', 'conversationstarters', 'hlua', 'dmTips'] },
];

const GENRES = [
  { key: 'question',   shape: '{theme} — what is your take?' },
  { key: 'listicle',   shape: '{theme}: 3 things worth knowing' },
  { key: 'contrast',   shape: '{theme} (before vs after)' },
  { key: 'story',      shape: 'The day {theme} finally clicked' },
  { key: 'data',       shape: '{theme}: the numbers people miss' },
  { key: 'tip',        shape: 'One tip that fixes this: {theme}' },
  { key: 'dialogue',   shape: 'Two people, one screen: {theme}' },
];

// ── v2 话术池 A：开场 —— 「一个人无聊」（第一人称，7~8 词起）──────────────
const OPENERS = [
  'It is late, the flat is quiet and I am bored out of my mind.',
  'Everyone I know went to bed two hours ago and I am still wide awake.',
  'Sitting here alone with my phone and nothing planned tonight.',
  'I have been staring at the same four walls all evening.',
  'Nobody to talk to tonight and I am going a little stir-crazy.',
  'Weeknight, home alone, and honestly I just want someone to talk to.',
  'My plans fell through and now it is just me and a quiet room.',
  'I am not tired and I am not busy — I am just here, on my own.',
  'Another evening, another silent phone. I would rather be talking to someone.',
  'One of those nights where being alone feels louder than usual.',
];

// ── v2 话术池 B：邀聊 —— 「主动找聊天伙伴 / 找男友」───────────────────────
const ASKS = [
  'So — is anyone actually up for a real conversation tonight?',
  'I am not collecting followers. I want someone to talk to, properly.',
  'If you are the kind of guy who actually replies, I am right here.',
  'Who wants to keep me company for a bit?',
  'Tell me I am not the only one awake right now.',
  'Talk to me like a person, not like a subscriber.',
  'Say hi if you would rather have a real chat than another scroll.',
  'I would love someone who texts back. That is genuinely the whole ask.',
  'Anyone want to be the reason I put my phone down smiling?',
  'Come and talk to me — I am better company than I look tonight.',
];

// ── v2 话术池 C：引用作品（视频优先；图片走独立句式，不冒充视频）──────────
const REF_STYLES_VIDEO = [
  'I posted a clip {when} that says it better than I can — {url}',
  'There is a video on my page from {when} — {url}',
  'Watch the one I filmed {when}, then come and talk to me — {url}',
  'This is the clip people keep messaging me about — {url}',
  'I put a new video up {when}, go look and then say hi — {url}',
  'My post from {when} is the honest version of me — {url}',
  'Start with the video I uploaded {when} — {url}',
];

const REF_STYLES_IMAGE = [
  'I posted a new photo set {when} — {url}',
  'The pictures from {when} are still my favourite — {url}',
  'Have a look at what I uploaded {when} — {url}',
];

const WHEN_PHRASES = ['this morning', 'last night', 'yesterday', 'two days ago', 'last week', 'earlier today', 'the other night'];

// ── v2 话术池 D：落地（第一人称，仍以「来聊」为核心，不做硬广）────────────
const CTAS = [
  'I am on hlua.cc.cd — message me there.',
  'Find me on hlua.cc.cd and say hi.',
  'Talk to me on hlua.cc.cd, I answer everyone.',
  'My chat is open on hlua.cc.cd.',
  'hlua.cc.cd — come and find me.',
  'I reply on hlua.cc.cd, not in the comments.',
  'Come talk to me on hlua.cc.cd.',
  'hlua.cc.cd is where I actually chat.',
];

// ── v2 标题前缀（征友口吻；不影响三元组唯一性）────────────────────────────
const TITLE_PREFIXES = [
  'Bored tonight: ',
  'Alone and online: ',
  'Talk to me: ',
  'Anyone up? ',
  'Late-night ask: ',
  'Keeping it honest: ',
  'One person short of a conversation: ',
];

const SPACE = 40 * ANGLES.length * GENRES.length;   // 40 × 20 × 7 = 5600
const STRIDE = 13;                                  // gcd(13, 5600) = 1

 loadJSON(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

const pick = (arr, i) => arr[((i % arr.length) + arr.length) % arr.length];

 buildSchedule(Dir, creatorsDir) {
  const acc = loadJSON(path.join(REPORTS, Dir));
  const cre = loadJSON(path.join(REPORTS, creatorsDir));
  if (!acc || !acc. || acc..length !== 40) throw new Error(' 池必须恰好 40 个（先跑 tools/hlua40-pool.js --write）');
  if (!cre || !cre.creators || cre.creators.length !== 40) throw new Error('达人池必须恰好 40 位（先跑 tools/hlua40-pool.js --write）');

  const  = acc..map((a) => a.account_id);
  const creators = cre.creators.map((c) => ({
    user_id: c.user_id,
    name: c.name,
    category: c.category,
    refs: (c.refs || []).filter((r) => r && r.url),
    local_videos: c.local_videos || [],
  }));
  const creatorOf = (j) => creators[j % creators.length];
  const angleOf = (j) => ANGLES[Math.floor(j / creators.length) % ANGLES.length];
  const genreOf = (j) => GENRES[Math.floor(j / (creators.length * ANGLES.length)) % GENRES.length];

  const slots = [];
  for (let d = 0; d < DAYS; d++) {
    for (let s = 0; s < SLOTS_PER_DAY; s++) {
      const g = d * SLOTS_PER_DAY + s;          // 全局游标：跨天连续 ⇒ 窗口内唯一
      const j = (g * STRIDE) % SPACE;
      const creator = creatorOf(j);
      const angle = angleOf(j);
      const genre = genreOf(j);
      const session = s < MORNING_SIZE ? 'morning' : 'evening';
      const account = [s % .length];
      const nametag = creator.name.toLowerCase().replace(/[^a-z0-9]/g, '');

      // ── 引用素材：优先视频类，图片类降级走独立句式 ──
      const vidRefs = creator.refs.filter((r) => r.kind !== 'image-post');
      const pool = vidRefs.length ? vidRefs : creator.refs;
      const ref = pool.length ? pool[j % pool.length] : null;
      const isVideo = !!(ref && ref.kind !== 'image-post');
      const refStyle = pick(isVideo ? REF_STYLES_VIDEO : REF_STYLES_IMAGE, j);
      const refWhen = pick(WHEN_PHRASES, Math.floor(j / 8));
      const refLine = ref
        ? refStyle.replace('{when}', refWhen).replace('{url}', ref.url)
        : '';

      const tags = Array.from(new Set([
        nametag,
        `${genre.key}format`,
        ...angle.tags.filter((t) => !t.includes('{nametag}')),
        creator.category.replace(/_/g, ''),
        session === 'morning' ? 'morningread' : 'eveningvibes',
      ])).slice(0, 7);

      const opener = pick(OPENERS, j);
      const ask = pick(ASKS, Math.floor(j / 3));
      const cta = pick(CTAS, Math.floor(j / 5));
      const theme = angle.theme.replace('{name}', creator.name);
      const baseTitle = genre.shape.replace('{theme}', theme);
      const titleCore = theme.includes(creator.name) ? baseTitle : `${baseTitle} · ${creator.name}`;

      slots.push({
        slot_id: `hlua40-d${d + 1}-${session}-${String(s % 40 + 1).padStart(2, '0')}`,
        day: d + 1,
        session,
        account_id: account,
        creator_name: creator.name,
        creator_category: creator.category,
        creator_user_id: creator.user_id,
        angle_key: angle.key,
        angle_feature: angle.feature,
        genre_key: genre.key,
        combo_index: j,
        topic_signature: `${creator.name}|${angle.key}|${genre.key}`,
        title_en: `${pick(TITLE_PREFIXES, j)}${titleCore}`,
        hook_en: angle.hook.replace('{name}', creator.name),
        // ── v2 帖子四段（找聊天伙伴口吻）──
        opener_en: opener,
        ref_line_en: refLine,
        ask_en: ask,
        body_en: [opener, refLine, ask, cta].filter(Boolean).join('\n\n'),
        cta_en: cta,
        // ── v2 作品引用（真实抓取，不构造）──
        social_ref: ref ? { kind: ref.kind, url: ref.url, ref_id: ref.ref_id, creator_user_id: creator.user_id } : null,
        social_ref_kind: isVideo ? 'video' : 'image',
        social_ref_style: refStyle.replace('{url}', '').replace('{when}', '').trim(),
        social_ref_when: isVideo ? refWhen : '',
        local_video: (creator.local_videos || [])[0] || '',
        tags,
        brand: BRAND,
        site: SITE,
      });
    }
  }
  return { slots, , creators };
}

// ── 断言（失败即非 0 退出码，供 CI / 复算）─────────────────────────────
 assertAll(slots, creators) {
  const fails = [];
  const ok = (name, cond, detail) => { console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); if (!cond) fails.push(name); };

  // 1. 全周期三元组零重复（核心）
  const sig = slots.map((s) => s.topic_signature);
  ok('1) 全周期 (达人|角度|体裁) 零重复', new Set(sig).size === slots.length, `${new Set(sig).size}/${slots.length} 唯一`);

  // 2. 单日零重复
  let dayBad = 0;
  for (let d = 1; d <= DAYS; d++) {
    const day = slots.filter((s) => s.day === d).map((s) => s.topic_signature);
    if (new Set(day).size !== day.length) dayBad++;
  }
  ok('2) 单日零重复', dayBad === 0, `异常天数 ${dayBad}`);

  // 3. 每账号每日恰好 2 篇（早/晚各 1）
  const perKey = new Map();
  for (const s of slots) {
    const k = `${s.day}|${s.account_id}`;
    const v = perKey.get(k) || { n: 0, morning: 0, evening: 0 };
    v.n++; v[s.session]++;
    perKey.set(k, v);
  }
  const badAcc = [...perKey.entries()].filter(([, v]) => v.n !== 2 || v.morning !== 1 || v.evening !== 1);
  ok('3) 每账号每日恰好早晚各 1', badAcc.length === 0, `账号-日组合 ${perKey.size} 个，异常 ${badAcc.length}`);

  // 4. 角度/体裁/达人 全覆盖
  ok('4) 功能角度全覆盖(20)', new Set(slots.map((s) => s.angle_key)).size === ANGLES.length, `${new Set(slots.map((s) => s.angle_key)).size}/${ANGLES.length}`);
  ok('4b) 体裁全覆盖(7)', new Set(slots.map((s) => s.genre_key)).size === GENRES.length, `${new Set(slots.map((s) => s.genre_key)).size}/${GENRES.length}`);
  ok('4c) 达人全覆盖(40)', new Set(slots.map((s) => s.creator_name)).size === 40, `${new Set(slots.map((s) => s.creator_name)).size}/40`);

  // 5. 标签组合唯一
  const tagFp = slots.map((s) => s.tags.slice().sort().join(','));
  ok('5) 标签组合唯一率 100%', new Set(tagFp).size === slots.length, `${(new Set(tagFp).size / slots.length * 100).toFixed(1)}%`);

  // 5b. 标题唯一
  ok('5b) 标题唯一率 100%', new Set(slots.map((s) => s.title_en)).size === slots.length, `${new Set(slots.map((s) => s.title_en)).size}/${slots.length}`);

  // 6. 同一达人当天两篇主题必不同
  let sameBad = 0;
  for (let d = 1; d <= DAYS; d++) {
    const byCreator = new Map();
    for (const s of slots.filter((x) => x.day === d)) {
      const arr = byCreator.get(s.creator_name) || [];
      arr.push(s.angle_key + '|' + s.genre_key);
      byCreator.set(s.creator_name, arr);
    }
    for (const [, arr] of byCreator) if (arr.length === 2 && arr[0] === arr[1]) sameBad++;
  }
  ok('6) 同一达人当日两篇主题不同', sameBad === 0, `冲突 ${sameBad}`);

  // ── v2 断言：作品引用 ──
  const noRef = slots.filter((s) => !s.social_ref || !s.social_ref.url);
  ok('7) 每篇均引用达人作品（URL 非空）', noRef.length === 0, `${slots.length - noRef.length}/${slots.length} 篇有引用`);

  const refKind = {};
  for (const s of slots) refKind[s.social_ref_kind] = (refKind[s.social_ref_kind] || 0) + 1;
  ok('7b) 视频引用占比 ≥ 70%', (refKind.video || 0) / slots.length >= 0.7, JSON.stringify(refKind));

  // 8. 引用句式覆盖
  const styles = new Set(slots.filter((s) => s.social_ref_kind === 'video').map((s) => s.social_ref_style));
  ok('8) 视频引用句式覆盖 ≥ 7 种', styles.size >= 7, `${styles.size} 种`);

  // 9. 同一达人同日两篇的引用句子不同（Δj=520 ⇒ 520%7=2≠0 的直接后果）
  let dupRef = 0;
  for (let d = 1; d <= DAYS; d++) {
    const byCreator = new Map();
    for (const s of slots.filter((x) => x.day === d)) {
      const arr = byCreator.get(s.creator_name) || [];
      arr.push(s.ref_line_en);
      byCreator.set(s.creator_name, arr);
    }
    for (const [, arr] of byCreator) if (arr.length === 2 && arr[0] === arr[1]) dupRef++;
  }
  ok('9) 同一达人同日两篇引用句不同', dupRef === 0, `重复 ${dupRef}`);

  // 9b. 引用 URL 必须来自达人池 refs（防伪造）
  const allowed = new Set();
  for (const c of creators) for (const r of (c.refs || [])) allowed.add(r.url);
  const forged = slots.filter((s) => s.social_ref && !allowed.has(s.social_ref.url));
  ok('9b) 引用 URL 全部可溯源（零伪造）', forged.length === 0, `不可溯源 ${forged.length}`);

  // 10. 发布字段 CJK 残留（英文唯一）
  const FIELDS = ['title_en', 'hook_en', 'opener_en', 'ref_line_en', 'ask_en', 'cta_en', 'body_en'];
  let cjk = 0;
  for (const s of slots) {
    const blob = FIELDS.map((f) => String(s[f] || '')).join(' ') + ' ' + s.tags.join(' ');
    cjk += (blob.match(/[\u4e00-\u9fff\u3000-\u303f]/g) || [];
  }
  ok('10) 发布字段 CJK 残留 0 处', cjk === 0, `命中 ${cjk}`);

  // 11. 话术池覆盖（开场 / 邀聊 / 落地 都不得只用 1~2 句）
  ok('11) 开场话术覆盖 ≥ 10 种', new Set(slots.map((s) => s.opener_en)).size >= OPENERS.length, `${new Set(slots.map((s) => s.opener_en)).size} 种`);
  ok('11b) 邀聊话术覆盖 ≥ 10 种', new Set(slots.map((s) => s.ask_en)).size >= ASKS.length, `${new Set(slots.map((s) => s.ask_en)).size} 种`);
  ok('11c) 落地话术覆盖 ≥ 8 种', new Set(slots.map((s) => s.cta_en)).size >= CTAS.length, `${new Set(slots.map((s) => s.cta_en)).size} 种`);

  // 12. 四段齐全（无空段）
  const emptySeg = slots.filter((s) => !s.opener_en || !s.ref_line_en || !s.ask_en || !s.cta_en);
  ok('12) 帖子四段齐全（开场/引用/邀聊/落地）', emptySeg.length === 0, `缺段 ${emptySeg.length}`);

  return fails;
}

 main() {
  const argv = process.argv.slice(2);
  const { slots, , creators } = buildSchedule('hlua40-.json', 'hlua40-creators.json');
  const fails = assertAll(slots, creators);

  if (argv.includes('--check')) process.exit(fails.length ? 1 : 0);

  if (argv.includes('--json')) {
    const out = {
      generatedAt: new Date().toISOString(),
      campaign: 'hlua40',
      version: 2,
      site: SITE,
      brand: BRAND,
      days: DAYS,
      slots_per_day: SLOTS_PER_DAY,
      total_slots: slots.length,
      language_policy: 'en-only',
      zh_fields_role: '本文件不含中文字段；angles/genres 的内部 key 仅用于聚合与断言',
      tone: 'first-person chat-seeking (lonely-at-night → open invitation → come talk)',
      ref_policy: '每篇引用该达人的一条真实作品；video 优先，缺视频者降级引用图片且句式不同（不冒充视频）',
      space: SPACE,
      stride: STRIDE,
      dimensions: { creators: creators.map((c) => c.name), angles: ANGLES.map((a) => a.key), genres: GENRES.map((g) => g.key) },
      refs_coverage: {
        with_video_ref: creators.filter((c) => (c.refs || []).some((r) => r.kind !== 'image-post'),
        only_image_ref: creators.filter((c) => !(c.refs || []).some((r) => r.kind !== 'image-post'),
        with_local_video: creators.filter((c) => (c.local_videos || [] > 0,
      },
      ,
      slots,
    };
    fs.writeFileSync(path.join(REPORTS, 'hlua40-schedule-7d.json'), JSON.stringify(out, null, 2), 'utf8');
    console.log('\n写出 reports/hlua40-schedule-7d.json —', slots.length, '槽');
  }

  console.log('\n── Day1 早批（前 5 槽）────────────────────────────────────');
  for (const s of slots.slice(0, 5)) {
    console.log(`  ${s.slot_id.padEnd(30)} ${s.account_id.padEnd(15)} ${s.creator_name.padEnd(16)} ${s.genre_key.padEnd(9)} [${s.social_ref_kind}] ${s.title_en.slice(0, 46)}`);
    console.log(`      开场: ${s.opener_en}`);
    console.log(`      引用: ${s.ref_line_en}`);
    console.log(`      邀聊: ${s.ask_en}`);
    console.log(`      落地: ${s.cta_en}`);
  }
  const refKind = {};
  for (const s of slots) refKind[s.social_ref_kind] = (refKind[s.social_ref_kind] || 0) + 1;
  console.log(`\n账号 ${.length} · 达人 ${creators.length} · 角度 ${ANGLES.length} · 体裁 ${GENRES.length} · SPACE=${SPACE} · STRIDE=${STRIDE}`);
  console.log(`7 天总槽位 ${slots.length} · 唯一主题 ${new Set(slots.map((s) => s.topic_signature)).size} · 引用分布 ${JSON.stringify(refKind)}`);
}

main();
