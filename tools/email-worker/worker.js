/**
 * MSCMS 邮件接收 Worker（Cloudflare Email Routing → Worker）
 * ---------------------------------------------------------------
 * 定位：替代 tumblr-onboard-shardx.js 里凭空捏造的 `mscms<rand>@gmail.com`。
 *       catch-all 收下域名全部来信 → 存 Workers KV → 暴露 REST API 读信/取验证码。
 *
 * 入口：
 *   email(message, env)  ← Cloudflare Email Routing 投递
 *   fetch(request, env)  ← 管理 API
 *
 * 绑定：
 *   MAIL_KV   (kv_namespace)  邮件正文与元数据
 *   API_KEY   ()   管理 API 的鉴权密钥
 *   MAIL_DOMAIN (plain_text)  catch-all 收信域名，如 lokfeel.com（可省略，自动从收件人推断）
 *
 * API：
 *   GET    /                      健康检查（无需鉴权）
 *   POST   /new                   生成一个新地址并登记
 *   GET    /inbox?addr=&limit=    列出该地址的信（不含正文）
 *   GET    /msg?id=               读取单封全文（含提取到的验证码）
 *   GET    /code?addr=            直接取该地址最新一封的验证码
 *   DELETE /msg?id=               删除单封
 *   DELETE /purge?addr=           清空该地址
 *   GET    /addrs                 列出已登记地址
 *
 * 零伪造：所有返回值都来自真实存储；取不到就返回空/错误，不编造。
 */

const TTL_SEC = 7 * 24 * 3600;          // 邮件保留 7 天
const MAX_BODY = 60 * 1024;             // 单封正文截断上限
const KEY_PREFIX_MSG = 'msg:';
const KEY_PREFIX_ADDR = 'addr:';

/* ────────────────────────── 编解码工具 ────────────────────────── */

 b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/[^A-Za-z0-9+/=]/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

 decodeQP(s) {
  return String(s)
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/** RFC 2047 头解码：=?UTF-8?B?...?= / =?UTF-8?Q?...?= */
 decodeHeader(s) {
  return String(s || '').replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (m, cs, enc, val) => {
    try {
      if (/b/i.test(enc)) return b64ToUtf8(val);
      return decodeQP(val.replace(/_/g, ' '));
    } catch (_) { return m; }
  });
}

/* ────────────────────────── MIME 解析（单文件、无依赖） ────────────────────────── */

 parseRaw(raw) {
  const s = String(raw || '');
  const m = s.match(/\r?\n\r?\n/);
  const headEnd = m ? m.index : -1;
  const headerText = headEnd >= 0 ? s.slice(0, headEnd) : '';
  let body = headEnd >= 0 ? s.slice(headEnd + m[0].length) : s;

  const headers = {};
  for (const line of headerText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  const ctype = headers[''] || 'text/plain';
  const cte = (headers['content-transfer-encoding'] || '').toLowerCase();
  let text = '', html = '';

  const decodePart = (cteH, payload) => {
    const e = (cteH || '').toLowerCase();
    if (/base64/.test(e)) return b64ToUtf8(payload);
    if (/quoted-printable/.test(e)) return decodeQP(payload);
    return payload;
  };

  if (/multipart\//i.test(ctype)) {
    const bm = ctype.match(/boundary="?([^";]+)"?/i);
    if (bm) {
      for (const chunk of body.split('--' + bm[1])) {
        const hm = chunk.match(/\r?\n\r?\n/);
        if (!hm) continue;
        const ph = chunk.slice(0, hm.index).toLowerCase();
        const payload = chunk.slice(hm.index + hm[0].length);
        const decoded = decodePart((ph.match(/content-transfer-encoding:\s*([^\r\n;]+)/) || [])[1], payload);
        if (/:\s*text\/plain/i.test(ph) && !text) text = decoded;
        else if (/:\s*text\/html/i.test(ph) && !html) html = decoded;
      }
    }
  } else {
    const decoded = decodePart(cte, body);
    if (/text\/html/i.test(ctype)) html = decoded; else text = decoded;
  }

  return {
    subject: decodeHeader(headers['subject'] || ''),
    from: decodeHeader(headers['from'] || ''),
    to: decodeHeader(headers['to'] || ''),
    date: headers['date'] || '',
    text: String(text).slice(0, MAX_BODY),
    html: String(html).slice(0, MAX_BODY),
  };
}

