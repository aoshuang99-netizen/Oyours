# Bluesky 发布规则（扩量候选）

## 准入状态
🟡 待接入。协议 ATProto，使用 **App **（不能用主密码登录 API）。无设备指纹强校验，出口任意 IP 可达。

## 限流
- 公开 API：每端点 ≤ 300 帖/24h；关注/互动端点 ≤ 约 5000/24h。
- 建议发帖节奏 ≤ 5 条/秒、≤ 100 帖/小时，避开突发。
- 遇速率错误退避 30–60s。

## 反机器人
- App  + DID 体系，风控偏内容合规与举报。
- 无住宅 IP 强制要求；数据中心 IP 可用。

## 内容格式
- 单帖 ≤ **300 字符**（gradient 文本；超长需拆串）。
- Facets：链接/标签/提及自动解析，标签以 `#` 起，≤ 8 个为宜。
- 媒体：图片 ≤ 4，视频支持。

## 算法偏好
- 时间线 = 关注 + 算法推荐（engage 越高越推）。
- 冷启动靠：精准标签、跨帖互动、自定义 feed 订阅。
- 建议带 2–4 个垂直标签（dating/relationship/AI 向）。

## 预检规则
```json
{
  "maxLength": 300,
  "maxTags": 8,
  "maxMedia": 4,
  "requireApp": true,
  "ratePerHour": 100,
  "proxyClass": "any"
}
```

## 发布器映射
- `providers/bluesky-provider.js`（待建，基于 atproto SDK）
- `free--publisher.js` 路由键：`bluesky`
