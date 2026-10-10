# KK Match SEO 规则（自有站收录）

## 准入状态
🟡 待接入。目标：提升 `kkmatch.com` 在英文市场（US/UK）的「AI Relationship / Dating」相关词收录与排名。
当前 kkmatch 后端 :8001，前端静态；域名为 Cloudflare 托管（zone status=pending，尚未完全接入 CF）。

## 限流
- 搜索引擎爬虫无硬限流，但**提交频率**需克制：IndexNow 单次 ≤ 10000 URL，每日提交 ≤ 数次。
- sitemap 更新后被动抓取即可，勿主动刷。

## 反机器人 / 收录约束
- 避免 cloaking（向爬虫与用户返回不同内容）—— 与已 DROP 的 `cloak-*` 模块冲突，禁用。
- 规范 canonical、结构化数据（JSON-LD Person/Product/FAQ）齐全。
- 移动端 375px 可正常渲染（响应式），否则收录降权。

## 内容格式
- 每页唯一 `<title>` + `<meta description>` + OpenGraph。
- 投放页 `pricing.html` 需美式 SaaS 结账 UI（PayPal + 信用卡单行按钮）。
- FAQ / 博客内容原创，植入关系行为学 + 脑科学维度（提升匹配准确度的采集维度）。

## 算法偏好
- Google 偏好 E-E-A-T（经验/专业/权威/可信）+ 原创长文 + 结构化数据。
- 近 3 个月脑科学 / 关系行为学结论转化为「用户交互端维度采集方案」可增强内容权威性。

## 预检规则（建站/发页前）
```json
{
  "requireMetaTitle": true,
  "requireMetaDescription": true,
  "requireCanonical": true,
  "requireJsonLd": true,
  "mobileViewportMinWidth": 375,
  "indexNowBatchMax": 10000,
  "proxyClass": "any"
}
```

## 发布器映射
- `tools/kkmatch-dau-report.js`（已有 DAU 报告）
- 新增 `tools/seo-submit.js`（IndexNow + sitemap ping，待建）