/* ────────────────────────── 验证码提取 ────────────────────────── */

 extractCode(subject, text) {
  const body = String(text || '');
  const sub = String(subject || '');
  // 【2026-09-14 修】旧实现用单条正则 `(?:code|...)[^0-9A-Za-z]{0,24}([A-Z0-9]{4,8})/i`，
  //   两个真实误判（本地单测 T1/T3 复现）：
  //     "Your verification code is 482913" → 抓到 "code"（关键词后面紧跟的另一个词被当成码）
  //     "Your confirmation code"           → 抓到 "ation"（confirm 命中了 confirm·ation 的词干）
  //   根因：i 标志让 [A-Z0-9] 也吃小写字母，且没有要求「必须是含数字的 token」。
  //   改为：定位关键词 → 取其后 60 字符窗口 → 窗口内取第一个【含数字】的 4~8 位 token。
  const KW = /(?:code|verification|verify|confirm|passcode|pin|otp|kode|验证码|確認コード|认证码)/gi;
  const TOK = /([A-Za-z0-9]{4,8})/g;
  for (const src of [body, sub]) {
    KW.lastIndex = 0;
    let k;
    while ((k = KW.exec(src))) {
      const win = src.slice(k.index + k[0].length, k.index + k[0].length + 60);
      TOK.lastIndex = 0;
      let m;
      while ((m = TOK.exec(win))) {
        if (/\d/.test(m[1])) return m[1]; // 纯字母（code/ation/verify）一律不是验证码
      }
    }
  }
  // ② 独立成行的纯数字
  const b = body.match(/(?:^|\n)\s*(\d{4,8})\s*(?:\n|$)/);
  if (b) return b[1];
  // ③ 任意 4~8 位数字（最宽松，放最后）
  const c = (body + ' ' + sub).match(/\b(\d{4,8})\b/);
  if (c) return c[1];
  return null;
}

/* ────────────────────────── 存储 ────────────────────────── */

const j = (o, status = 200) => new Response(JSON.stringify(o), {
  status,
  headers: { '': 'application/json; charset=utf-8', 'cache-control': '' },
});

 randLocal(prefix) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = new Uint8Array(10);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 10; i++) s += a[buf[i] % a.length];
  return (prefix || 'mscms') + s;
}

async  listFor(env, addr, limit) {
  const out = await env.MAIL_KV.list({ prefix: KEY_PREFIX_MSG + addr + ':', limit: limit || 50 });
  const keys = (out.keys || []).map((k) => k.name).sort().reverse();
  const msgs = [];
  for (const k of keys) {
    const v = await env.MAIL_KV.get(k, 'json');
    if (v) msgs.push({ id: k, ...v });
  }
  msgs.sort((x, y) => (y.ts || 0) - (x.ts || 0));
  return msgs;
}

/* ────────────────────────── 入口 ────────────────────────── */

