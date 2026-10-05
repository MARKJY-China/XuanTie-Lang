#!/bin/bash
# 构建 GLFW 双后端 (Wayland+X11) raylib 6.0 静态库 — Linux x86_64
# 产物对应: lib/渲染/libraylib.linux-amd64.a
#
# 依赖 (Arch Linux 示例): pacman -S base-devel cmake wayland libxkbcommon
#   - wayland (wayland-client / wayland-cursor / wayland-egl)
#   - libxkbcommon
#
# 可复现验证: 重编后 nm/strings 应含 Wayland 后端符号:
#   strings libraylib.a | grep -c wl_compositor   # >0 即含 Wayland 后端
#
# 背景 (issue #60): 默认 Linux 构建的 raylib/GLFW 仅含 X11 后端,
# Wayland 会话 (GNOME/KDE 默认) 下只能经 XWayland 运行;
# 本脚本启用 GLFW 双后端, GLFW 运行时优先 Wayland、自动回退 X11。
set -e
VER=6.0
cd "$(mktemp -d)"
curl -sL -o rl.tgz "https://codeload.github.com/raysan5/raylib/tar.gz/refs/tags/${VER}"
tar xzf rl.tgz && cd "raylib-${VER}"
mkdir build-wl && cd build-wl
cmake .. -DBUILD_SHARED_LIBS=OFF -DPLATFORM=Desktop \
  -DGLFW_BUILD_WAYLAND=ON -DGLFW_BUILD_X11=ON \
  -DGLFW_BUILD_DOCS=OFF -DGLFW_BUILD_TESTS=OFF -DGLFW_BUILD_EXAMPLES=OFF \
  -DCMAKE_BUILD_TYPE=Release
make -j"$(nproc)" raylib
cp raylib/libraylib.a "$(pwd)/../../../../../libraylib.linux-amd64.a" 2>/dev/null || cp raylib/libraylib.a /tmp/libraylib.linux-amd64.a
echo "产物: libraylib.a (双后端), 已复制到上级目录或 /tmp/"
echo "自检: strings raylib/libraylib.a | grep -c wl_compositor"
