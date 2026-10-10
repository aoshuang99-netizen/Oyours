# Tumblr 发布规则（住宅 IP 墙 — 当前不可靠）

## 准入状态
⛔ **被住宅 IP 墙挡死**。V14 实测：数据中心 IP 发帖被重置（reset），reach 几乎为 0；
只有住宅住宅 IP 才能稳定出帖。Bright Data `isp_proxy1` zone 已被 Tumblr 屏蔽，其余 zone 待验证。

## 限流
- OAuth 1.0a，官方建议 ≤ 1 帖/秒/应用；实操按账号分散，单账号 ≤ 12 帖/天（已在 watchdog env `MSCMS_TUMBLR_POST_MAX_PER_DAY=12`）。
- 超额返回 429，需退避。

## 反机器人
- **风控主导 = 浏览器指纹 + 账号行为**，非单纯机房 IP（ShardX PoC 已验证）。
- 但**出口 IP 质量**仍是硬门槛：住宅 IP 是发得出去的必要条件（非充分）。
- 需 ShardX 防关联浏览器（:40325，HS256 JWT）+ 住宅代理组合。

## 内容格式
- 正文长度宽松（数千字符），富文本/图片/视频均支持。
- 标签 ≤ 30，前 5 个影响发现。
- **NSFW / Lok AI 成人内容必须打 NSFW 标注**，否则封号风险高。

## 算法偏好
- 标签发现流 + 推荐信息流；新账号冷启动靠高频合规互动。
- 当前因出口问题实质不可达，优先级降级为「绕路」。

## 预检规则
```json
{
  "maxLength": 4000,
  "maxTags": 30,
  "maxMedia": 10,
  "requireNSFWTagFor": ["nsfw", "lokai", "adult"],
  "ratePerDayPerAccount": 12,
  "proxyClass": "residential",
  "blockUnlessResidential": true
}
```
> `blockUnlessResidential:true` 表示：若当前出口非住宅 IP，content-gate 直接拦截，不浪费配额。

## 发布器映射
- `providers/tumblr-provider.js`
- `cloud-publisher.js`（Tumblr 主路径）
- `free--publisher.js` 路由键：`tumblr`（仅当住宅出口可用时启用）
