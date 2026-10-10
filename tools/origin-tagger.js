#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.2 原创/二创溯源标注器（自包含实现）
 * ----------------------------------------------------------------------------
 * 背景：V15-plan P1.2 原要求「复用 aigc-content-generator.js，新增 origin_type +
 *       source_url 落 content.json」。但经核查，C: git 快照中的 aigc-content-generator.js
 *       / content-gate.js / free-platform-publisher.js 因「密钥外置清洗过度」已被剥离
 *       function 关键字与凭据 token，node --check 直接 SyntaxError，运行期 require 会崩。
 *       故本模块**自包含**：只按 data 契约读取权威 content.json，绝不 require 上述破损文件，
 *       概念上遵守「落 origin_type / source_url」契约。
 *
 * 职责：
 *   1. 幂等为 content.json 每条内容补齐 origin_type(original|derivative) 与 source_url。
 *   2. 导出 stampOriginMeta()，供上游生成器在落库前给新内容打标（替代 aigc 就地改造）。
 *   3. 二创判定：改写相似度需达标（默认 Jaccard < 0.6 视为「充分改写」），并须记录图像重绘。
 *   4. 安全：直接写 D: 运行副本时，若 :3002 主服务在监听，默认拒绝（防 DataStore flush 覆盖）。
 *
 * 用法：
 *   node tools/origin-tagger.js --dry            # 只打印计划，不写盘
 *   node tools/origin-tagger.js --apply           # 写盘（:3002 在监听则拒绝，除非 --force）
 *   node tools/origin-tagger.js --apply --force   # 强制写盘（请先确认已停 3002 或已权衡 flush）
 *   node tools/origin-tagger.js --input X.json --data-dir D:/mscms-ws/data
 */

const fs = require('fs');
const path = require('path');
const net = require('net');

const DATA_DIR = process.env.MSCMS_DATA_DIR || 'D:/mscms-ws/data';
const WORKSPACE = path.resolve(__dirname, '..');
const DEFAULT_INPUT = path.join(DATA_DIR, 'content.json');
const TAGGER_VERSION = 'p1.2-1';
const REWRITE_SIMILARITY_MAX = 0.6; // 二创改写后相似度上限（高于此值视为未充分改写）

