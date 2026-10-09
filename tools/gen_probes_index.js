// 生成 tools/probes/README.md 索引（按文件名前缀分类）
// 用法: node tools/gen_probes_index.js
const fs = require('fs');
const path = require('path');

const probesDir = path.join(__dirname, 'probes');
const files = fs.readdirSync(probesDir).filter(f => f.endsWith('.js')).sort();

const rules = [
  [/^_probe/i, '探针 / Probe（注册·邮箱·验证码·生日）'],
  [/^_diag/i, '诊断 / Diagnostics（瓶颈·代理·发布·管线）'],
  [/^_chain/i, '因果链 / Causal-chain（扫描·诊断）'],
  [/^_clean/i, '清理 / Cleanup（假数据·JSON·MySQL）'],
  [/^_e2e/i, '端到端测试 / E2E（批量·发布）'],
  [/^_fake/i, '假数据清理 / Fake-data'],
  [/^_(check|chk|validate|verify|final)/i, '校验 / Verify（最终复检·字段校验）'],
  [/^_scan/i, '扫描 / Scan'],
  [/^_batch/i, '批量 / Batch'],
  [/^_oauth/i, 'OAuth / Demo'],
  [/^_net/i, '网络 / Net-diag'],
  [/^_observe/i, '观察 / Observe'],
  [/^_acct/i, '账号 / Account'],
  [/^_grab/i, '抓取 / Grab'],
  [/^_live/i, '实时发布 / Live-publish-test'],
  [/^_b2_/i, /^_b3_/i, 'B 轮验证 / B-round'],
];

 categorize(name) {
  for (const r of rules) {
    const label = r[r.length - 1];
    const patterns = r.slice(0, r.length - 1);
    for (const p of patterns) {
      if (p instanceof RegExp && p.test(name)) return label;
    }
  }
  return '其他 / Other（账号·批次·工具）';
}

const groups = {};
for (const f of files) {
  const k = categorize(f);
  (groups[k] = groups[k] || []).push(f);
}

let md = '# tools/probes/ 开发探针索引\n\n';
md += `> 本目录由 M0·T7 工作区清理从仓库根目录归档而来（原 92 个 \`_*.js\` 独立开发/诊断脚本）。\n`;
md += `> 这些脚本**不被 server.js 或任何业务模块引用**，均为手动触发的独立 Node 脚本。\n`;
md += `> 运行方式：\n\n`;
md += '```bash\nnode tools/probes/_probe_signup.js   # 示例：从仓库根目录或 tools/probes 下均可\n```\n\n';
md += `> 注意：部分探针会直接读写 \`D:/mscms-ws/data\` 或 MySQL(3307)。按铁律——**改 data/*.json 前必须先停 3002**，避免 DataStore flush 覆盖。\n\n`;
md += `## 分类清单（共 ${files.length} 个）\n\n`;

for (const [label, list] of Object.entries(groups)) {
  md += `### ${label}（${list.length}）\n\n`;
  for (const f of list) {
    md += `- \`${f}\`\n`;
  }
  md += '\n';
}

fs.writeFileSync(path.join(probesDir, 'README.md'), md);
console.log('README.md 已生成，文件总数:', files.length, '，分类数:', Object.keys(groups);
