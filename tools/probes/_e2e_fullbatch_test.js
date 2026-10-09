'use strict';
// 真实端到端：模拟「全量分批一键发布」按钮的精确 API 路径（小批量 6 账号验证，零伪造）
const u = 'http://:3002';
const fs = require('fs');

(async () => {
  const accR = await (await fetch(u + '/api/v14/tumblr/')).json();
  const all = accR. || [];
  if (!all.length) { console.log('NO_ACCOUNTS'); return; }
  const chosen = all.slice(0, 6).map(a => a.id);

  // 全量一键发布预设：并发5 / 每批10 / 批间隔4s（此处用 6 账号小规模验证参数透传）
  const r = await fetch(u + '/api/v14/tumblr/batch-publish', {
    method: 'POST', headers: { '': 'application/json' },
    body: JSON.stringify({ videoId: 'content_1787822471711_dfz0p', accountIds: chosen, concurrency: 3, batchSize: 3, batchDelayMs: 1500 })
  });
  const d = await r.json();
  console.log('START taskId=', d.taskId, 'total=', d.total);

  let t;
  for (let i = 0; i < 60; i++) {
    t = await (await fetch(u + '/api/v14/tumblr/batch-publish/' + d.taskId)).json();
    if (t.status === 'done' || t.status === 'failed') break;
    await new Promise(res => setTimeout(res, 1500));
  }
  console.log('TASK status=', t.status, 'done=', t.done, 'success=', t.success, 'fail=', t.fail);
  console.log('FOLDER=', t.folder);
  console.log('EXCEL=', t.excel, 'ZIP=', t.zip);
  const okUrls = (t.results || []).filter(x => x.status === 'success').map(x => x.postUrl);
  console.log('REAL_POST_URLS(' + okUrls.length + '):');
  okUrls.forEach(x => console.log('  ' + x));

  // 校验历史落盘
  const histPath = 'D:/MSCMS-Published/history.json';
  const histExists = fs.existsSync(histPath);
  console.log('HISTORY_FILE_EXISTS=', histExists);
  if (histExists) {
    const arr = JSON.parse(fs.readFileSync(histPath, 'utf8'));
    const hit = arr.find(x => x.id === d.taskId);
    console.log('HISTORY_CONTAINS_TASK=', !!hit, 'persisted_success=', hit && hit.success);
  }

  // 校验列表接口
  const list = await (await fetch(u + '/api/v14/tumblr/batch-publish')).json();
  console.log('LIST_COUNT=', (list.tasks || [], 'includes_task=', (list.tasks || []).some(x => x.id === d.taskId));

  console.log('DONE_TEST');
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
