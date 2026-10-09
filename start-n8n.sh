#!/usr/bin/env bash
# 启动 n8n 并注入渠道环境变量（）
set -a
source "$(dirname "$0")/"
set +a
cd "$(dirname "$0")"
# env injection evidence (no secret value leaked, only SET/EMPTY + length)
{
  echo "=== n8n env injection check @ $(date -u +%FT%TZ) ==="
  for v in MASTODON_INSTANCE MASTODON_TOKEN BLUESKY_IDENTIFIER BLUESKY_ BLUESKY_PDS_HOST TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID DISCORD_WEBHOOK_ID DISCORD_WEBHOOK_TOKEN TUMBLR_BLOG ; do
    val="${!v}"
    if [ -n "$val" ]; then echo "$v = SET (len ${#val})"; else echo "$v = EMPTY"; fi
  done
} >> n8n-env-check.log
# 关键：n8n 默认禁止节点/表达式读取 process.env（$env.*）。必须显式放开，
# 否则 HTTP 节点里的 {{ $env.TELEGRAM_BOT_TOKEN }} 等会报 "access to env vars denied"。
export N8N_BLOCK_ENV_ACCESS_IN_NODE=false
NODE=/c/Users/AS//binaries/node/versions/22.22.2/node.exe
exec "$NODE" node_modules/n8n/bin/n8n start
