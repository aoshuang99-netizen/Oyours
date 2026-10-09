# Tumblr 每日注册 — 执行报告（2026-09-14）

## 结论：DONE

| 项 | 值 |
|---|---|
| 计划注册数 | 10 |
| 实际尝试 | 10 |
| 成功 | 6 |
| 失败 | 4 |
| 耗时 | 11.7 分钟 |
| 退出码 | 0 |
| ShardX | shardx-launcher v0.1.10 认证通过 · running profiles=0 |
| token | 本地 JWT 有效至 2026-10-11T05:40:00.000Z |
| 注册器 | tumblr-onboard-shardx.js |

```
  创建接口: ✅ HTTP 200
  创建接口: ✅ HTTP 200
❌   流程异常: page.waitForSelector: Timeout 30000ms exceeded.
  创建接口: ✅ HTTP 200
  创建接口: ✅ HTTP 200
  创建接口: ✅ HTTP 200
  创建接口: ✅ HTTP 200
  ✅ tumblr_ztcwt2ou blog=mscms1elh25m unit=2a09:bac5:624d:1187 ip=2a09:bac5:638d:1246::1d2:14 token=OK
  ✅ tumblr_3u5nkifn blog=mscmsjd98cys unit=2a09:bac5:624d:183c ip=2a09:bac5:624d:1846::26b:c6 token=OK
  ❌ tumblr_xrvp4e0g blog=- unit=- ip=- reason=exception:page.waitForSelector: Timeout 30000ms exceeded.
  ✅ tumblr_sup1eljp blog=mscmsbpvc4zl unit= ip= token=OK
  ✅ tumblr_2ek22wwh blog=mscmst0d0aue unit=2a09:bac5:624d:281e ip=2a09:bac5:638d:3050::4d0:22 token=OK
  ✅ tumblr_0bwq4edn blog=mscmso49v12p unit=2a09:bac5:624d:78 ip=2a09:bac5:638d:28::4:345 token=OK
  ✅ tumblr_dzpd4fw2 blog=mscmspw0tovu unit=2a09:bac5:624d:1173 ip=2a09:bac5:638d:3050::4d0:78 token=OK
  ❌ tumblr_bvc8lyyp blog=mscms2veneo4 unit=2a09:bac5:624d:1173 ip=2a09:bac5:624d:1173::1bd:a7 reason=throttled:单元 2a09:bac5:624d:1173 需间隔 10 分钟，还需等 8.9 分钟
  ❌ tumblr_43vdprcc blog=mscmsib4yjn4 unit=2a09:bac5:624d:78 ip=2a09:bac5:638d:3050::4d0:78 reason=throttled:单元 2a09:bac5:624d:78 / 实测出口 2a09:bac5:638d:3050::4d0:78 需间隔 10 分钟，还需等 8.5 分钟
  ❌ tumblr_mxp8qgkv blog=mscmsqu0qd53 unit=2a09:bac5:624d:281e ip=2a09:bac5:638d:28::4:330 reason=throttled:单元 2a09:bac5:624d:281e / 实测出口 2a09:bac5:638d:28::4:330 需间隔 10 分钟，还需等 4.6 分钟
```

> 由 `tumblr-daily-.js` 于 2026-09-14T01:16:13.122Z 自动生成。零假数据：未执行的步骤不做任何成功声称。
