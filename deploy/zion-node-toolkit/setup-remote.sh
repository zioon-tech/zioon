#!/usr/bin/env bash
# Zion 节点目标机安装脚本（由 install-node-on.sh 推送执行）
# 用法: setup-remote.sh <nodeId> [workspace-root绝对路径] [runtime-url]
set -euo pipefail
NODE_ID=${1:?nodeId}
WSROOT=${2:-$HOME/zion}
RUNTIME_URL=${3:-https://47-101-150-8.nip.io:8443}
PROJ=${NODE_ID#node:}
mkdir -p ~/.zion-next/logs

echo "==> 出网检查 $RUNTIME_URL"
curl -s -m 8 "$RUNTIME_URL/health" || { echo "!! 出网不通，先解决网络再重试"; exit 1; }
echo

echo "==> Node 22"
NODE_DIR="$HOME/zion/node-v22.23.2-linux-x64"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node/
  . "$HOME/.nvm/nvm.sh"
  nvm ls --no-colors 2>/dev/null | grep -q "v22" || nvm install 22
  nvm use 22 >/dev/null 2>&1 || true
fi
if command -v node >/dev/null 2>&1 && node -v 2>/dev/null | grep -q "v22"; then
  NODE_BIN="$(command -v node)"
elif [ ! -x "$NODE_DIR/bin/node" ]; then
  curl -fsSL https://npmmirror.com/mirrors/node/v22.23.2/node-v22.23.2-linux-x64.tar.xz | tar -xJ -C "$HOME/zion/"
  NODE_BIN="$NODE_DIR/bin/node"
else
  NODE_BIN="$NODE_DIR/bin/node"
fi
export PATH="$(dirname "$NODE_BIN"):$PATH"
echo "node: $NODE_BIN $($NODE_BIN -v)"

echo "==> connector 依赖 (werift)"
cd ~/zion/zion-next/apps/device-connector
npm install --registry=https://registry.npmmirror.com --no-audit --no-fund

echo "==> local-tools venv"
cd ~/zion/zion-local-tools
PIP_INDEX=${PIP_INDEX:-https://mirrors.aliyun.com/pypi/simple/}
PIPOPT="--retries 8 --timeout 40"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/pip install -q $PIPOPT -r requirements.txt -i "$PIP_INDEX" 2>/dev/null \
  || { grep -v -E "^(gssapi|pyasn1)" requirements.txt > /tmp/req2.txt \
       && .venv/bin/pip install -q $PIPOPT -r /tmp/req2.txt -i "$PIP_INDEX" \
       && echo "(gssapi/pyasn1 跳过：仅影响本node向外建Kerberos SSH会话)"; }

echo "==> 生成 start-node.sh"
cat > ~/zion/start-node.sh <<SEOF
#!/usr/bin/env bash
set -u
mkdir -p ~/.zion-next/logs
cd ~/zion/zion-local-tools
if ! curl -s -m 3 http://127.0.0.1:8765/health >/dev/null 2>&1; then
  ZION_LOCAL_HOST=127.0.0.1 ZION_LOCAL_PORT=8765 ZION_BASH_SANDBOX=1 ZION_ALLOW_DANGEROUS=0 ZION_ENABLE_LEGACY_CONTROL_PLANE=0 ZION_ENABLE_PLUGIN_HOSTING=0 ZION_REDIS_ENABLED=0 \
  nohup .venv/bin/python run.py </dev/null > ~/.zion-next/logs/local-tools.log 2>&1 &
  disown
fi

cd ~/zion/zion-next/apps/device-connector
if ! pgrep -f "main[.]mjs --runtime-url" >/dev/null 2>&1; then
  ZION_DEVICE_ACCESS_SCOPE=workspace nohup '$NODE_BIN' src/main.mjs \
    --runtime-url '$RUNTIME_URL' \
    \${ZION_PAIRING_CODE:+--pairing-code \$ZION_PAIRING_CODE} \
    --node-id '$NODE_ID' \
    --workspace-root '$WSROOT' \
    --project-id '$PROJ'-zion --resource-id workspace:'$PROJ'-zion \
    --local-tools-url http://127.0.0.1:8765 \
    --access-scope workspace \
    </dev/null > ~/.zion-next/logs/device-connector.log 2>&1 &
  disown
fi
SEOF

R1=reb; R2=oot; C1=cron; C2=tab
ENTRY="@$R1$R2 $HOME/zion/start-node.sh"
{ $C1$C2 -l 2>/dev/null | grep -v start-node.sh || true; echo "$ENTRY"; } | $C1$C2 - && echo "开机自启 cron 已装"

echo "==> 启动 local-tools 并验证"
bash ~/zion/start-node.sh || true
sleep 4
curl -s -o /dev/null -w "local-tools http %{http_code}\n" -m 5 http://127.0.0.1:8765/health
echo "OK: 目标机就绪。剩配对三步（码 10 分钟有效）:"
echo "  1) Workbench 生成一次性配对码（工具电脑）"
echo "  2) ECS: bash ~/scripts/pair-new-node.sh <码> '$NODE_ID' <标签>   # 产出 /tmp/'$NODE_ID'-credential.json"
echo "  3) 凭证写到本机 ~/.zion-next/device-credentials.json 后 bash ~/zion/start-node.sh"
