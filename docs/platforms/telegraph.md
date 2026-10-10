# Telegraph 发布规则（SEO 桥接 / 落地页）

## 准入状态
🟡 待接入。Telegraph 匿名发布，无需账号，秒级建页，适合做**内容落地页 + 外链桥接**，
为 kkmatch / Lok AI 导流与搜索引擎收录服务。

## 限流
- 匿名接口宽松，单 IP 建议 ≤ 10 页/分钟，避免触发临时限流。
- 单页内容上限约 64KB，节点数有限。

## 反机器人
- 极弱，无登录风控；主要风险是**滥用导致域名被搜索引擎降权**。
- 内容需原创/二创合规，禁止纯垃圾外链堆砌。

## 内容格式
- Telegraph 自有 Node 结构（段落/标题/图片/链接）。
- 支持富文本，无标签体系；外链可自由放置。

## 算法偏好
- 无平台内算法；价值在 **SEO 与外链权重**。
- 每页带规范外链回主站（kkmatch.com / hlua.cc.cd）。

## 预检规则
```json
{
  "maxBytes": 60000,
  "maxLinksPerPage": 20,
  "requireCanonicalBacklink": true,
  "ratePerMin": 10,
  "proxyClass": "any"
}
```

## 发布器映射
- `free--publisher.js` 路由键：`telegraph`
- `tools/` 下建 `telegraph-publisher.js`（待建）
