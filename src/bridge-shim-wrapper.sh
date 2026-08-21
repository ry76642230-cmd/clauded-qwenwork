#!/bin/sh
# bridge-shim-wrapper.sh — macOS 可执行包装器
# 被 QODER_CLI_PATH 指向，调用 node 执行真正的 bridge-shim.mjs
#
# 注意：千问办公 SDK spawn 时 PATH 被限制为 /usr/bin:/bin:/usr/sbin:/sbin 等系统路径，
# 不包含 /opt/homebrew/bin，所以 #!/usr/bin/env node 和裸 node 都找不到。
# 必须硬编码常见 node 安装路径做探测。

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Node 路径探测：QODER_BRIDGE_NODE > 常见路径 > PATH 回退
NODE_BIN="${QODER_BRIDGE_NODE:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/current/bin/node" \
    "$HOME/.volta/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.bun/bin/bun"; do
    if [ -x "$candidate" ]; then
      NODE_BIN="$candidate"
      break
    fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="node"  # 最后回退到 PATH 查找
fi

exec "$NODE_BIN" "$SCRIPT_DIR/bridge-shim.mjs" "$@"
