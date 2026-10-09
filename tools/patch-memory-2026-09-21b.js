#!/usr/bin/env node
/**
 * 记忆修补（09-21 第二批）：Mastodon 取证定案 + 进程边界解法
 * 用【行区间替换】而非文本匹配，避开转义/精确匹配问题；带命中审计。
 */
const fs = require('fs');
const path = require('path');

const MEM = path.join(__dirname, '..', '', 'memory');
const MEMORY = path.join(MEM, 'MEMORY.md');
const FRAG_NEW = path.join(MEM, '.frag--new.md');

 patchRange(file, startPrefix, endPrefix, newBlock) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.startsWith(startPrefix));
  const j = lines.findIndex((l) => l.startsWith(endPrefix));
  if (i < 0) throw new Error('未找到起始锚点: ' + startPrefix);
  if (j < 0) throw new Error('未找到结束锚点: ' + endPrefix);
  if (j <= i) throw new Error('锚点顺序异常 i=' + i + ' j=' + j);
  const before = lines.slice(0, i);
  const after = lines.slice(j);
  const out = before.concat(newBlock.split('\n')).concat(after).join('\n');
  fs.writeFileSync(file, out, 'utf8');
  return { replacedLines: j - i, newLines: newBlock.split('\n' };
}

console.log('════ 1. MEMORY.md：替换 Mastodon 段（行区间） ════');
const newBlock = fs.readFileSync(FRAG_NEW, 'utf8').replace(/\s+$/, '');
const r1 = patchRange(MEMORY, '- **Mastodon 孤儿文件**', '- 养号可行性铁律', newBlock);
console.log(`  替换 ${r1.replacedLines} 行 → 新 ${r1.newLines} 行`);

console.log('\n════ 2. MEMORY.md：修正「外网验证的进程边界」段 ════');
const src = fs.readFileSync(MEMORY, 'utf8');
const lines = src.split('\n');
const i = lines.findIndex((l) => l.startsWith('- **⚠️ 外网验证的进程边界'));
const j = lines.findIndex((l, k) => k > i && l.startsWith('- 养号可行性铁律'));
if (i < 0 || j < 0) {
  console.log('  ⚠️ 锚点未命中（可能已被上一步合并）i=' + i + ' j=' + j);
} else {
  const repl = [
    '- **⚠️ 外网验证的进程边界（09-21 踩坑 → 已找到解法）**：`fetchExt(url, opts, )` **** ⇒ 独立脚本里 `fetchExt(url, {}, \'http://:10808\')` 也能走真实出口（实测连通 .social HTTP 200）。**不再受「代理池只在服务进程内」限制**。',
    '  - 池内 `default-relay`（`http://:10808`，出口 IP ）可连通 .social。',
    '  - **本地回环 API 必须用原生 `fetch`**：`fetchExt(url, opts, null)` 会落到全局 proxyAgent，把  也塞进代理 → `This operation was aborted`（实测 15s 超时）。09-21 新坑。',
    '  - `/api/v14/mixpost/provider//config` **首次访问会冷启动**（`providerManager.connect` → 动态 `import(\'undici\')`），实测首访 >15s ⇒ 客户端超时给足 45s。',
    '  - 仍成立的旧结论：不得因「格式合法」就宣称可用；可用性必须实测（`verify_credentials`）。',
  ].join('\n');
  const out = lines.slice(0, i).concat(repl.split('\n')).concat(lines.slice(j)).join('\n');
  fs.writeFileSync(MEMORY, out, 'utf8');
  console.log(`  替换 ${j - i} 行 → 新 5 行`);
}

console.log('\n════ 3. 今日日志：追加证伪与定案（append-only） ════');
const TODAY = path.join(MEM, '2026-09-21.md');
const add = [
  '',
  '### 追加 · Mastodon 定案（21:0x 实测，**推翻本文件上文的「无需重跑 OAuth」假设**）',
  '',
  '上文「发现 ①：Mastodon 可能不用重跑 OAuth」**已证伪**。取证链：',
  '',
  '| 检查 | 命令 | 结果 |',
  '|---|---|---|',
  '| 账号是否还在 | `GET /api/v1//lookup?acct=mscms_v14` | **404 `Record not found`** |',
  '| 43 字符 token | `GET /api/v1//verify_credentials` | **401 `The access token is invalid`** |',
  '| app 是否还在 | `POST /oauth/token =` | **200**（app id 8931885 存活） |',
  '| app token 能否发帖 | `POST /api/v1/statuses` | **422 `requires an authenticated user`** |',
  '',
  '⇒ **根因是账号已不存在，不是 token 被撤销**；app 无需重注册；发帖必须走 `` 拿用户态 token。',
  '',
  '**新解法（推翻「必须在服务进程内才能访问外网」）**：`fetchExt(url, opts, )` ，独立脚本也能走真实出口。另发现本地回环 API 必须用原生 `fetch`（`fetchExt(..., null)` 会落全局代理 → aborted）。',
  '',
  '**可行路径已打通**：.social 是 8 个候选实例中**唯一「注册开放 + 免审批 + 无验证码」**；邮箱 catch-all（`lokfeel.com` + `mail-api.lokfeel.com`）实测可开地址/读信/抽码；配置写入有免重启端点 `POST /api/v14/mixpost/provider//config`。',
  '',
  '新建工具：`tools/-oauth.js`、`tools/-onboard.js`（`--dry` 自检已通过）、`tools/verify--token.js`、`tools/-instance-probe.js`、`tools/-signup-recon.js`。',
  '',
  '**未执行**：未创建任何账号、未修改服务配置、未改动 `_config.json`。注册页第 1 步实测为 `button[name=accept]` 提交按钮（非 ），DRY 自检当场纠正了这一误判。',
  '',
  '**合规提示**：.social 站规第 6 条要求「使用生成式 AI 必须披露」⇒ 我方 AI 内容须披露，账号建议标 `bot=true`。',
].join('\n');

const before = fs.readFileSync(TODAY, 'utf8');
if (before.includes('Mastodon 定案（21:0x 实测')) {
  console.log('  已存在，跳过（幂等）');
} else {
  fs.appendFileSync(TODAY, add, 'utf8');
  console.log(`  已追加 ${add.length} 字节`);
}

console.log('\n════ 4. 落盘审计 ════');
const chk = fs.readFileSync(MEMORY, 'utf8');
for (const pat of ['app 仍活着', '', 'app 级 token 不能发帖', '', '站规第 6 条', '', '本地回环 API 必须用原生']) {
  console.log(`  MEMORY.md  ${pat.padEnd(24)} ${chk.includes(pat) ? '✅' : '❌'}`);
}
for (const pat of ['Mastodon 孤儿文件', '外网验证的进程边界']) {
  console.log(`  MEMORY.md  旧锚点残留 ${pat.padEnd(16)} ${chk.includes(pat) ? '⚠️ 仍在' : '✅ 已清'}`);
}
const t = fs.readFileSync(TODAY, 'utf8');
console.log(`  今日日志  定案段            ${t.includes('Mastodon 定案（21:0x 实测') ? '✅' : '❌'}`);
console.log(`  MEMORY.md 行数 = ${chk.split('\n'}   今日日志行数 = ${t.split('\n'}`);

fs.unlinkSync(FRAG_NEW);
console.log('\n片段文件已清理');
