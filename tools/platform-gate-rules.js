#!/usr/bin/env node
'use strict';
/*
 * OYours / MSCMS v14 — P1.5a 平台预检规则解析器（自包含实现）
 * ----------------------------------------------------------------------------
 * V15-plan P1.5 要求：docs/platforms/ 接入 content-gate.js 发布前预检。
 * 但 content-gate.js 在 C: 快照中语法破损（全部函数缺 function 关键字），
 * 无法 require。本模块**自包含**：直接解析 docs/platforms/*.md 的「预检规则」JSON 块，
 * 构建 Map<platform, rule>，提供 checkPlatform() 与就绪审计，概念上替代 gate() 的预检职责。
 *
 * 契约（与 docs/platforms/README.md 一致）：
 *   - 每个平台一个 .md，含 `## 预检规则` + ```json 块。
 *   - 空规则（或无 JSON 块）视为该平台未就绪，默认拦截（README 硬约束）。
 *   - 平台键取自文件名（去掉 .md），不受 md 内空路由键影响。
 *
 * 用法（作为库）：
 *   const { PlatformGate } = require('./platform-gate-rules');
 *   const gate = new PlatformGate();           // 自动加载 docs/platforms
 *   const r = gate.check('bluesky', { text:'...', tags:['a'], proxyClass:'any' });
 *   // r = { ok, reason, rule }
 *   gate.readiness();                            // 返回各平台就绪状态
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE = path.resolve(__dirname, '..');
const PLATFORMS_DIR = path.join(WORKSPACE, 'docs', 'platforms');
const RULE_HEADING = /##\s*预检规则/i;
const JSON_BLOCK = /```json\s*([\s\S]*?)```/i;

function loadRules(dir = PLATFORMS_DIR) {
  const map = new Map();
  if (!fs.existsSync(dir)) return map;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md');
  for (const f of files) {
    const platform = f.replace(/\.md$/i, '');
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    let rule = null;
    const headingIdx = text.search(RULE_HEADING);
    if (headingIdx >= 0) {
      const tail = text.slice(headingIdx);
      const m = tail.match(JSON_BLOCK);
      if (m) {
        try { rule = JSON.parse(m[1]); } catch (e) { rule = { __parseError: e.message }; }
      }
    }
    // 空规则视为未就绪（README 硬约束）
    map.set(platform, rule && typeof rule === 'object' && !rule.__parseError && Object.keys(rule).length > 0 ? rule : null);
  }
  return map;
}

class PlatformGate {
  constructor(dir = PLATFORMS_DIR) {
    this.dir = dir;
    this.rules = loadRules(dir);
  }

  reload() { this.rules = loadRules(this.dir); return this; }

  has(platform) { return this.rules.has(platform); }

  /**
   * 发布前预检。
   * @param {string} platform
   * @param {object} post  { text|body|title, tags?, mediaCount?, proxyClass?, nsfw?, url? }
   * @returns {{ok:boolean, reason:string, rule:object|null}}
   */
  check(platform, post = {}) {
    const rule = this.rules.get(platform);
    if (!rule) {
      return { ok: false, reason: `平台「${platform}」未就绪（规则为空或缺失），默认拦截`, rule: null };
    }
    const text = post.text || post.body || post.title || '';
    const tags = Array.isArray(post.tags) ? post.tags : [];
    const mediaCount = Number(post.mediaCount) || 0;
    const proxyClass = post.proxyClass || 'any';

    // 长度
    if (rule.maxLength && text.length > rule.maxLength) {
      return { ok: false, reason: `正文 ${text.length} 超长（上限 ${rule.maxLength}）`, rule };
    }
    if (rule.maxBytes && Buffer.byteLength(text, 'utf8') > rule.maxBytes) {
      return { ok: false, reason: `字节 ${Buffer.byteLength(text, 'utf8')} 超限（上限 ${rule.maxBytes}）`, rule };
    }
    // 标签数
    if (rule.maxTags && tags.length > rule.maxTags) {
      return { ok: false, reason: `标签 ${tags.length} 超量（上限 ${rule.maxTags}）`, rule };
    }
    // 媒体数
    if (rule.maxMedia && mediaCount > rule.maxMedia) {
      return { ok: false, reason: `媒体 ${mediaCount} 超量（上限 ${rule.maxMedia}）`, rule };
    }
    // 代理等级（住宅墙）
    if (rule.blockUnlessResidential && proxyClass !== 'residential') {
      return { ok: false, reason: `平台要求住宅代理，当前出口=${proxyClass}`, rule };
    }
    // NSFW/CW 必填
    const nsfwTags = rule.requireNSFWTagFor || rule.requireCWFor || [];
    if (nsfwTags.length && post.nsfw) {
      const hasMarker = tags.some((t) => nsfwTags.includes(String(t).toLowerCase())) ||
        /nsfw|lokai|adult/i.test(text);
      if (!hasMarker) return { ok: false, reason: `NSFW 内容缺少标注标签（需 ${nsfwTags.join('/')}）`, rule };
    }
    // 链接数（telegraph）
    if (rule.maxLinksPerPage) {
      const links = (text.match(/https?:\/\//g) || []).length;
      if (links > rule.maxLinksPerPage) return { ok: false, reason: `外链 ${links} 超量（上限 ${rule.maxLinksPerPage}）`, rule };
    }
    // 规范回链（telegraph）
    if (rule.requireCanonicalBacklink && !/kkmatch\.com|hlua\.cc\.cd/i.test(text)) {
      return { ok: false, reason: 'Telegraph 页缺少规范回链（kkmatch.com / hlua.cc.cd）', rule };
    }
    return { ok: true, reason: '通过预检', rule };
  }

  readiness() {
    const out = {};
    for (const [p, r] of this.rules) out[p] = r ? 'ready' : 'not-ready(empty-rule)';
    return out;
  }

  list() { return [...this.rules.keys()]; }
}

if (require.main === module) {
  const gate = new PlatformGate();
  console.log('=== 平台预检规则就绪审计 ===');
  console.log(JSON.stringify(gate.readiness(), null, 2));
  // 示例预检
  const samples = {
    bluesky: { text: 'hello world', tags: ['dating'], proxyClass: 'any' },
    mastodon: { text: 'x'.repeat(600), tags: ['a'], proxyClass: 'any' }, // 应超长
    tumblr: { text: 'hi', tags: [], proxyClass: 'datacenter' }, // 应被住宅墙拦
  };
  for (const [p, post] of Object.entries(samples)) {
    console.log(`check(${p}) ->`, JSON.stringify(gate.check(p, post)));
  }
}

module.exports = { PlatformGate, loadRules, PLATFORMS_DIR };
