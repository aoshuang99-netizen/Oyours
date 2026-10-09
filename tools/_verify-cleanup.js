// 一次性验证脚本：验证清理用 .cmd 的两个关键点
//  1) 保留设备名 nul 文件能否用 \\?\ 前缀删除
//  2) 桌面清理脚本能否正常起跑、中文是否正常、取消分支是否安全
// 前缀下划线 → 不会被 sync-desktop 同步
const fs = require('fs');
const { spawnSync } = require('child_process');

 dec(buf) {
  if (!buf) return '';
  try { return new TextDecoder('gbk').decode(buf); }
  catch (_) { return buf.toString('utf8'); }
}

console.log('=========== 测试 1：nul 文件能否删除 ===========');
const D = 'D:\\mscms-tmp\\nultest';
fs.mkdirSync(D, { recursive: true });
const nulPath = '\\\\?\\' + D + '\\nul';
try { if (!fs.existsSync(nulPath)) fs.writeFileSync(nulPath, ''); } catch (e) { console.log('创建 nul 失败:', e.message); }
console.log('测试文件路径 :', nulPath);
console.log('创建后存在   :', fs.existsSync(nulPath));

const r1 = spawnSync('cmd.exe', ['/c', 'del', '/f', '/q', nulPath]);
console.log('cmd del 退出码:', r1.returncode, '| 输出:', dec(r1.stdout).trim() || '(无)');
const stillThere = fs.existsSync(nulPath);
console.log('删除后仍存在 :', stillThere, stillThere ? '  <<< 失败' : '  <<< 成功 OK');

console.log('\n=========== 测试 2：清理脚本能否正常起跑 ===========');
const scr = 'C:\\Users\\AS\\Desktop\\清理MSCMS重复副本.cmd';
console.log('脚本路径:', scr, '| 存在:', fs.existsSync(scr));

const r2 = spawnSync('cmd.exe', ['/c', scr], { input: 'NO\r\n', timeout: 30000 });
console.log('退出码:', r2.returncode);
console.log('--- 脚本输出（按 GBK 解码，验证中文不乱码）---');
console.log(dec(r2.stdout));
if (r2.stderr && r2.stderr.length) {
  console.log('--- stderr ---');
  console.log(dec(r2.stderr));
}

console.log('\n=========== 判定 ===========');
console.log('nul 可删          :', stillThere ? '否' : '是');
const txt = dec(r2.stdout);
console.log('中文无乱码        :', txt.includes('清理重复的桌面应用副本') ? '是' : '否');
console.log('走到取消分支      :', txt.includes('已取消') ? '是' : '否');
console.log('脚本可被 cmd 执行 :', txt.includes('MSCMS v14') ? '是' : '否');
