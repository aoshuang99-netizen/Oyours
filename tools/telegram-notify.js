#!/usr/bin/env node
/**
 * -notify.js — MSCMS Telegram 推送通道
 * ---------------------------------------------------------------
 * 凭证来源（缺一即失败，绝不伪造）：
 *   1. 环境变量 TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID
 *   2. D:/mscms-ws/config/.json  { "": "...", "chatId": "...", "": "http://:10808" }
 *
 * 用法：
 *   node tools/-notify.js --text "消息"
 *   node tools/-notify.js --summary            # 发送今日日报摘要（summary-<today>.txt）
 *   node tools/-notify.js --summary --date 2026-09-07
 *   node tools/-notify.js --test               # 发送连通性测试
 *
 * 退出码：0 成功 / 2 缺凭证 / 1 发送失败
 */
const fs = require('fs');
const path = require('path');
const { fetchExt } = require(path.join(__dirname, '..', 'http-client.js'));

const CFG_FILE = 'D:/mscms-ws/config/.json';
const REPORT_DIR = 'D:/mscms-ws/reports/daily';

const argv = process.argv.slice(2);
const getArg = (k) => { const i = argv.indexOf(k); return i >= 0 ? (argv[i + 1] || true) : null; };
const text = getArg('--text');
const useSummary = argv.includes('--summary');
const isTest = argv.includes('--test');
const dateArg = getArg('--date');
const DAY = (dateArg && dateArg !== true) ? dateArg : new Date().toISOString().slice(0, 10);

 loadCred() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return { : process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID, : process.env.TELEGRAM_PROXY || 'http://:10808' };
  }
  if (fs.existsSync(CFG_FILE)) {
    try {
      const c = JSON.parse(fs.readFileSync(CFG_FILE, 'utf8'));
      if (c. && c.chatId) return { : c., chatId: String(c.chatId), : c. || 'http://:10808' };
      console.error('[凭证不完整] ' + CFG_FILE + ' 存在但缺 /chatId');
    } catch (e) { console.error('[配置损坏] ' + CFG_FILE + ': ' + e.message); }
  }
  return null;
}

(async () => {
  if (!text && !useSummary && !isTest) { console.error('用法: --text <消息> | --summary [--date ] | --test'); process.exit(1); }

  let msg;
  if (isTest) msg = '✅ MSCMS Telegram 通道连通测试 ' + new Date().toISOString().slice(0, 19).replace('T', ' ');
  else if (text) msg = String(text);
  else {
    const f = path.join(REPORT_DIR, `summary-${DAY}.txt`);
    if (!fs.existsSync(f)) { console.error(`[缺文件] ${f} —— 先运行 node tools/daily-report.js --date ${DAY}`); process.exit(1); }
    msg = fs.readFileSync(f, 'utf8');
  }

  const cred = loadCred();
  if (!cred) {
    console.error('[缺凭证] 未找到 Telegram Bot 凭证。请提供以下任一渠道，本工具不伪造发送结果：');
    console.error('  A. 环境变量 TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID');
    console.error('  B. 写入 ' + CFG_FILE + '：{"":"<@BotFather 发的 token>","chatId":"<你的数字 ID>"}');
    console.error('  获取方式：TG 搜索 @BotFather → /newbot → 拿 token；@userinfobot → 拿自己的 chatId');
    process.exit(2);
  }

  const url = `https://api..org/bot${cred.}/sendMessage`;
  const body = JSON.stringify({ chat_id: cred.chatId, text: msg, disable_web_page_preview: true });
  try {
    const res = await fetchExt(url, {
      method: 'POST', headers: { '': 'application/json' }, body,
      timeout: 20000,
    }, cred.);
    const j = await res.json().catch(() => ({}));
    if (res.status === 200 && j.ok) {
      console.log(`[已发送] Telegram 消息 ${msg.length} 字 → chat ${cred.chatId} (message_id=${j.result && j.result.message_id})`);
      process.exit(0);
    }
    console.error(`[发送失败] HTTP ${res.status} ` + JSON.stringify(j).slice(0, 300));
    process.exit(1);
  } catch (e) {
    console.error('[发送失败] ' + (e.message || e) + '  （检查代理 ' + cred. + ' 是否在线）');
    process.exit(1);
  }
})();
