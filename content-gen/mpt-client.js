/**
 * ⚠️ [2026-09-17 标注] 本文件**当前零引用**（全仓 grep 仅自身命中）。
 * 真正在用的 MPT 客户端是 `content-gen/mpt-bridge.js`（被 providers.js:90 引用）。
 * 保留本文件仅供历史参考；已补齐 voice_name 必填项，避免将来被误用时踩同一个坑：
 *   MPT 的 TTS 在 voice_name 为空字符串时直接抛 `Invalid voice ''` 并令整单失败
 *   （2026-09-17 实测，任务在 audio 阶段 state=-1）。
 * ⚠️ 新增调用请一律使用 mpt-bridge.js。
 */
const http = require('http');

const MPT_HOST = '';
const MPT_PORT = 8080;

/**
 * 按语言挑选默认 TTS 语音（与 mpt-bridge.js 保持一致）。
 * 实测 azure_tts_v1 无需 Azure key 即可合成。
 */
 defaultVoiceFor(language) {
  const lang = String(language || '').toLowerCase();
  if (lang.startsWith('zh')) return 'zh-CN-XiaoxiaoNeural';
  if (lang.startsWith('en')) return 'en-US-JennyNeural';
  if (lang.startsWith('ja')) return 'ja-JP-NanamiNeural';
  if (lang.startsWith('ko')) return 'ko-KR-SunHiNeural';
  return 'zh-CN-XiaoxiaoNeural';
}

/**
 * POST to MPT API
 */
async  mptPost(endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: MPT_HOST,
      port: MPT_PORT,
      path: endpoint,
      method: 'POST',
      headers: {
        '': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ _raw: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(300000, () => { req.destroy(new Error('MPT timeout')); reject(new Error('MPT timeout')); });
    req.write(data);
    req.end();
  });
}

/**
 * GET from MPT API
 */
async  mptGet(endpoint) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: MPT_HOST,
      port: MPT_PORT,
      path: endpoint,
      method: 'GET',
    };

    const req = http.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); }
        catch(e) { resolve({ _raw: d }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('MPT GET timeout')); reject(new Error('MPT GET timeout')); });
    req.end();
  });
}

/**
 * Generate video script
 */
async  generateScript(subject, language = 'zh-CN', paragraphs = 1) {
  const result = await mptPost('/api/v1/scripts', {
    video_subject: subject,
    video_language: language,
    paragraph_number: paragraphs,
  });
  if (!result.data || !result.data.video_script) {
    throw new Error('MPT script generation failed: ' + JSON.stringify(result));
  }
  return result.data.video_script;
}

/**
 * Extract video terms
 */
async  generateTerms(script, amount = 5) {
  const result = await mptPost('/api/v1/terms', {
    video_script: script,
    amount,
  });
  if (!result.data || !result.data.video_terms) {
    throw new Error('MPT terms generation failed: ' + JSON.stringify(result));
  }
  return result.data.video_terms;
}

/**
 * Generate video via MPT
 */
async  generateVideo(opts = {}) {
  const {
    subject,
    script: providedScript,
    terms: providedTerms,
    aspect = '9:16',
    language = 'zh-CN',
    voiceName = null,
  } = opts;

  if (!subject) throw new Error('subject required');
  const voice = voiceName || defaultVoiceFor(language);

  let script = providedScript;
  if (!script) {
    script = await generateScript(subject, language);
  }

  let terms = providedTerms;
  if (!terms) {
    const termsResult = await generateTerms(script, 5);
    terms = Array.isArray(termsResult) ? termsResult : termsResult.video_terms;
  }

  const taskResult = await mptPost('/api/v1/videos', {
    video_subject: subject,
    video_script: script,
    video_terms: terms,
    video_aspect: aspect,
    video_source: 'openai_image',
    video_language: language,
    voice_name: voice,   // 必填：空值 → TTS 阶段 `Invalid voice ''` → 整单失败
    subtitle_enabled: true,
  });

  if (!taskResult.data || !taskResult.data.task_id) {
    throw new Error('MPT video generation failed: ' + JSON.stringify(taskResult));
  }

  const taskId = taskResult.data.task_id;
  console.log(`[MPT] Video generation started: taskId=${taskId}`);

  // Poll for completion
  let attempts = 0;
  const maxAttempts = 60;

  while (attempts < maxAttempts) {
    await new Promise(r => setTimeout(r, 5000));
    attempts++;

    const status = await mptGet(`/api/v1/tasks/${taskId}`);

    if (status.data) {
      const progress = status.data.progress || 0;
      const state = status.data.state;

      if (state === 1 && progress >= 100) {
        console.log(`[MPT] Video completed: ${taskId}`);
        if (status.data.videos && status.data.videos.length > 0) {
          return { taskId, videoUrl: status.data.videos[0] };
        }
      }

      if (state === -1) {
        throw new Error(`MPT video failed: ${status.data.error || 'unknown error'}`);
      }

      console.log(`[MPT] Progress: ${progress}%`);
    }
  }

  throw new Error(`MPT video timeout after ${maxAttempts * 5}s`);
}

// Test（仅直接运行本文件时执行；被 require 时不触发，避免误跑消耗 LLM 配额）
if (require.main === module) (async () => {
  try {
    console.log('Testing MPT connectivity...');
    const ping = await mptGet('/ping');
    console.log('Ping:', ping);

    console.log('\nGenerating script...');
    const script = await generateScript('Tumblr营销短视频介绍', 'zh-CN');
    console.log('Script:', script);

    console.log('\nGenerating terms...');
    const terms = await generateTerms(script, 5);
    console.log('Terms:', terms);

    console.log('\nAll tests passed!');
  } catch (err) {
    console.error('Test failed:', err.message);
  }
})();
