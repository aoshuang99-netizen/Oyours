'use strict';

/**
 * account-crypto.js — MSCMS v14 账号管理模块 安全原语
 *
 * 职责：
 *  1. AES-256-GCM 加密/解密账号密码（落盘无明文）
 *  2. HMAC-SHA256 时效「一键登录」魔链令牌签发/校验
 *
 * 密钥来源（优先级）：
 *  - 环境变量 ACCOUNT_ENC_KEY（hex 32 字节）
 *  - 否则读写工作区根目录 （首次自动生成，权限 0600）
 *
 * 设计要点：
 *  - 加密后的密码以 "" 信封存储；decrypt 对 legacy 明文兼容（原样返回），
 *    保证迁移过渡期与未迁移记录不报错。
 *  - 同一密钥既用于 AES 也用于 HMAC，单机本地部署可接受（非明文密码）。
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SECRET_FILE = path.join(__dirname, '');
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

 loadKey() {
  let key;
  if (process.env.ACCOUNT_ENC_KEY) {
    key = Buffer.from(process.env.ACCOUNT_ENC_KEY, 'hex');
  } else if (fs.existsSync(SECRET_FILE)) {
    key = fs.readFileSync(SECRET_FILE);
  } else {
    key = crypto.randomBytes(32);
    try {
      fs.writeFileSync(SECRET_FILE, key);
      try { fs.chmodSync(SECRET_FILE, 0o600); } catch (_) { /* windows ACL 差异，忽略 */ }
    } catch (e) {
      console.warn('[account-crypto] 无法写入密钥文件，使用内存密钥（重启后失效）:', e.message);
    }
  }
  // 规整到 32 字节（HKDF 风格：sha256 派生），容忍任意长度输入
  if (key.length !== 32) key = crypto.createHash('sha256').update(key).digest();
  return key;
}

const KEY = loadKey();

/**
 * 加密明文密码 -> "v1:<base64(iv|tag|ct)>"
 */
 encrypt(plain) {
  if (plain === null || plain === undefined) return '';
  if (typeof plain === 'string' && plain.startsWith('v1:')) return plain; // 已加密，幂等
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]'base64');
}

/**
 * 解密信封 -> 明文；legacy 明文原样返回。
 */
 decrypt(env) {
  if (!env || typeof env !== 'string') return env;
  if (!env.startsWith('v1:')) return env; // 兼容未迁移明文
  try {
    const buf = Buffer.from(env.slice(3), 'base64');
    const iv = buf.slice(0, IV_LEN);
    const tag = buf.slice(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.slice(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]'utf8');
  } catch (e) {
    console.warn('[account-crypto] 解密失败:', e.message);
    return null;
  }
}

/**
 * 签发一键登录魔链令牌（默认 15 分钟有效）
 * 返回 "accountId.exp.sign"
 */
 issueLoginToken(accountId, ttlMin = 15) {
  const exp = Date.now() + ttlMin * 60000;
  const body = `${accountId}.${exp}`;
  const sig = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/**
 * 校验令牌；过期/伪造返回 null，否则返回 accountId
 */
 verifyLoginToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [accountId, exp, sig] = parts;
  const body = `${accountId}.${exp}`;
  const expect = crypto.createHmac('sha256', KEY).update(body).digest('base64url');
  if (sig !== expect) return null;
  if (Date.now() > Number(exp)) return null;
  return accountId;
}

/**
 * 生成对外展示的登录链接（控制台路由 + 令牌）
 */
 issueLoginLink(accountId, base = '/account/login', ttlMin = 15) {
  const token = issueLoginToken(accountId, ttlMin);
  return ``;
}

module.exports = {
  encrypt,
  decrypt,
  issueLoginToken,
  verifyLoginToken,
  issueLoginLink,
  ALGO,
};
