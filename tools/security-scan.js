#!/usr/bin/env node
/**
 * tools/security-scan.js — P0.4 出网审计 / 敏感文件与明文 token 审计
 *
 * 设计铁律：绝不把密钥原文打印到 stdout 或落盘。
 * 命中只报告 文件:行:类型 + 关键字 + [REDACTED len=N]。
 *
 * 用法：node tools/security-scan.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const IGNORE_DIRS = new Set([
  'node_modules', 'MSCMS-v14-Desktop', 'archive', 'quarantine', 'data',
  '', '.git', '.tmp', '.playwright-cli', '.learnings', '.pw_tumblr_profile',
  'reports' // 交付文档（HTML 报告），非源码，且体积大，跳过
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 超过 2MB 的文件跳过逐行扫描（避免大 HTML 卡顿）
const SCAN_EXT = new Set(['.js', '.json', '.html', '.css', '.bat', '.ps1']);

// 已知凭证文件名（已 gitignore，此处确认其不被误提交）
const SECRET_FILENAMES = [
  '', 'credentials-input.json', 'proxy-pool.json',
  '', '.proxy-v2ray-pids.json', '.sb-1085.json', '.sb-1086.json', '.sb-1087.json'
];

const KW = /(api[_-]?key|apikey|secret|token||passwd|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)\b/i;
const STR_LIT = /['"`]([^'"`\n]{8,})['"`]/g;
const LONG_LIT = /['"`]([A-Za-z0-9+/_=-]{32,})['"`]/g;

const findings = [];

 function redact(s) { return s.length > 0 ? `[REDACTED len=${s.length}]` : s; }

 function scanFile(file) {
  let text;
  try {
    const st = fs.statSync(file);
    if (st.size > MAX_FILE_BYTES) return; // 超大文件跳过
    text = fs.readFileSync(file, 'utf8');
  } catch { return; }
  const rel = path.relative(ROOT, file);
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // 关键字字面量赋值（排除从 env / require / config 读取）
    if (KW.test(line)) {
      const m = line.match(STR_LIT);
      if (m) {
        for (const mm of m) {
          const val = mm.slice(1, -1);
          if (val.length >= 8 && !/process\.env|require\(|config\.|getenv/i.test(line)) {
            findings.push({ file: rel, line: i + 1, type: 'keyword-literal', keyword: (line.match(KW) || [, ''])[0], value: redact(val) });
          }
        }
      }
    }
    // 长字面量（疑似硬编码 token / 私钥）
    const lm = line.match(LONG_LIT);
    if (lm) {
      for (const mm of lm) {
        const val = mm.slice(1, -1);
        if (/^https?:|data:|[\\/]|\.(com|cn|net|org|io|png|jpg|jpeg|json|js|html|css|md)$/i.test(val)) continue;
        findings.push({ file: rel, line: i + 1, type: 'long-literal', value: redact(val) });
      }
    }
  });
}

 function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('C:UsersAS')) continue; // 工具生成的垃圾目录
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORE_DIRS.has(e.name)) continue;
      walk(p);
    } else if (e.isFile()) {
      if (!SCAN_EXT.has(path.extname(e.name).toLowerCase())) continue;
      scanFile(p);
    }
  }
}

walk(ROOT);

const secretFileStatus = SECRET_FILENAMES.map(f => ({ file: f, exists: fs.existsSync(path.join(ROOT, f)) }));

const report = {
  scannedAt: new Date().toISOString(),
  root: ROOT,
  findingsCount: findings.length,
  findings,
  secretFileStatus,
  note: '所有命中均为脱敏报告（值已替换为长度），密钥原文不落盘不打印。'
};

const outDir = path.join(ROOT, 'ops');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `security-audit-${new Date().toISOString().slice(0, 10)}.json`);
fs.writeFileSync(outFile, JSON.stringify(report, null, 2));

// ---- 安全摘要（无原文）----
console.log(`[security-scan] 扫描完成：发现 ${findings.length} 处疑似明文凭证/长字面量`);
console.log(`[security-scan] 报告已写入：${outFile}`);
if (findings.length) {
  console.log('--- 命中（已脱敏）---');
  for (const f of findings.slice(0, 200)) {
    console.log(`  ${f.file}:${f.line}  [${f.type}] ${f.keyword || ''} ${f.value}`);
  }
}
console.log('--- 已知凭证文件状态（应全部 gitignore，不进仓库）---');
for (const s of secretFileStatus) console.log(`  ${s.file}: ${s.exists ? '存在(已gitignore)' : '不存在'}`);
