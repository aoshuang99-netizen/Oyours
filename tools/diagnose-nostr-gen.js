#!/usr/bin/env node
/**
 * tools/diagnose-nostr-gen.js — 第 4 层（新平台内容产出质量）取证脚本
 *
 * 目的：验证「保底配额让生成器确实产出了 nostr 内容，但被质检丢弃」的真实链路。
 * 纪律：只取证、不改任何生产配置/代码。
 *
 * 用法：node tools/diagnose-nostr-gen.js
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const gen_mod = require(path.join(ROOT, 'aigc-content-generator.js'));
const { AIGCContentGenerator, PLATFORM_SPECS, PROMPT_TEMPLATES } = gen_mod;
const { ContentPipeline } = require(path.join(ROOT, 'content-pipeline.js'));

const line = (s) => console.log('\n' + '='.repeat(72) + '\n' + s + '\n' + '='.repeat(72));

(async () => {
  // ── ① 静态结构取证：两张表对新平台的覆盖 ──────────────────────
  line('① 静态结构：PLATFORM_SPECS vs PROMPT_TEMPLATES 键覆盖');
  const specKeys = Object.keys(PLATFORM_SPECS).sort();
  const tplKeys = Object.keys(PROMPT_TEMPLATES).sort();
  const realChans = ['tumblr', 'nostr', 'bluesky', '', '', 'discord', 'devto', '', 'github'];
  console.log('PLATFORM_SPECS   :', specKeys.join(', '));
  console.log('PROMPT_TEMPLATES :', tplKeys.join(', '));
  console.log('\n真实 provider 通道覆盖情况：');
  for (const ch of realChans) {
    const inSpec = specKeys.includes(ch);
    const inTpl = tplKeys.includes(ch);
    console.log(`  ${ch.padEnd(10)} SPECS=${inSpec ? '✅' : '❌'}  TEMPLATES=${inTpl ? '✅' : '❌'}` +
      (inSpec && !inTpl ? '   ← ⚠️ 有 spec 无模板：_buildPrompt 会 TypeError' : ''));
  }
  const orphan = specKeys.filter(k => !tplKeys.includes(k));
  if (orphan.length) console.log(`\n⚠️ 孤儿 spec（有 spec 无模板）: ${orphan.join(', ')}`);

  // ── ② 直接调用生成器：nostr / twitter ─────────────────────────
  line('② 直接调用 AIGCContentGenerator.generate()');
  // 模型对齐生产（server.js:2440 用 qwen2.5:3b），否则会因默认 llama3.2 未安装而误判
  const MODEL = process.env.MSCMS_LLM_MODEL || 'qwen2.5:3b';
  console.log(`  （使用模型 ${MODEL}，与生产一致；单条实测约 32s，请耐心）`);
  const gen = new AIGCContentGenerator({ provider: 'ollama', llmModel: MODEL });
  for (const p of ['tumblr', 'nostr', 'twitter']) {
    try {
      const task = await gen.generate(p, { topic: 'test topic probe' });
      const body = String(task.result?.body || task.result?.text || '');
      console.log(`  ${p.padEnd(8)} status=${task.status}  error=${task.error || '-'}  ` +
        `result=${task.result ? 'object' : 'null'}  body.len=${body.length}  source=${gen._lastLLMSource || '-'}`);
    } catch (e) {
      console.log(`  ${p.padEnd(8)} ❌ 抛出未捕获异常: ${e.message}`);
    }
  }

  // ── ③ 走完整管线：ContentPipeline.generateContent('nostr') ────
  line('③ 走完整管线 ContentPipeline.generateContent()');
  const deaiStub = {
    process: async (c) => ({ processed: c, originalAIScore: 0, finalAIScore: 0, improvementPercent: 0 }),
  };
  const pipe = new ContentPipeline({
    contentGenerator: gen,
    deaiProcessor: deaiStub,      // 打桩隔离：排除 deai 干扰，只看生成器+兜底
    llmEndpoint: 'http://localhost:11434/api/generate',
    llmModel: 'qwen2.5:3b',
  });
  pipe.config.enableABTest = false;   // 减少干扰

  for (const p of ['tumblr', 'nostr']) {
    try {
      const r = await pipe.generateContent(p, { accountAge: 7, tone: 'natural', generateVariants: false });
      const c = r.content || {};
      const body = String(c.body || c.text || '');
      console.log(`\n  ── =${p}`);
      console.log(`     content.body 长度 = ${body.length}${body.length < 30 ? '   ← ❌ <30，会被 server.js:3051 丢弃' : '   ← ✅ 通过'}`);
      console.log(`     content.fallback  = ${c.fallback}`);
      console.log(`     content.source    = ${c.source}`);
      console.log(`     content.error     = ${c.error || '-'}`);
      console.log(`     content.id        = ${c.id}`);
      console.log(`     body 预览         = ${JSON.stringify(body.slice(0, 80))}`);
      console.log(`     stages            = ${(r.stages || []).map(s => s.stage).join(' → ')}`);
      // 复现 server.js:3032 与 :3051 两个判据
      const skipByFallbackFlag = !r || !r.content || r.fallback;
      console.log(`     [server.js:3032] generated.fallback = ${r.fallback}  → 跳过？${skipByFallbackFlag ? '是' : '否 ← 标记错位！'}`);
      if (!skipByFallbackFlag) {
        const reason = body.length < 30 ? '正文过短(<30字符)' : '(通过)';
        console.log(`     [server.js:3051] 实际判据 → ${reason}`);
      }
    } catch (e) {
      console.log(`\n  ── =${p} ❌ 管线异常: ${e.message}`);
    }
  }

  // ── ④ 内容池对新平台是否有货 ─────────────────────────────────
  line('④ 内容池 contentPool.getContent() 对新平台是否有货');
  try {
    for (const p of ['tumblr', 'nostr']) {
      const pooled = pipe.contentPool.getContent(p);
      console.log(`  ${p.padEnd(8)} ${pooled ? `✅ 有货 body.len=${String(pooled.body || ''}` : '❌ 无货 → _fallbackGenerate 直接返回 fallback:true'}`);
    }
  } catch (e) {
    console.log('  内容池探测异常:', e.message);
  }

  line('取证完成 — 未修改任何生产文件');
})().catch(e => {
  console.error('诊断脚本异常:', e);
  process.exit(1);
});
