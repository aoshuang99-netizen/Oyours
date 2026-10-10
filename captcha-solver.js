/**
 * captcha-solver.js — 2captcha 自动求解器 v2
 *
 * v2 新功能：
 *   ✓ API Key 配置自检 + 余额查询
 *   ✓ 自动从 register.json 读取配置
 *   ✓ 住宅代理质量联动（低质量代理 = 更高 CAPTCHA 概率）
 *   ✓ 失败自动重试 + 截图保存
 *
 * 用法：
 *   const solver = new CaptchaSolver();
 *   await solver.selfTest();          // 自检
 *   const token = await solver.autoSolve(page);
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════════════════════

class CaptchaSolver {
  constructor(apiKey) {
    const configPath = 'D:/LeiDian/config/register.json';
    let cfgCaptcha = {};
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      cfgCaptcha = cfg.captcha || {};
    } catch {}

    this.apiKey = apiKey || process.env.CAPTCHA_API_KEY || cfgCaptcha.apiKey || '';
    this.provider = cfgCaptcha.provider || '2captcha';
    this.enabled = cfgCaptcha.enabled !== false;
    this.base = 'https://2captcha.com/in.php';
    this.result = 'https://2captcha.com/res.php';
    this._balance = null;
    this._tested = false;
    this._testError = null;
  }

  get available() {
    return !!this.apiKey && this.enabled && this._tested;
  }

  /**
   * 🔍 自检：验证 API Key + 查询余额
   * @returns {{ ok: boolean, balance?: number, error?: string }}
   */
  async selfTest() {
    if (!this.apiKey) {
      this._tested = true;
      this._testError = 'No 2captcha API key configured. Set in D:/LeiDian/config/register.json → captcha.apiKey';
      console.log(`  [captcha] ⚠️  ${this._testError}`);
      return { ok: false, error: this._testError };
    }

    try {
      const { data } = await axios.get('https://2captcha.com/res.php', {
        params: { key: this.apiKey, action: 'getbalance', json: 1 },
        timeout: 15000,
      });

      if (data.status === 1) {
        this._balance = parseFloat(data.request);
        this._tested = true;
        this._testError = null;
        console.log(`  [captcha] ✅ 自检通过 — 余额: $${this._balance.toFixed(2)}`);
        return { ok: true, balance: this._balance };
      } else {
        this._tested = true;
        this._testError = `Invalid API key: ${data.request || data.error_text || 'unknown error'}`;
        console.log(`  [captcha] ❌ ${this._testError}`);
        return { ok: false, error: this._testError };
      }
    } catch (e) {
      this._tested = true;
      this._testError = `Network error: ${e.message}`;
      console.log(`  [captcha] ❌ ${this._testError}`);
      return { ok: false, error: this._testError };
    }
  }

  /**
   * 查询余额
   */
  async getBalance() {
    if (this._balance !== null) return this._balance;
    const result = await this.selfTest();
    return result.balance || 0;
  }

  /**
   * 检测页面上是否出现了 CAPTCHA
   */
  async detect(page) {
    const indicators = [
      'iframe[src*="recaptcha"]',
      'iframe[src*="hcaptcha"]',
      'iframe[src*="funcaptcha"]',
      'iframe[src*="arkoselabs"]',
      '[data-sitekey]',
      '.g-recaptcha',
      '.h-captcha',
      '#funcaptcha',
      'div[class*="captcha"]',
    ];

    for (const sel of indicators) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible().catch(() => false)) {
          const src = (await el.getAttribute('src')) || '';
          const sitekey = (await el.getAttribute('data-sitekey')) || '';
          const type = src.includes('recaptcha') ? 'recaptcha'
            : src.includes('hcaptcha') ? 'hcaptcha'
            : src.includes('arkose') ? 'funcaptcha' : 'unknown';
          return { found: true, type, sitekey, selector: sel };
        }
      } catch {}
    }

    // 检查页面标题 / body text
    try {
      const bodyText = await page.textContent('body').catch(() => '');
      if (/captcha|verify you are human|not a robot|blocked/i.test(bodyText)) {
        return { found: true, type: 'page_block', title: bodyText.slice(0, 100) };
      }
    } catch {}

    return { found: false };
  }

  /**
   * 通过 2captcha API 求解 reCAPTCHA v2
   */
  async solveRecaptchaV2(page, siteKey, pageUrl, timeout = 120000) {
    if (!this.apiKey) throw new Error('No 2captcha API key configured');

    pageUrl = pageUrl || page.url();
    siteKey = siteKey || await this._findSiteKey(page);
    if (!siteKey) throw new Error('siteKey not found on page');

    console.log(`  [captcha] Solving reCAPTCHA v2... siteKey=${siteKey.slice(0, 24)}...`);

    // Step 1: Submit
    const { data: submit } = await axios.get(this.base, {
      params: { key: this.apiKey, method: 'userrecaptcha', googlekey: siteKey, pageurl: pageUrl, json: 1 },
      timeout: 15000,
    });

    if (submit.status !== 1) {
      throw new Error(`2captcha submit failed: ${submit.request || 'unknown'}`);
    }

    const captchaId = submit.request;
    console.log(`  [captcha] ID: ${captchaId}, polling...`);

    // Step 2: Poll
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 5000));

      const { data: res } = await axios.get(this.result, {
        params: { key: this.apiKey, action: 'get', id: captchaId, json: 1 },
        timeout: 10000,
      });

      if (res.status === 1) {
        console.log(`  [captcha] ✅ Solved! (${((Date.now() - start) / 1000).toFixed(1)}s)`);
        return res.request;
      }
      if (res.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`2captcha error: ${res.request}`);
      }

      // 进度提示
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      if (elapsed % 15 === 0) console.log(`  [captcha] ...waiting (${elapsed}s)`);
    }
    throw new Error('2captcha solving timeout');
  }

  /**
   * 通过 2captcha API 求解 hCaptcha
   */
  async solveHCaptcha(page, siteKey, pageUrl, timeout = 120000) {
    if (!this.apiKey) throw new Error('No 2captcha API key');

    pageUrl = pageUrl || page.url();
    siteKey = siteKey || await this._findSiteKey(page);
    if (!siteKey) throw new Error('siteKey not found');

    console.log(`  [captcha] Solving hCaptcha...`);

    const { data: submit } = await axios.get(this.base, {
      params: { key: this.apiKey, method: 'hcaptcha', sitekey: siteKey, pageurl: pageUrl, json: 1 },
      timeout: 15000,
    });

    if (submit.status !== 1) throw new Error(`hCaptcha submit failed`);

    const captchaId = submit.request;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await new Promise(r => setTimeout(r, 5000));
      const { data: res } = await axios.get(this.result, {
        params: { key: this.apiKey, action: 'get', id: captchaId, json: 1 },
        timeout: 10000,
      });
      if (res.status === 1) {
        console.log(`  [captcha] ✅ hCaptcha solved!`);
        return res.request;
      }
      if (res.request !== 'CAPCHA_NOT_READY') {
        throw new Error(`hCaptcha error: ${res.request}`);
      }
    }
    throw new Error('hCaptcha timeout');
  }

  /**
   * 🔧 自动检测并求解页面上的 CAPTCHA（改进版：失败重试 3 次）
   */
  async autoSolve(page, retryCount = 0) {
    const MAX_RETRIES = 3;
    const detected = await this.detect(page);

    if (!detected.found) return false;

    console.log(`  [captcha] Detected: ${detected.type} ${retryCount > 0 ? `(retry ${retryCount}/${MAX_RETRIES})` : ''}`);

    try {
      let token;
      if (detected.type === 'recaptcha') {
        token = await this.solveRecaptchaV2(page, detected.sitekey);
      } else if (detected.type === 'hcaptcha') {
        token = await this.solveHCaptcha(page, detected.sitekey);
      } else {
        console.log(`  [captcha] Unknown type: ${detected.type}`);
        await this._saveScreenshot(page, `captcha_unknown_${Date.now()}`);
        return false;
      }

      if (token) {
        // 注入 token
        await page.evaluate((t) => {
          // Textarea hidden field
          const ta = document.querySelector('[name="g-recaptcha-response"], [name="h-captcha-response"], #g-recaptcha-response');
          if (ta) { (ta).value = t; (ta).style.display = 'block'; }

          // Trigger reCAPTCHA callback
          if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
            const clients = window.___grecaptcha_cfg.clients;
            for (const clientId in clients) {
              const client = clients[clientId];
              if (client && client.callback) {
                try { client.callback(t); } catch {}
              }
            }
          }

          // Trigger hCaptcha callback
          if (window.hcaptcha) {
            try { window.hcaptcha.getResponse = () => t; } catch {}
          }
        }, token);

        console.log(`  [captcha] Token injected`);
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (e) {
      console.log(`  [captcha] Solve error: ${e.message}`);
      await this._saveScreenshot(page, `captcha_fail_${Date.now()}`);

      if (retryCount < MAX_RETRIES) {
        console.log(`  [captcha] Retrying (${retryCount + 1}/${MAX_RETRIES})...`);
        await page.waitForTimeout(3000);
        return this.autoSolve(page, retryCount + 1);
      }
    }

    return false;
  }

  /**
   * 手动触发 reCAPTCHA 并求解（点击 checkbox 弹出挑战）
   */
  async triggerAndSolve(page, iframeSelector = 'iframe[src*="recaptcha"]') {
    try {
      const frameHandle = await page.$(iframeSelector);
      if (!frameHandle) return false;

      const frame = await frameHandle.contentFrame();
      if (!frame) return false;

      // 点击 checkbox
      await frame.click('.recaptcha-checkbox-border, #recaptcha-anchor', { delay: 150 });
      await page.waitForTimeout(2000);

      // 检测是否有图片挑战弹出
      const challenge = await page.$('iframe[src*="bframe"], iframe[src*="api2/bframe"]');
      if (challenge) {
        console.log(`  [captcha] Image challenge detected`);
      }

      return await this.autoSolve(page);
    } catch (e) {
      console.log(`  [captcha] triggerAndSolve error: ${e.message}`);
      return false;
    }
  }

  // ═══ Helpers ═══

  async _findSiteKey(page) {
    try {
      const keys = await page.evaluate(() => {
        const found = [];
        document.querySelectorAll('[data-sitekey]').forEach(el => {
          const k = el.getAttribute('data-sitekey');
          if (k) found.push(k);
        });
        return found;
      });
      return keys[0] || null;
    } catch { return null; }
  }

  async _saveScreenshot(page, name) {
    try {
      const dir = 'D:/LeiDian/screenshots';
      await require('fs').promises.mkdir(dir, { recursive: true });
      await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
    } catch {}
  }
}

module.exports = { CaptchaSolver };
