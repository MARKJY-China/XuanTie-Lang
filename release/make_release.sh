#!/bin/bash
# ══════════════════════════════════════════════════════════════
# 玄铁一键发布:组包 → 安装器 → 压缩包(含 Defender 文件锁重试)
# 前置: Git Bash 环境; temp/innosetup 便携版 Inno Setup; 最新 build/xtc.exe / lsp/xt_lsp.exe / tiepm/tiepm.exe
# 用法: bash release/make_release.sh
# 产物: release/xuantie_v1.0-rc_setup.exe + release/xuantie_v1.0-rc_windows_amd64.zip
# ══════════════════════════════════════════════════════════════
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ISCC=$ROOT/temp/innosetup/ISCC.exe
VER=v1.0.0

[ -f "$ISCC" ] || { echo "错误: 未找到 $ISCC(Inno Setup 便携版)"; exit 1; }

echo "═══ 1/3 组包 ═══"
bash "$ROOT/release/make_pkg.sh"

echo "═══ 2/3 安装器 ═══"
(cd "$ROOT/release" && "$ISCC" xuantie_setup.iss)

echo "═══ 3/3 压缩包 ═══"
cd "$ROOT/temp/pkg_test"
rm -rf xuantie_${VER}_windows_amd64
cp -r XuanTie xuantie_${VER}_windows_amd64
# Compress-Archive 会撞 Defender 实时扫描对新拷贝文件的瞬时锁(arm_*.h 高发),带重试
for i in 1 2 3 4; do
  sleep 20
  if powershell -NoProfile -Command "Compress-Archive -Path 'xuantie_${VER}_windows_amd64' -DestinationPath '$ROOT\\release\\xuantie_${VER}_windows_amd64.zip' -CompressionLevel Optimal -Force"; then
    break
  fi
  echo "  zip 第 $i 次遇文件锁,等待重试..."
  if [ "$i" = "4" ]; then echo "错误: zip 重试 4 次仍被锁,请检查占用进程后重跑"; exit 1; fi
done

echo "═══ 发布物 ═══"
ls -la "$ROOT/release/xuantie_${VER}_setup.exe" "$ROOT/release/xuantie_${VER}_windows_amd64.zip"
echo "完成。验证建议: setup /VERYSILENT /CURRENTUSER /DIR=<临时目录> → 冒烟编译 → unins000 /VERYSILENT"
