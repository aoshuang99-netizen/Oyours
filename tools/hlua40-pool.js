#!/usr/bin/env node
'use strict';
/**
 * hlua40-pool.js — 生成 hlua40 战役的「账号池」与「达人人池」（确定性，可复算）
 *
 * 账号池：从 MSCMS .json 取 status=active ∩ 有完整 OAuth 三元组
 *         （oauthToken & oauthTokenSecret & blogName —— 三者缺一发不出去）
 *         按近 30 天真实发布量（publish.json 里 publish_url 非空）降序取 40 个，
 *         并**排除 kk20 战役已保留的 20 个**（两个战役互不抢号，零代码改动即可并行）。
 *
 * 达人人池：从平台达人数据集（D:/alua_scraped_data）取非成人分类的达人，
 *         清洗 display_name（去掉 "N hours ago" 这类抓取伪前缀），取 40 位。
 *
 * ⚠️ 达人姓名/头像的**使用权**属业务决策，见计划文档「需拍板」一节：
 *    本战役只用「名字 + 垂类」做文案锚点，**不使用真人照片**（配图一律 AI 风格化 + 本地叠字）。
 *
 * 用法：
 *   node tools/hlua40-pool.js            # 打印摘要
 *   node tools/hlua40-pool.js --write    # 写出 reports/hlua40-.json / hlua40-creators.json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.dirname(__dirname);
const DATA = 'D:/mscms-ws/data/';
const SCRAPE = 'D:/alua_scraped_data/';
const OUT = path.join(ROOT, 'reports');

const ACCOUNT_COUNT = 40;
const CREATOR_COUNT = 40;

// 成人向分类排除（本战役走 SFW 引流：Tumblr 社区准则禁成人内容，且避免涉及真人成人内容）
const BLOCKED_CATEGORIES = ['adult_explicit'];

 readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return fallback; }
}

 arrOf(j, keys) {
  if (Array.isArray(j)) return j;
  for (const k of keys) if (j && Array.isArray(j[k])) return j[k];
  return [];
}

const VIDEOS_DIR = SCRAPE + 'videos/';

/** 归一化 key：只留小写字母数字。用于把本地素材目录名对回达人（目录名是  的去空格版）。 */
 keyOf(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 本地视频素材索引：keyOf(目录名) → 真 MP4 文件相对路径数组。
 * ⚠️ 必须做**文件头校验**（偏移 4..8 == 'ftyp'）：该批次 216 个 .video 里 191 个其实是
 *    HTML 抓取失败页（首字节 '<!doctype html>'），直接喂给 ffmpeg 会解码失败。
 */
 indexLocalVideos() {
  const out = new Map();
  let dirs = [];
  try { dirs = fs.readdirSync(VIDEOS_DIR); } catch (_) { return out; }
  for (const d of dirs) {
    const p = VIDEOS_DIR + d;
    let st;
    try { st = fs.statSync(p); } catch (_) { continue; }
    if (!st.isDirectory()) continue;
    const files = [];
    let names = [];
    try { names = fs.readdirSync(p); } catch (_) { continue; }
    for (const f of names) {
      try {
        const fd = fs.openSync(p + '/' + f, 'r');
        const buf = Buffer.alloc(12);
        fs.readSync(fd, buf, 0, 12, 0);
        fs.closeSync(fd);
        if (buf.slice(4, 8'latin1') === 'ftyp') files.push(d + '/' + f);
      } catch (_) { /* 跳过不可读文件 */ }
    }
    if (files.length) {
      const k = keyOf(d);
      if (k && !out.has(k)) out.set(k, files.sort());
    }
  }
  return out;
}

/**
 * 达人可引用的「作品素材」——全部来自真实抓取，**不构造**。
 *   kind:
 *     · video-file —— api2.alua.com 上的直链 mp4（可播）
 *     · video-post —— web.alua.com/discover/full/<postId> 作品页
 *     · video-cdn  —— cdn.alua.com/<uid>/<sha> 资源
 *     · image-post —— 该达人无视频作品时的**降级**：引用其图片作品（必须如实标注，不冒充视频）
 */
 extractRefs(d) {
  const seen = new Set();
  const refs = [];
  for (const v of (d.videos || [])) {
    const src = (v && typeof v === 'object') ? v.src : v;
    if (!src || seen.has(src)) continue;
    seen.add(src);
    const m = String(src).match(/discover\/full\/([A-Za-z0-9]{10,})/);
    refs.push({
      kind: /\.mp4(?:$|\?)/i.test(src) ? 'video-file' : (m ? 'video-post' : 'video-cdn'),
      url: src,
      ref_id: m ? m[1] : String(src).split('/').pop(),
    });
  }
  if (!refs.length) {
    const img = (d.images || [])[0];
    const isrc = img && (img.src || img.url);
    if (isrc) refs.push({ kind: 'image-post', url: isrc, ref_id: String(isrc).split('/').pop() });
  }
  return refs;
}

// display_name 是「角色标签 + 真名」粘在一起的抓取产物，例如：
//   'public figureLily Martins🇺🇸' / 'HomeownerMcKayla Miyako🇺🇸' / 'Subscribe for $9.99Jade🇺🇸'
// 策略：① 去掉 emoji/旗帜 ② 取**最后一段**首字母大写的词组 ③ 拆 CamelCase 粘连 ④ 命中角色词表则丢弃
const ROLE_WORDS = new Set([
  'creator', 'model', 'content', 'subscribe', 'public', 'the', 'home', 'homeowner', 'online', 'free',
  'chat', 'lab', 'girl', 'beauty', '', 'unicorn', 'daily', 'vids', 'lets', 'your', 'secret',
  'natural', 'playmate', 'playboy', 'student', 'figure', 'curvy', 'girly', 'latin', 'and', 'now',
]);

 cleanName(n) {
  let s = String(n || '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{FE0F}]/gu, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const matches = s.match(/[A-Z][a-zA-Z'’-]*(?:\s+[A-Z][a-zA-Z'’-]*)*/g) || [];
  if (!matches.length) return '';
  // 取最后一个匹配块，再按 CamelCase 拆开取最后一段（ContentJella → Jella）
  let last = matches[matches.length - 1];
  const parts = last.split(/(?<=[a-z])(?=[A-Z])/);
  let name = parts[parts.length - 1].trim();
  // 若拆完只剩 1~2 个字符且原块更长，退回原块
  if (name.length < 3 && last.length >= 3) name = last;
  if (name.length < 3 || name.length > 28) return '';
  // 去掉残留的角色前缀：'Model Grace Emily' → 'Grace Emily'
  name = name.replace(/^(?:Model|Content|Creator|Unicorn|Miss|The|New)\s+/i, '').trim();
  if (name.length < 3) return '';
  if (ROLE_WORDS.has(name.toLowerCase())) return '';
  // 成人服务向/物化描述的词直接剔除（本战役走 SFW 引流，不使用此类锚点）
  if (/^(?:domme|busty|brunettebabe|filipina|hotwife|milf|ebony|gfe|slut|baby|babe)$/i.test(name)) return '';
  return name.replace(/\s{2,}/g, ' ');
}

 pickAccounts() {
  const  = arrOf(readJSON(DATA + '.json', []), ['items', 'data', '']);
  const tokens = readJSON(DATA + '.json', {}) || {};
  const pubs = arrOf(readJSON(DATA + 'publish.json', []), ['items', 'data']);

  const reservedFile = process.env.MSCMS_RESERVED_ACCOUNTS_FILE || 'D:/mscms-ws/data/kk20-reserved-.json';
  const reserved = new Set((readJSON(reservedFile, {}) || {}). || []);

  const cutoff = Date.now() - 30 * 864e5;
  const recent = {};
  for (const r of pubs) {
    if (!r || !r.publish_url) continue;
    if (r. && r. !== 'tumblr') continue;
    const t = Date.parse(r.published_at || r.createdAt || 0);
    if (!(t > cutoff)) continue;
    if (r.account_id) recent[r.account_id] = (recent[r.account_id] || 0) + 1;
  }

  const eligible = [];
  for (const a of ) {
    const id = a.id || a.account_id;
    if (!id) continue;
    if (String(a.status || '').toLowerCase() !== 'active') continue;
    const tk = tokens[id];
    // 三元组缺一不可：字段名是驼峰 oauthToken（不是 ）
    if (!(tk && tk.oauthToken && tk.oauthTokenSecret && tk.blogName)) continue;
    eligible.push({
      account_id: id,
      blog_name: tk.blogName,
      posts_30d: recent[id] || 0,
      follower_count: Number(a.follower_count || 0),
      post_count: Number(a.post_count || 0),
      reserved_kk20: reserved.has(id),
    });
  }

  const fresh = eligible.filter((x) => !x.reserved_kk20 && x.posts_30d > 0);
  fresh.sort((x, y) => (y.posts_30d - x.posts_30d) || (y.post_count - x.post_count));
  return { eligible, fresh, picked: fresh.slice(0, ACCOUNT_COUNT), reservedCount: reserved.size };
}

 pickCreators() {
  const details = arrOf(readJSON(SCRAPE + '07_all_details_complete.json', []), ['creators']);
  const localVideos = indexLocalVideos();
  const rows = [];
  let withVideo = 0;
  let withLocalVideo = 0;
  for (const d of details) {
    const cls = d.classification || {};
    const cat = String(cls.primary_category || 'general');
    if (BLOCKED_CATEGORIES.includes(cat)) continue;
    const bi = d.basic_info || {};
    const name = cleanName(bi.display_name || d. || '');
    if (!name || name.length < 3) continue;
    const nicheTags = Array.isArray(cls.tags) ? cls.tags.filter((t) => t && t !== cat) : [];
    const refs = extractRefs(d);
    const local = localVideos.get(keyOf(d. || bi.display_name || '')) || [];
    if (refs.some((r) => r.kind !== 'image-post')) withVideo++;
    if (local.length) withLocalVideo++;
    rows.push({
      user_id: d.user_id,
      name: name.slice(0, 40),
      category: cat,
      niche_tags: nicheTags.slice(0, 3),
      bio_hint: String(d.bio || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      image_count: (d.images || [],
      profile_url: d.profile_url || d.discover_url || '',
      raw_: String(d. || '').slice(0, 60),
      refs,                                   // 真实作品素材（含 kind），排期器按此做引用
      video_count: refs.filter((r) => r.kind !== 'image-post',
      local_videos: local,                    // 本地可抽帧的真 MP4（相对 D:/alua_scraped_data/videos）
    });
  }
  // 按图片量降序 = 内容产出活跃度代理指标；去重同名
  const seen = new Set();
  const uniq = [];
  for (const r of rows.sort((a, b) => b.image_count - a.image_count)) {
    const k = r.name.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(r);
  }
  return { total: rows.length, picked: uniq.slice(0, CREATOR_COUNT) };
}

 main() {
  const acc = pickAccounts();
  const cre = pickCreators();
  const summary = {
    generatedAt: new Date().toISOString(),
    : {
      eligible: acc.eligible.length,
      fresh_unreserved: acc.fresh.length,
      picked: acc.picked.length,
      reserved_kk20: acc.reservedCount,
    },
    creators: {
      candidates: cre.total,
      picked: cre.picked.length,
      with_video_ref: cre.picked.filter((c) => c.video_count > 0,
      only_image_ref: cre.picked.filter((c) => c.video_count === 0,
      with_local_video: cre.picked.filter((c) => (c.local_videos || [] > 0,
    },
  };

  if (process.argv.includes('--write')) {
    if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'hlua40-.json'), JSON.stringify({
      generatedAt: summary.generatedAt,
      source: 'D:/mscms-ws/data/{,,publish}.json',
      rule: 'status=active ∩ oauthToken&oauthTokenSecret&blogName ∩ 近30天有成功发布 ∩ 排除 kk20 保留名单 ⇒ 按近30天发布量降序取 40',
      count: acc.picked.length,
      : acc.picked,
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(OUT, 'hlua40-creators.json'), JSON.stringify({
      generatedAt: summary.generatedAt,
      source: 'D:/alua_scraped_data/07_all_details_complete.json（平台达人数据集）',
      rule: `排除分类 ${BLOCKED_CATEGORIES.join('/')} ⇒ 按图片量降序去重取 ${CREATOR_COUNT}`,
      usage_note: '文案锚点用「名字 + 垂类」；每条帖子**引用该达人真实作品**（refs：站内视频直链/作品页，或降级为图片作品），引用素材全部来自抓取数据、不构造；配图默认 AI 风格化 + 本地叠字',
      refs_note: 'kind: video-file=api2 直链 mp4 / video-post=web.alua.com 作品页 / video-cdn=cdn 资源 / image-post=该达人无视频时的**降级**引用（如实标注，不冒充视频）',
      refs_coverage: {
        with_video_ref: cre.picked.filter((c) => c.video_count > 0,
        only_image_ref: cre.picked.filter((c) => c.video_count === 0,
        with_local_video: cre.picked.filter((c) => (c.local_videos || [] > 0,
      },
      count: cre.picked.length,
      creators: cre.picked,
    }, null, 2), 'utf8');
    summary.wrote = ['reports/hlua40-.json', 'reports/hlua40-creators.json'];
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log('\n账号 TOP10:', acc.picked.slice(0, 10).map((x) => `${x.account_id}(发${x.posts_30d})`).join(' '));
  console.log('账号 31~40:', acc.picked.slice(30).map((x) => `${x.account_id}(发${x.posts_30d})`).join(' '));
  console.log('达人 TOP12:', cre.picked.slice(0, 12).map((x) => `${x.name}[${x.category}]`).join(' · '));
}

main();
