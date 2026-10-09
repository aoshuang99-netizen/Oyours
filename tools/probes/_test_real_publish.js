/**
 * 全链路真实业务测试：S4 发布环节
 * 用一个真实已授权的 Tumblr 账号发一条真实文字帖，验证能否返回真实外网 postUrl。
 * 零伪造：不使用任何模拟数据，失败即如实报告。
 */
const { DataStore } = require('./data-store.js');
const { TumblrPublisher } = require('./tumblr-publisher.js');

const DATA_DIR = 'D:\\mscms-ws\\data2';

(async () => {
  process.env.MSCMS_DATASTORE_WRITE_MODULES = process.env.MSCMS_DATASTORE_WRITE_MODULES || '*,-content';
  // [2026-09-12] 本脚本不是 content 属主：显式声明写入范围，防止与主服务抢写（多写者覆盖）
  const ds = new DataStore(DATA_DIR);
  const publisher = new TumblrPublisher(ds);

  // 1) 找有 token 的账号
  const tokenItems = ds.list('', { limit: 500 }).items || [];
  console.log('token 数 = ' + tokenItems.length);

  const  = ds.list('', { limit: 1000 }).items || [];
  const accById = {};
  for (const a of ) accById[String(a.id)] = a;

  let picked = null;
  for (const t of tokenItems) {
    const aid = String(t.id || t.accountId || '');
    const acc = accById[aid];
    const blog = (acc && (acc.blog || acc.blogName || acc.)) ||
      (t.blog || t.blogName || '');
    if (blog) { picked = { accountId: aid, blog, token: t }; break; }
  }

  if (!picked) {
    console.log('❌ 未找到同时具备 token 与 blog 名的账号，无法进行真实发布测试');
    process.exit(2);
  }

  console.log('选用账号: accountId=' + picked.accountId + '  blog=' + picked.blog);

  // 2) 真实发一条文字帖
  const title = 'MSCMS 真实链路自检 ' + new Date().toISOString().slice(0, 19);
  const body = '这是一条由 MSCMS v14 全链路真实业务测试自动发出的验证帖，用于确认 OAuth1.0a 发布通道真实可用。';
  try {
    const res = await publisher.postText(picked.blog, {
      title,
      body,
      tags: ['mscms', 'selftest'],
      state: 'published',
    }, picked.accountId);
    console.log('发布返回: ' + JSON.stringify(res).slice(0, 400));
    if (res && (res.postUrl || res.url)) {
      console.log('✅ 真实发布成功, postUrl = ' + (res.postUrl || res.url));
    } else {
      console.log('⚠️ 调用返回但未拿到 postUrl（需检查返回结构）');
    }
  } catch (e) {
    console.log('❌ 真实发布失败: ' + (e && e.message ? e.message : String(e)).slice(0, 300));
  }
  process.exit(0);
})();
