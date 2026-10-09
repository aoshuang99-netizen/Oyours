/**
 * MSCMS v14 — 数仓只读体检 (M5)
 * 仅读取 D:/mscms-ws/data 下所有 JSON，统计：
 *  - 各表记录数 / 体积
 *  -  字段分布 (检测 twitter/x 双名)
 *  - 关键分析字段空置率 (publish.avgReach/avgLikes, content.avgQuality, account_decisions.action_type)
 * 零写入，可安全在 3002 运行时执行。
 */
const fs = require('fs');
const path = require('path');

const DATA = 'D:/mscms-ws/data';
const OUT = 'C:/Users/AS/WorkBuddy/2026-06-13-19-42-19/reports/warehouse_audit.json';

const files = fs.readdirSync(DATA).filter(f => f.endsWith('.json')).sort();
const report = {
  generatedAt: new Date().toISOString(),
  dataDir: DATA,
  isSymlink: false,
  fileCount: files.length,
  totalBytes: 0,
  tables: {},
  twitterX: {},
  emptyFieldHits: {},
};

// 检测 data 是否为 symlink
try { report.isSymlink = fs.lstatSync(DATA).isSymbolicLink(); } catch (_) {}

 isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

for (const f of files) {
  const fp = path.join(DATA, f);
  const st = fs.statSync(fp);
  report.totalBytes += st.size;
  const info = { size: st.size, name: f };
  try {
    const o = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (Array.isArray(o)) {
      info.type = 'array';
      info.count = o.length;
      //  分布
      if (o.length && o[0] && o[0]. !== undefined) {
        const dist = {};
        for (const it of o) { const p = it.; dist[p] = (dist[p] || 0) + 1; }
        info.Dist = dist;
        if (dist.twitter !== undefined || dist.x !== undefined) {
          report.twitterX[f] = dist;
        }
      }
      // 关键空字段扫描
      const targetFields = ['avgReach', 'avgLikes', 'avgQuality', 'action_type', 'actionType', 'reach', 'likes'];
      const emptyStats = {};
      for (const it of o) {
        if (!it || typeof it !== 'object') continue;
        for (const k of targetFields) {
          if (k in it) {
            if (!emptyStats[k]) emptyStats[k] = { present: 0, empty: 0 };
            emptyStats[k].present++;
            if (isEmpty(it[k])) emptyStats[k].empty++;
          }
        }
      }
      if (Object.keys(emptyStats) info.emptyFieldStats = emptyStats;
      // 标记高价值空字段命中
      for (const k of Object.keys(emptyStats)) {
        const s = emptyStats[k];
        if (s.empty > 0) {
          report.emptyFieldHits[`${f}.${k}`] = { present: s.present, empty: s.empty, emptyRate: +(s.empty / s.present * 100).toFixed(1) };
        }
      }
    } else if (o && typeof o === 'object') {
      info.type = 'object';
      info.keyCount = Object.keys(o;
      info.topKeys = Object.keys(o).slice(0, 25);
      // 某些表是 {rows:[...]} 包裹
      if (Array.isArray(o.rows)) {
        info.type = 'object(rows)';
        info.count = o.rows.length;
        if (o.rows[0] && o.rows[0]. !== undefined) {
          const dist = {};
          for (const it of o.rows) { const p = it.; dist[p] = (dist[p] || 0) + 1; }
          info.Dist = dist;
          if (dist.twitter !== undefined || dist.x !== undefined) report.twitterX[f] = dist;
        }
      }
    } else {
      info.type = 'scalar';
    }
  } catch (e) {
    info.parseError = e.message;
  }
  report.tables[f] = info;
}

fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log('== 数仓体检完成 ==');
console.log('文件数:', report.fileCount, '| 总体积:', (report.totalBytes / 1024 / 1024).toFixed(2) + 'MB', '| data 为 symlink:', report.isSymlink);
console.log('\n== twitter/x 双名分布 ==');
console.log(JSON.stringify(report.twitterX, null, 2) || '(无)');
console.log('\n== 关键空字段命中 (空置率>0) ==');
for (const [k, v] of Object.entries(report.emptyFieldHits)) {
  console.log(`  ${k}: present=${v.present} empty=${v.empty} 空置率=${v.emptyRate}%`);
}
if (!Object.keys(report.emptyFieldHits) console.log('  (未命中预设字段 — 可能字段名不同或已填充)');
console.log('\n报告已写入:', OUT);
