#!/usr/bin/env bash
# Zion 节点一键部署（Mac 侧入口）：rsync 推码 + 目标机环境安装 + 常驻配置
# 用法: bash install-node-on.sh <ssh目标(别名或user@host)> <nodeId> [workspace-root绝对路径]
# 例:   bash install-node-on.sh las-dev node:las-dev
# 前提: Mac 已 kinit；las-dev 必须用 ssh 别名（ProxyJump），不能传裸 IP
set -euo pipefail
retry() { local n=5 i; for i in $(seq 1 $n); do "$@" && return 0; echo "[retry $i/$n] failed: $*" >&2; sleep 5; done; return 1; }
TARGET=${1:?用法: install-node-on.sh <ssh目标> <nodeId> [workspace-root]}
NODE_ID=${2:?nodeId 例如 node:las-dev}
WSROOT=${3:-}
SRC_TOOLS="$HOME/Downloads/zion-local-tools"
SRC_NEXT="$HOME/Downloads/zion-next/.worktrees/core-observability"
TOOLKIT="$(cd "$(dirname "$0")" && pwd)"

echo "==> [1/5] 预检 SSH"
retry ssh -o BatchMode=yes -o ConnectTimeout=10 "$TARGET" 'echo "ok: host=$(hostname) user=$(whoami)"'

echo "==> [2/5] rsync 推码"
retry ssh -o BatchMode=yes "$TARGET" 'mkdir -p ~/zion/zion-next/apps'
rsync -a --delete \
  --exclude '.venv' --exclude '__pycache__' --exclude '.mypy_cache' --exclude '.ruff_cache' --exclude '.pytest_cache' \
  --exclude 'daft-operator-guide' --exclude 'xbotgo_exp' --exclude 'Downloads' --exclude 'tmp' \
  --exclude '*.zip' --exclude '*.mp4' --exclude '*.log' \
  "$SRC_TOOLS/" "$TARGET:~/zion/zion-local-tools/"
retry rsync -a "$SRC_NEXT/package.json" "$TARGET:~/zion/zion-next/"
retry rsync -a "$SRC_NEXT/apps/device-connector" "$TARGET:~/zion/zion-next/apps/"
retry rsync -a "$SRC_NEXT/packages" "$TARGET:~/zion/zion-next/"

echo "==> [3/5] 目标机环境安装"
retry rsync -a "$TOOLKIT/setup-remote.sh" "$TARGET:~/zion/"
retry ssh -o BatchMode=yes "$TARGET" "bash ~/zion/setup-remote.sh '$NODE_ID' '$WSROOT'"

echo "==> [4/5] 完成。剩余配对三步（码 10 分钟有效，生成后立刻做）："
echo "  1) Workbench(runtime.zioon.tech) → 设置 → 服务 → 设备与远程访问 → 工具电脑 → 生成一次性配对码"
echo "  2) ECS: bash ~/scripts/pair-new-node.sh <码> $NODE_ID <标签>   # 产出 /tmp/$NODE_ID-credential.json"
echo "  3) 凭证写到目标机 ~/.zion-next/device-credentials.json 后: ssh $TARGET bash ~/zion/start-node.sh"
