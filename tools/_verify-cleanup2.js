// 验证桌面清理脚本：可执行性 + GBK 中文渲染 + 取消分支安全
const { spawnSync } = require('child_process');
const fs = require('fs');

const CMD = 'C:\\Users\\AS\\Desktop\\清理MSCMS重复副本.cmd';

 run(input) {
  const r = spawnSync('cmd.exe', ['/c', CMD], {
    input: Buffer.from(input, 'ascii'),
    timeout: 30000,
    windowsHide: true,
  });
  const out = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
  let txt;
  try { txt = new TextDecoder('gbk').decode(out); } catch (_) { txt = out.toString('utf8'); }
  return { code: r.returncode, txt };
}

console.log('文件存在:', fs.existsSync(CMD), '| 字节:', fs.statSync(CMD).size);

const a = run('NO\r\n');
console.log('\n===== [取消分支] 退出码:', a.code, '=====');
console.log(a.txt);
console.log('--- 校验 ---');
console.log('  无乱码替换符 :', !a.txt.includes('\uFFFD'));
console.log('  走了取消分支 :', a.txt.includes('已取消'));
console.log('  含 D 段说明  :', a.txt.includes('MSCMS-Content 是另一个活跃目录'));
console.log('  未误删提示   :', !a.txt.includes('已删除 OK'));

// 空输入也应走取消
const b = run('\r\n');
console.log('\n===== [空输入] 退出码:', b.code, '| 走了取消分支:', b.txt.includes('已取消'));