// ---------------------------------------------------------------------------
// 相似度：Jaccard on token 集合（英文小写字母数字词）
// ---------------------------------------------------------------------------
function tokenize(s) {
  if (!s || typeof s !== 'string') return new Set();
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean)
  );
}
function jaccard(a, b) {
  const A = typeof a === 'string' ? tokenize(a) : a;
  const B = typeof b === 'string' ? tokenize(b) : b;
  if (A.size === 0 && B.size === 0) return 1;
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

// ---------------------------------------------------------------------------
// 上游生成器复用的打标函数
// ---------------------------------------------------------------------------
/**
 * 为新内容生成 origin 元数据。
 * @param {object} opts
 *   body         {string}  正文（用于相似度比对）
 *   sourceUrl    {string=} 二创来源 URL；缺省 => 视为原创
 *   sourceBody   {string=} 来源正文（用于相似度比对；不传则跳过相似度校验）
 *   imageRedraw  {boolean=} 二创是否重绘了配图
 *   redrawRecord {string=}  重绘记录（如「stable-diffusion-xl / seed 12345」）
 * @returns {{origin_type:string, source_url:string|null, derivative_meta:object|null, _tagged_at:string, _tagger_version:string}}
 */
function stampOriginMeta(opts = {}) {
  const { body = '', sourceUrl = null, sourceBody = null, imageRedraw = false, redrawRecord = null } = opts;
  const now = new Date().toISOString();
  if (!sourceUrl) {
    return {
      origin_type: 'original',
      source_url: null,
      derivative_meta: null,
      _tagged_at: now,
      _tagger_version: TAGGER_VERSION,
    };
  }
  // 二创：相似度校验 + 图像重绘记录
  let similarity = null;
  let similarityOk = true;
  if (sourceBody) {
    similarity = jaccard(body, sourceBody);
    similarityOk = similarity <= REWRITE_SIMILARITY_MAX;
  }
  const derivative_meta = {
    source_url: sourceUrl,
    similarity,
    similarity_ok: similarityOk,
    image_redraw: !!imageRedraw,
    redraw_record: redrawRecord || null,
    redraw_ok: !!imageRedraw,
  };
  // 校验未通过时仍标注为 derivative（不静默降级为 original），但标记 defect 供审查
  if (!similarityOk || !imageRedraw) {
    derivative_meta.defect =
      (!similarityOk ? 'similarity_too_high' : '') +
      (!imageRedraw ? (similarityOk ? 'missing_image_redraw' : ',missing_image_redraw') : '');
  }
  return {
    origin_type: 'derivative',
    source_url: sourceUrl,
    derivative_meta,
    _tagged_at: now,
    _tagger_version: TAGGER_VERSION,
  };
}

// ---------------------------------------------------------------------------
// 存量标注：对已有 content.json 幂等补齐
// ---------------------------------------------------------------------------
function classifyBacklog(entry) {
  // 已有 source_url => derivative；否则 original（存量无来源证据，安全默认）
  if (entry.source_url) {
    return {
      origin_type: 'derivative',
      source_url: entry.source_url,
      derivative_meta: entry.derivative_meta || { source_url: entry.source_url, note: 'backlog-from-existing' },
    };
  }
  return { origin_type: 'original', source_url: null, derivative_meta: null };
}

function tagFile(inputPath, { dry, force }) {
  if (!fs.existsSync(inputPath)) {
    console.error(`[origin-tagger] 输入文件不存在: ${inputPath}`);
    process.exit(2);
  }
  const arr = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  if (!Array.isArray(arr)) {
    console.error('[origin-tagger] content.json 顶层必须是数组');
    process.exit(2);
  }
  let changed = 0;
  let original = 0;
  let derivative = 0;
  for (const e of arr) {
    const already =
      e.origin_type === 'original' || e.origin_type === 'derivative';
    const meta = classifyBacklog(e);
    if (meta.origin_type === 'original') original++;
    else derivative++;
    if (!already) {
      e.origin_type = meta.origin_type;
      e.source_url = meta.source_url;
      e.derivative_meta = meta.derivative_meta;
      e._tagged_at = new Date().toISOString();
      e._tagger_version = TAGGER_VERSION;
      changed++;
    }
  }
  const summary = {
    file: inputPath,
    total: arr.length,
    changed,
    original,
    derivative,
    mode: dry ? 'dry' : 'apply',
  };
  console.log('[origin-tagger] 计划/结果:', JSON.stringify(summary, null, 2));

  if (dry) {
    console.log('[origin-tagger] --dry：未写盘。');
    return summary;
  }

  // 安全闸门由 CLI 包装层处理（需 await 异步端口探测）；此处只按传入的 force 决断。
  if (!force) {
    console.error(
      '⚠️ 此操作非常危险：未加 --force 且 :3002 可能正在运行，直接写 content.json 会被 DataStore flush（内存优先，5~6min 一轮）覆盖丢失。\n' +
      '   请先停 3002（Stop-Process 后等端口空），或加 --force 明确承担 flush 覆盖风险。'
    );
    process.exit(3);
  }

  const tmp = inputPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(arr, null, 2));
  fs.renameSync(tmp, inputPath); // 原子替换
  console.log(`[origin-tagger] 已写盘 ${inputPath}（变更 ${changed} 条）`);
  return summary;
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
    sock.setTimeout(800);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(port, '127.0.0.1');
  });
}

// CLI
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dry = args.includes('--dry');
    const apply = args.includes('--apply');
    const force = args.includes('--force');
    const inArg = args.find((a) => a.startsWith('--input='));
    const dataArg = args.find((a) => a.startsWith('--data-dir='));
    const input = inArg ? inArg.split('=')[1] : (dataArg ? path.join(dataArg.split('=')[1], 'content.json') : DEFAULT_INPUT);
    if (!dry && !apply) {
      console.error('用法: node tools/origin-tagger.js --dry | --apply [--force] [--input=X.json] [--data-dir=DIR]');
      process.exit(1);
    }
    // 安全闸门：:3002 在监听 => 默认拒绝，防 DataStore flush 覆盖（apply 且非 force 时）
    if (apply && !force) {
      const listening = await isPortListening(3002);
      if (listening) {
        console.error(
          '⚠️ 此操作非常危险：:3002 主服务正在运行，直接写 content.json 会被 DataStore flush 覆盖丢失。\n' +
          '   请先停 3002，或加 --force 明确承担风险。'
        );
        process.exit(3);
      }
    }
    tagFile(input, { dry, force: force || (apply && !(await isPortListening(3002))) });
  })();
}

module.exports = { stampOriginMeta, classifyBacklog, jaccard, tokenize, tagFile, TAGGER_VERSION };
