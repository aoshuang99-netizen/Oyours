// MSCMS v14 桌面快捷方式生成器（纯字节流写 .lnk，不依赖 WScript.Shell COM）
// 用法: <node.exe> tools/make-mscms-shortcut.js
// 目标: D:\MSCMS-Desktop\MSCMS v14 Desktop.exe  （唯一保留的那份桌面应用）
// 图标: D:\MSCMS-Desktop\assets\icon.ico        （新生成的 M 图标）
'use strict';
const fs = require('fs');
const path = require('path');

const DESKTOP = ['C:', '\\Users', '\\AS', '\\Desktop'].join('');
const TARGET = ['D:', '\\MSCMS-Desktop', '\\MSCMS v14 Desktop.exe'].join('');
const WORKDIR = ['D:', '\\MSCMS-Desktop'].join('');
const ICONPATH = ['D:', '\\MSCMS-Desktop', '\\assets', '\\icon.ico'].join('');
const ARGS = '--no-sandbox --disable-gpu --disable-features=Vulkan';
const NAME = 'MSCMS v14 Desktop';
const OUT = path.join(DESKTOP, NAME + '.lnk');

const FILE_SIZE = fs.statSync(TARGET).size;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n & 0xFFFF, 0); return b; };
const ascii = (s) => Buffer.from(s + '\0', 'ascii');
const uni = (s) => Buffer.from(s + '\0', 'utf16le');

const linkInfoHeaderSize = 0x1C;
const lbpAscii = ascii(TARGET);
const lbpUni = uni(TARGET);
const linkInfoSize = linkInfoHeaderSize + lbpAscii.length + lbpUni.length;

const linkInfo = Buffer.concat([
  u32(linkInfoSize), u32(linkInfoHeaderSize), u32(0), u32(0),
  u32(linkInfoHeaderSize), u32(0), u32(0),
  lbpAscii, lbpUni,
]);

// StringData 顺序：NAME → RELATIVE_PATH → WORKING_DIR → ARGUMENTS → ICON_LOCATION
const stringData = Buffer.concat([
  uni(NAME), uni(''), uni(WORKDIR), uni(ARGS), uni(ICONPATH),
]);

// HasLinkInfo|HasName|HasRelativePath|HasWorkingDir|HasArguments|HasIconLocation|IsUnicode
const linkFlags = 0x02 | 0x04 | 0x08 | 0x10 | 0x20 | 0x40 | 0x80; // = 0xFE

const header = Buffer.concat([
  u32(0x4C),
  Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
               0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]),
  u32(linkFlags), u32(0x00000020),
  Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8),
  u32(FILE_SIZE), u32(0), u32(0x00000001), u16(0), u16(0), u32(0), u32(0),
]);

const out = Buffer.concat([header, linkInfo, stringData]);
fs.writeFileSync(OUT, out);

// ── 回读校验 ──
const back = fs.readFileSync(OUT);
const liSize = back.readUInt32LE(76);
let end = 104; while (back[end] !== 0) end++;
let off = 76 + liSize;
const readUni = () => { let e = off; while (!(back[e] === 0 && back[e + 1] === 0)) e += 2; const s = back.toString('utf16le', off, e); off = e + 2; return s; };
const f = back.readUInt32LE(20);

console.log('写入:', OUT, back.length, 'bytes');
console.log('HeaderSize :', '0x' + back.readUInt32LE(016));
console.log('LinkFlags  :', '0x' + f.toString(16));
console.log('Target     :', back.toString('ascii', 104, end));
console.log('NAME       :', readUni());
console.log('REL_PATH   :', JSON.stringify(readUni()));
console.log('WORKDIR    :', readUni());
console.log('ARGS       :', readUni());
console.log('ICON       :', readUni());
console.log('图标存在   :', fs.existsSync(ICONPATH));
console.log('目标存在   :', fs.existsSync(TARGET));
