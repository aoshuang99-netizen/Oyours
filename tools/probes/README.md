# tools/probes/ 开发探针索引

> 本目录由 M0·T7 工作区清理从仓库根目录归档而来（原 92 个 `_*.js` 独立开发/诊断脚本）。
> 这些脚本**不被 server.js 或任何业务模块引用**，均为手动触发的独立 Node 脚本。
> 运行方式：

```bash
node tools/probes/_probe_signup.js   # 示例：从仓库根目录或 tools/probes 下均可
```

> 注意：部分探针会直接读写 `D:/mscms-ws/data` 或 MySQL(3307)。按铁律——**改 data/*.json 前必须先停 3002**，避免 DataStore flush 覆盖。

## 分类清单（共 92 个）

### 账号 / Account（1）

- `_acct.js`

### B 轮验证 / B-round（2）

- `_b2_validate.js`
- `_b3_validate.js`

### 批量 / Batch（2）

- `_batch.js`
- `_batch2.js`

### 因果链 / Causal-chain（扫描·诊断）（5）

- `_chain_diag.js`
- `_chain_scan.js`
- `_chain_scan2.js`
- `_chain_scan3.js`
- `_chain_test.js`

### 校验 / Verify（最终复检·字段校验）（9）

- `_check_fake_time.js`
- `_checknow.js`
- `_chkjson.js`
- `_final_b3.js`
- `_final_verify.js`
- `_verify_5sim.js`
- `_verify_fix.js`
- `_verify_live_publish.js`
- `_verify_.js`

### 清理 / Cleanup（假数据·JSON·MySQL）（5）

- `_clean2.js`
- `_clean_fake_now.js`
- `_clean_fake_posts.js`
- `_cleanup_fake.js`
- `_cleanup_mysql_fake.js`

### 诊断 / Diagnostics（瓶颈·代理·发布·管线）（6）

- `_diag_bottleneck.js`
- `_diag_content.js`
- `_diag_pipeline.js`
- `_diag_proxy.js`
- `_diag_proxy2.js`
- `_diag_publish.js`

### 端到端测试 / E2E（批量·发布）（3）

- `_e2e_batch_test.js`
- `_e2e_fullbatch_test.js`
- `_e2e_publish_test.js`

### 假数据清理 / Fake-data（2）

- `_fake2.js`
- `_fake3.js`

### 抓取 / Grab（1）

- `_grab_full.js`

### 实时发布 / Live-publish-test（1）

- `_live_publish_test.js`

### 网络 / Net-diag（1）

- `_net_diag.js`

### OAuth / Demo（1）

- `_oauth_demo.js`

### 观察 / Observe（1）

- `_observe.js`

### 探针 / Probe（注册·邮箱·验证码·生日）（24）

- `_probe_1secmail.js`
- `_probe_.js`
- `_probe_2.js`
- `_probe_3.js`
- `_probe_direct.js`
- `_probe_email.js`
- `_probe_execute_submit.js`
- `_probe_grec2.js`
- `_probe_grecaptcha.js`
- `_probe_iso.js`
- `_probe_loop.js`
- `_probe_mailtm.js`
- `_probe_mailtm2.js`
- `_probe_p2.js`
- `_probe_p2b.js`
- `_probe_proxies.js`
- `_probe_recap.js`
- `_probe_signup.js`
- `_probe_state.js`
- `_probe_tumblr.js`
- `_probe_tumblr_reg.js`
- `_probe_validate.js`
- `_probe_validate2.js`
- `_probe_verify_mail.js`

### 其他 / Other（账号·批次·工具）（26）

- `_remix_status.js`
- `_restart_cycle.js`
- `_setup_bd_pool.js`
- `_shardx_api.js`
- `_shardx_fetch.js`
- `_shardx_runtime.js`
- `_shardx_token.js`
- `_slim2.js`
- `_sz.js`
- `_t.js`
- `_test_capsolver.js`
- `_test_domains.js`
- `_test_email_services.js`
- `_test_gh_proxies.js`
- `_test_gm_domains.js`
- `_test_gmail.js`
- `_test_gmail_oauth.js`
- `_test_publish.js`
- `_test_real_publish.js`
- `_test_token_valid.js`
- `_test_tumblr_reg.js`
- `_tmp_a.js`
- `_tmp_b.js`
- `_tmp_eval.js`
- `_tok.js`
- `_tumblr_antifraud_probe.js`

### 扫描 / Scan（2）

- `_scan_proxies_v3.js`
- `_scan_publish.js`

