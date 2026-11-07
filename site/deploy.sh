#!/usr/bin/env bash
# deploy.sh —— 文档站一键部署（构建 + 上传 + 原子切换）
#
# 设计目标：在 Git Bash 里一条命令完成「本地构建 → 打包 → 免密上传 → 服务器原子切换」，
# 不用打开 1Panel。与社区/铁铺不同，文档站没有后端进程，所以切换只是目录替换，无需重启服务。
#
# 用法：
#   bash site/deploy.sh                       # 构建并部署（读 site/.deploy.env）
#   bash site/deploy.sh --skip-build          # 直接用现有 dist 部署
#   bash site/deploy.sh --dry-run             # 只打印将执行的命令，不连服务器
#   SSH_HOST=1.2.3.4 bash site/deploy.sh      # 临时指定服务器
#   bash site/deploy.sh --remote /other/dir   # 临时指定远端目录
#
# 配置（优先级：命令行 > 环境变量 > site/.deploy.env > 默认）：
#   SSH_HOST     服务器地址（必填；没有默认值）
#   SSH_USER     SSH 用户（默认 root）
#   SSH_PORT     SSH 端口（默认 22）
#   REMOTE_ROOT  1Panel 站点根目录（默认 /opt/1panel/www/sites/xuantie.markjy.com）
#   REMOTE_DIR   远端静态目录（默认 $REMOTE_ROOT/index/dist）
#   LOCAL_DIST   本地构建产物（默认 site/.vitepress/dist）
#
# 服务器侧布局（与 1Panel 一致）：
#   $REMOTE_ROOT/{index,log,rewrite,ssl}，站点静态文件在 $REMOTE_DIR。
#   部署时先传到 $REMOTE_DIR.new，解包成功后把旧目录改名为 $REMOTE_DIR.prev 再换上新的；
#   任何一步失败都保留旧目录，线上不会出现半包状态。

set -euo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SITE_DIR/.." && pwd)"

# ---------- 配置 ----------
ENV_FILE="$SITE_DIR/.deploy.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
fi

SSH_HOST="${SSH_HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_PORT="${SSH_PORT:-22}"
REMOTE_ROOT="${REMOTE_ROOT:-/opt/1panel/www/sites/xuantie.markjy.com}"
REMOTE_DIR="${REMOTE_DIR:-$REMOTE_ROOT/index/dist}"
LOCAL_DIST="${LOCAL_DIST:-$SITE_DIR/.vitepress/dist}"

SKIP_BUILD=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --dry-run)    DRY_RUN=1 ;;
    --host)       SSH_HOST="${2:?--host 需要参数}"; shift ;;
    --user)       SSH_USER="${2:?--user 需要参数}"; shift ;;
    --port)       SSH_PORT="${2:?--port 需要参数}"; shift ;;
    --remote)     REMOTE_DIR="${2:?--remote 需要参数}"; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "未知参数: $1（用 --help 查看用法）" >&2; exit 2 ;;
  esac
  shift
done

if [ -z "$SSH_HOST" ]; then
  cat >&2 <<'EOF'
错误: 未配置服务器地址 SSH_HOST。

两种设置方式（只做一次）：
  1) 在 site/.deploy.env 里写（推荐，该文件已被 .gitignore 忽略）：
       SSH_HOST=你的服务器地址
       SSH_USER=root
       SSH_PORT=22
  2) 每次命令行临时给：
       SSH_HOST=你的服务器地址 bash site/deploy.sh
EOF
  exit 1
fi

SSH_TARGET="$SSH_USER@$SSH_HOST"
SSH_OPTS=(-p "$SSH_PORT" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=accept-new)

say() { printf '\033[36m%s\033[0m\n' "$*"; }
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s\n' "$*"
  else
    eval "$@"
  fi
}

# ---------- 1. 构建 ----------
if [ "$SKIP_BUILD" -eq 1 ]; then
  say "① 跳过构建（--skip-build）"
  [ -d "$LOCAL_DIST" ] || { echo "错误: $LOCAL_DIST 不存在，无法跳过构建" >&2; exit 1; }
else
  say "① 构建站点（sync + AI 层 + vitepress build + cleanUrls 兜底）"
  run "cd '$SITE_DIR' && npm run docs:build"
fi

[ -d "$LOCAL_DIST" ] || { echo "错误: 构建产物不存在: $LOCAL_DIST" >&2; exit 1; }
FILE_COUNT=$(find "$LOCAL_DIST" -type f | wc -l | tr -d ' ')
DIST_SIZE=$(du -sh "$LOCAL_DIST" | cut -f1)
say "   产物: $LOCAL_DIST（$FILE_COUNT 个文件，$DIST_SIZE）"

# ---------- 2. 连通性预检 ----------
say "② 预检 SSH 免密登录: $SSH_TARGET:$SSH_PORT"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] ssh %s %s true\n' "${SSH_OPTS[*]}" "$SSH_TARGET"
else
  if ! ssh "${SSH_OPTS[@]}" "$SSH_TARGET" true; then
    echo "错误: 免密 SSH 不可用。请先配置公钥登录（ssh-copy-id $SSH_TARGET），或检查地址/端口。" >&2
    exit 1
  fi
fi

# ---------- 3. 上传 + 原子切换 ----------
say "③ 上传并切换: $REMOTE_DIR"
# 说明：tar 走 ssh 流，不依赖服务器装 rsync；
#       .new 解包成功才动旧目录，失败时线上仍是旧版本。
# 说明：tar 走 ssh 流，不依赖服务器装 rsync；
#       .new 解包成功才动旧目录，失败时线上仍是旧版本。
#       脚本通过远端命令传入（不能占用 stdin——stdin 是 tar 数据流）。
REMOTE_CMD="set -e
mkdir -p '$REMOTE_DIR.new'
rm -rf '$REMOTE_DIR.new'/*
tar -xzf - -C '$REMOTE_DIR.new'
test -f '$REMOTE_DIR.new/index.html' || { echo '上传内容缺少 index.html，放弃切换' >&2; exit 3; }
if [ -d '$REMOTE_DIR' ]; then
  rm -rf '$REMOTE_DIR.prev'
  mv '$REMOTE_DIR' '$REMOTE_DIR.prev'
fi
mv '$REMOTE_DIR.new' '$REMOTE_DIR'
echo '远端切换完成'"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] tar -czf - -C %s . | ssh %s %s "<远端切换脚本>"\n' "$LOCAL_DIST" "${SSH_OPTS[*]}" "$SSH_TARGET"
else
  tar -czf - -C "$LOCAL_DIST" . | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$REMOTE_CMD"
fi

say "④ 验证远端入口"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '  [dry-run] ssh %s %s "ls -l %s/index.html"\n' "${SSH_OPTS[*]}" "$SSH_TARGET" "$REMOTE_DIR"
else
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "ls -l '$REMOTE_DIR/index.html' && ls -ld '$REMOTE_DIR.prev' 2>/dev/null || true"
fi

say "完成：https://xuantie.markjy.com/ （CDN/浏览器缓存可能延迟 1~2 分钟）"
