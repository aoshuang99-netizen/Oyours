#!/bin/bash
# 加速四项运行态测量（只读）。每分钟采一次，共 N 分钟。
# 关注：真实发布速率 / 平台分布 / 账号分散度 / ready-queued 池迁移
LOGDIR="D:/mscms-ws/logs"
DATA="D:/mscms-ws/data"
MINUTES="${1:-25}"
echo "min,ts,tumblr_pub,nostr_pub,distinct_acct,queue_depth,ready,queued,ready_stale"
for i in $(seq 1 "$MINUTES"); do
  sleep 60
  L=$(ls -t "$LOGDIR"/server-3002-*.log 2>/dev/null | head -1)
  T=$(grep -c "✅ Tumblr 真实发布成功" "$L" 2>/dev/null || echo 0)
  N=$(grep -c "✅ provider 通道真实发布成功 nostr" "$L" 2>/dev/null || echo 0)
  D=$(grep -oE "account=tumblr_[a-z0-9]+" "$L" 2>/dev/null | sort -u | wc -l)
  Q=$(grep -oE "queue=[0-9]+" "$L" 2>/dev/null | tail -1 | cut -d= -f2)
  R=$(grep -o '"status":"ready"' "$DATA/content.json" 2>/dev/null | wc -l)
  U=$(grep -o '"status":"queued"' "$DATA/content.json" 2>/dev/null | wc -l)
  S=$(grep -o '"status":"ready_stale"' "$DATA/content.json" 2>/dev/null | wc -l)
  echo "$i,$(date +%H:%M:%S),$T,$N,$D,$Q,$R,$U,$S"
done
echo "=== 采样结束 ==="
