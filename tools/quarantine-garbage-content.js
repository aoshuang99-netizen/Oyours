#!/usr/bin/env node
/**
 * quarantine-garbage-content.js — 垃圾内容隔离（P0 止血第三步）
 * ---------------------------------------------------------------
 * 把 content.json 中标题为错误响应/占位文案的垃圾内容移到 content_quarantine.json，
 * 使发布池干净。隔离 = 移出但保留（可回滚），不是删除。
 *
 * 判定规则（与 server.js 发布闸门、生成端体检保持一致）：
 *   ① 标题命中错误响应/占位黑名单（400 Bad Request / Auto-generated content / Post for x 等）
 *   ② 或正文存在且长度 < 30 字符
 *
 * 用法（必须先停 3002 + 3011，避免 DataStore flush 覆盖）：
 *   node tools/quarantine-garbage-content.js --dry-run
 *   node tools/quarantine-garbage-content.js --apply
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const CONTENT = path.join(DATA_DIR, 'content.json');
const QUARANTINE = path.join(DATA_DIR, 'content_quarantine.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

const GARBLED_TITLE_RE = /^(400|401|403|404|405|408|429|500|502|503|504)\b|bad request|auto-generated|internal server error|service unavailable|unauthorized|forbidden|not found|gateway|error occurred|timed? ?out|^post for\s+[\w-]+$/i;

function isGarbage(c) {
  const t = String(c.title || '').trim();
  if (t && GARBLED_TITLE_RE.test(t)) return 'title:' + t.slice(0, 40);
  const b = String(c.body || c.text || '').trim();
  if (b && b.length < 30) return 'body_too_short';
  if (b && GARBLED_TITLE_RE.test(b.slice(0, 80))) return 'body:' + b.slice(0, 40);
  return null;
}

const content = JSON.parse(fs.readFileSync(CONTENT, 'utf8'));
if (!Array.isArray(content)) { console.error('content.json 不是数组'); process.exit(1); }

// 已发布集合：用于标注「垃圾已外发」，供人工决定删帖与否（本脚本不删任何已发布内容）
const publish = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'publish.json'), 'utf8')); } catch (e) { return []; } })();
const pubContentIds = new Set(publish.map((p) => p.content_id));

const bad = [], keep = [];
const reasons = {};
content.forEach((c) => {
  const r = isGarbage(c);
  if (r) {
    const key = r.split(':')[0];
    reasons[key] = (reasons[key] || 0) + 1;
    bad.push({ ...c, _quarantine_reason: r, _quarantined_at: new Date().toISOString(), _was_published: pubContentIds.has(c.id) });
  } else keep.push(c);
});

const badPublished = bad.filter((c) => c._was_published).length;

console.log('='.repeat(60));
console.log(`content 总数        : ${content.length}`);
console.log(`判定为垃圾          : ${bad.length}  (占 ${(bad.length / content.length * 100).toFixed(1)}%)`);
console.log(`  其中已外发(需人工): ${badPublished}`);
console.log(`隔离后剩余          : ${keep.length}`);
console.log('垃圾原因分布        :', JSON.stringify(reasons));
console.log('='.repeat(60));

if (!APPLY) {
  console.log('\n[DRY-RUN] 未写盘。执行前请先停 3002 + 3011：');
  console.log('  taskkill /F /T /PID <watchdog3011PID>');
  console.log('  node tools/quarantine-garbage-content.js --apply');
  process.exit(0);
}

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.copyFileSync(CONTENT, path.join(BACKUP_DIR, `content.before-quarantine-${Date.now()}.json`));
console.log('[备份] content.json -> backups/');

// 隔离文件：与历史隔离记录合并（按 id 去重）
let prev = [];
if (fs.existsSync(QUARANTINE)) {
  try { prev = JSON.parse(fs.readFileSync(QUARANTINE, 'utf8')); } catch (e) { prev = []; }
}
const seen = new Set(prev.map((x) => x.id));
const merged = prev.concat(bad.filter((x) => !seen.has(x.id)));
fs.writeFileSync(QUARANTINE, JSON.stringify(merged, null, 2), 'utf8');

const tmp = CONTENT + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(keep, null, 2), 'utf8');
fs.renameSync(tmp, CONTENT);

console.log(`[写盘] content.json      : ${keep.length} 条（已移除垃圾 ${bad.length} 条）`);
console.log(`[写盘] content_quarantine.json : ${merged.length} 条（本次新增 ${bad.length} 条）`);
console.log(`\n⚠ 已外发的 ${badPublished} 条垃圾帖未做任何删除（避免误伤账号），已在隔离记录中标记 _was_published:true 供人工复核。`);