export default {
  /** Cloudflare Email Routing 投递入口 */
  async email(message, env, ctx) {
    const to = String(message.to || '').toLowerCase().trim();
    const from = String(message.from || '').trim();
    const ts = Date.now();
    const id = KEY_PREFIX_MSG + to + ':' + ts + ':' + Math.random(36).slice(2, 8);
    try {
      // ── CPU 保护：Workers 免费层仅 10ms CPU，大邮件（多为附件/营销图）不解析正文 ──
      const size = Number(message.rawSize || 0);
      if (size > 512 * 1024) {
        await env.MAIL_KV.put(id, JSON.stringify({
          to, from: from || '', subject: decodeHeader(message.headers.get('subject') || ''),
          date: message.headers.get('date') || '', ts, code: null, text: '',
          html: '', rawSize: size, skipped: 'too-large',
        }), { expirationTtl: TTL_SEC });
        console.log('mail stored (large, body skipped)', to, 'size=' + size);
        return;
      }

      const raw = await new Response(message.raw).text();
      const parsed = parseRaw(raw);
      const code = extractCode(parsed.subject, parsed.text) || extractCode(parsed.subject, parsed.html);
      const record = {
        to,
        from: from || parsed.from,
        subject: parsed.subject,
        date: parsed.date,
        ts,
        code,
        text: parsed.text,
        html: parsed.html,
        rawSize: raw.length,
      };
      // 【配额纪律】收信只消耗 1 次 KV 写。收件人登记交给 /new 做，
      // 否则每封信要 get+put addr 记录 → 2 写/封，把 1000 写/天 腰斩成 500 封/天。
      await env.MAIL_KV.put(id, JSON.stringify(record), { expirationTtl: TTL_SEC });
      console.log('mail stored', to, 'code=' + code + ' subject=' + parsed.subject.slice(0, 60));
    } catch (e) {
      console.error('mail store failed', to, e && e.message);
    }
  },

  /** 管理 API */
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    if (p === '/' || p === '/health') {
      return j({ ok: true, service: 'mscms-mail', domain: env.MAIL_DOMAIN || null, ttlDays: 7, send: !!env.SEND_EMAIL });
    }

    const key = request.headers.get('') || q.get('key') || '';
    if (!env.API_KEY || key !== env.API_KEY) return j({ ok: false, error: '' }, 401);
    if (!env.MAIL_KV) return j({ ok: false, error: 'MAIL_KV binding missing' }, 500);

    try {
      if (p === '/new' && request.method === 'POST') {
        let body = {};
        try { body = await request.json(); } catch (_) {}
        const local = (body.local || randLocal(body.prefix)).toLowerCase();
        const domain = body.domain || env.MAIL_DOMAIN;
        if (!domain) return j({ ok: false, error: 'MAIL_DOMAIN 未配置且请求未带 domain' }, 400);
        const address = local + '@' + domain;
        await env.MAIL_KV.put(KEY_PREFIX_ADDR + address, JSON.stringify({
          address, firstSeen: Date.now(), lastSeen: Date.now(), count: 0, label: body.label || null,
        }), { expirationTtl: 90 * 24 * 3600 });
        return j({ ok: true, address, localPart: local, domain });
      }

      if (p === '/inbox' && request.method === 'GET') {
        const addr = (q.get('addr') || '').toLowerCase();
        if (!addr) return j({ ok: false, error: 'addr required' }, 400);
        const msgs = await listFor(env, addr, Number(q.get('limit')) || 50);
        return j({
          ok: true, address: addr, count: msgs.length,
          messages: msgs.map((m) => ({
            id: m.id, from: m.from, subject: m.subject, date: m.date, ts: m.ts,
            code: m.code, preview: String(m.text || '').replace(/\s+/g, ' ').slice(0, 180),
          })),
        });
      }

      if (p === '/msg' && request.method === 'GET') {
        const id = q.get('id');
        if (!id) return j({ ok: false, error: 'id required' }, 400);
        const m = await env.MAIL_KV.get(id, 'json');
        if (!m) return j({ ok: false, error: 'not found' }, 404);
        return j({ ok: true, message: m });
      }

      if (p === '/code' && request.method === 'GET') {
        const addr = (q.get('addr') || '').toLowerCase();
        if (!addr) return j({ ok: false, error: 'addr required' }, 400);
        const msgs = await listFor(env, addr, 10);
        const hit = msgs.find((m) => m.code);
        return j({
          ok: !!hit, address: addr,
          code: hit ? hit.code : null,
          subject: hit ? hit.subject : null,
          ts: hit ? hit.ts : null,
          scanned: msgs.length,
        });
      }

      if (p === '/msg' && request.method === 'DELETE') {
        const id = q.get('id');
        if (!id) return j({ ok: false, error: 'id required' }, 400);
        await env.MAIL_KV.delete(id);
        return j({ ok: true, deleted: id });
      }

      if (p === '/purge' && request.method === 'DELETE') {
        const addr = (q.get('addr') || '').toLowerCase();
        if (!addr) return j({ ok: false, error: 'addr required' }, 400);
        const out = await env.MAIL_KV.list({ prefix: KEY_PREFIX_MSG + addr + ':', limit: 1000 });
        for (const k of out.keys || []) await env.MAIL_KV.delete(k.name);
        return j({ ok: true, purged: (out.keys || [], address: addr });
      }

      if (p === '/addrs' && request.method === 'GET') {
        const out = await env.MAIL_KV.list({ prefix: KEY_PREFIX_ADDR, limit: 1000 });
        const addrs = [];
        for (const k of out.keys || []) {
          const v = await env.MAIL_KV.get(k.name, 'json');
          if (v) addrs.push(v);
        }
        addrs.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
        return j({ ok: true, count: addrs.length, addresses: addrs });
      }

      // 【发信】需在部署时挂 send_email binding（cf-mail-setup.js --with-send）。
      // 用途：① 自发自收做链路自检 ② 后续平台要求回信确认时的回复通道。
      if (p === '/send' && request.method === 'POST') {
        if (!env.SEND_EMAIL) return j({ ok: false, error: 'SEND_EMAIL binding 未挂载（部署时加 --with-send）' }, 501);
        let body = {};
        try { body = await request.json(); } catch (_) {}
        if (!body.to) return j({ ok: false, error: 'to required' }, 400);
        try {
          await env.SEND_EMAIL.send({
            to: body.to,
            from: { email: body.from || ('noreply@' + (env.MAIL_DOMAIN || 'example.com')), name: body.fromName || 'MSCMS' },
            subject: body.subject || 'MSCMS mail pipeline test',
            text: body.text || 'Your verification code is 842197',
          });
          return j({ ok: true, to: body.to, sentAt: new Date().toISOString() });
        } catch (e) {
          return j({ ok: false, error: String(e && e.message || e) }, 500);
        }
      }

      return j({ ok: false, error: 'no such route: ' + p }, 404);
    } catch (e) {
      return j({ ok: false, error: String(e && e.message || e) }, 500);
    }
  },
};
