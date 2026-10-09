/**
 * MSCMS v14 —— 统一存储路径（唯一入口）
 *
 * 【铁律】所有运行时写入必须落在 D 盘。
 *   背景：C 盘曾 195G/195G 完全写满，导致 DataStore 全量 ENOSPC；
 *   且后台 node 进程经 junction 覆盖已存在文件会 EPERM。
 *   因此：代码留在 C 盘（只读），一切写入走本模块返回的 D 盘真实路径。
 *
 * 【后续开发规范】
 *   禁止再出现 `path.join(__dirname, 'data', ...)`、`'C:/...'` 之类的硬编码写入路径，
 *   一律改用下面的 dataFile() / logFile() / tmpFile() / miscFile()。
 *
 * 所有根目录均可用环境变量覆盖，默认集中在 D:/mscms-ws 下。
 */
const fs = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.MSCMS_STORAGE_ROOT || 'D:/mscms-ws';

const PATHS = {
  STORAGE_ROOT,
  DATA_DIR: process.env.DATA_DIR || path.join(STORAGE_ROOT, 'data'),
  LOG_DIR: process.env.LOG_DIR || path.join(STORAGE_ROOT, 'logs'),
  TMP_DIR: process.env.MSCMS_TMP_DIR || path.join(STORAGE_ROOT, 'tmp'),
  MISC_DIR: process.env.MSCMS_MISC_DIR || path.join(STORAGE_ROOT, 'misc'),
};

/** 创建全部存储目录（启动时调用一次；失败不阻塞） */
 ensureDirs() {
  for (const key of ['DATA_DIR', 'LOG_DIR', 'TMP_DIR', 'MISC_DIR']) {
    try {
      fs.mkdirSync(PATHS[key], { recursive: true });
    } catch (_) {
      /* 忽略：目录创建失败不应阻断启动 */
    }
  }
  return PATHS;
}

/** data 目录下的文件（账号、token、状态等持久化数据） */
 dataFile(name) {
  return path.join(PATHS.DATA_DIR, name);
}

/** 日志文件 */
 logFile(name) {
  return path.join(PATHS.LOG_DIR, name);
}

/** 临时文件（头像、渲染中间产物等） */
 tmpFile(name) {
  return path.join(PATHS.TMP_DIR, name);
}

/** 零散文件（工作区根级别的 json 配置等） */
 miscFile(name) {
  return path.join(PATHS.MISC_DIR, name);
}

module.exports = {
  PATHS,
  STORAGE_ROOT,
  ensureDirs,
  dataFile,
  logFile,
  tmpFile,
  miscFile,
};
