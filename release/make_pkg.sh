#!/bin/bash
# ══════════════════════════════════════════════════════════════
# 玄铁发行包一键组装(在开发机运行)
# 产出: temp/pkg_test/XuanTie/(payload,供 Inno Setup 与压缩包共用)
# 依赖: 开发机的 LLVM($LLVM_DIR)、TDM-GCC($TDM_DIR)、已构建的 build/xtc.exe 等
# 用法: **必须在 Git Bash 中运行** → bash release/make_pkg.sh
#       (PowerShell 里直接敲 bash 会命中 WSL 的 bash,没有 /g 盘符挂载,脚本报 Permission denied)
# ══════════════════════════════════════════════════════════════
set -e

# 环境守卫:仅支持 Git Bash / MSYS2(WSL 的盘符布局是 /mnt/<盘>,不兼容)
if ! uname | grep -qiE "MINGW|MSYS"; then
  echo "错误: 请在 Git Bash 中运行此脚本(当前环境疑似 WSL/Cygwin:$(uname -a | cut -c1-60))"
  echo "      PowerShell 用法: & \"C:\Program Files\Git\bin\bash.exe\" release/make_pkg.sh"
  exit 1
fi

# 自定位仓库根(脚本固定在 release/ 下,仓库根即其上一级),兼容任意克隆位置
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LLVM_DIR=${LLVM_DIR:-/d/LLVM}
TDM_DIR=${TDM_DIR:-/c/TDM-GCC-64}
TDM_VER=10.3.0
CLANG_RES_VER=22
PKG=$ROOT/temp/pkg_test/XuanTie

# 工具链前置检查:缺了立即明确报错,不静默烂尾
[ -f "$LLVM_DIR/bin/clang.exe" ] || { echo "错误: 未找到 clang($LLVM_DIR),请设 LLVM_DIR 环境变量指向 LLVM 根目录"; exit 1; }
[ -f "$TDM_DIR/bin/gcc.exe" ]    || { echo "错误: 未找到 gcc($TDM_DIR),请设 TDM_DIR 环境变量指向 TDM-GCC 根目录"; exit 1; }
[ -f "$ROOT/build/xtc.exe" ]     || { echo "错误: 未找到 build/xtc.exe,请先构建编译器"; exit 1; }

rm -rf $ROOT/temp/pkg_test
mkdir -p $PKG/{runtime,lib,tools,GUIDE,examples}

# ── 1. 编译器 / 包管理器(LSP 二进制已内置于 VSCode 插件 vsix,发行包不重复携带)──
cp $ROOT/build/xtc.exe $PKG/xtc.exe
cp $ROOT/tiepm/tiepm.exe $PKG/

# ── 2. 自带极简工具链(孤立实测验证过的最小集)──
# clang: 单 exe(静态链接 LLVM)+ 内建头文件目录;发行环境只用它编 .ll→.o,无需任何 C 库头
mkdir -p $PKG/tools/clang/bin $PKG/tools/clang/lib/clang
cp $LLVM_DIR/bin/clang.exe $PKG/tools/clang/bin/
cp -r $LLVM_DIR/lib/clang/$CLANG_RES_VER $PKG/tools/clang/lib/clang/
rm -rf $PKG/tools/clang/lib/clang/$CLANG_RES_VER/lib $PKG/tools/clang/lib/clang/$CLANG_RES_VER/share

# mingw(TDM 子集): gcc 驱动 + collect2 + ld + crt/运行时库 + 必需 DLL。
# 只接纯 .o 链接(runtime/渲染桥均预编译),故无需 cc1/as/C 头文件。
M=$PKG/tools/mingw
mkdir -p $M/bin $M/libexec/gcc/x86_64-w64-mingw32/$TDM_VER $M/lib/gcc/x86_64-w64-mingw32/$TDM_VER \
         $M/x86_64-w64-mingw32/bin $M/x86_64-w64-mingw32/lib
cp $TDM_DIR/bin/gcc.exe $M/bin/
cp $TDM_DIR/bin/{libiconv-2.dll,libintl-8.dll,libwinpthread-1.dll,libgcc_s_seh_64-1.dll,libatomic_64-1.dll,libssp_64-0.dll,libquadmath_64-0.dll} $M/bin/
cp $TDM_DIR/libexec/gcc/x86_64-w64-mingw32/$TDM_VER/{collect2.exe,liblto_plugin-0.dll,libgmp-10.dll,libiconv-2.dll,libisl-23.dll,libmpc-3.dll,libmpfr-6.dll,libzstd.dll} \
   $M/libexec/gcc/x86_64-w64-mingw32/$TDM_VER/
cp $TDM_DIR/x86_64-w64-mingw32/bin/ld.exe $M/x86_64-w64-mingw32/bin/
cp $TDM_DIR/lib/gcc/x86_64-w64-mingw32/$TDM_VER/{crtbegin.o,crtend.o,libgcc.a,libgcc_s.a} \
   $M/lib/gcc/x86_64-w64-mingw32/$TDM_VER/
cp $TDM_DIR/x86_64-w64-mingw32/lib/{crt2.o,libmingw32.a,libmingwex.a,libmsvcrt.a,libmsvcrt-os.a,libkernel32.a,libuser32.a,libws2_32.a,libsecur32.a,libadvapi32.a,libshell32.a,libole32.a,libuuid.a,libopengl32.a,libgdi32.a,libwinmm.a,libimm32.a,libmingwthrd.a,libpthread.a,libmoldname.a,libwinpthread.a,libcomdlg32.a,default-manifest.o} \
   $M/x86_64-w64-mingw32/lib/

# ── 3. runtime:源码 + 预编译 .o(预编译用开发机完整 clang;发行机无 C 头文件故必须随包)──
cp $ROOT/runtime/xt_runtime.c $ROOT/runtime/xt_runtime.h \
   $ROOT/runtime/xt_threadpool.c $ROOT/runtime/xt_threadpool.h \
   $ROOT/runtime/xt_net.c $ROOT/runtime/xt_net.h \
   $ROOT/runtime/xt_tls.c $ROOT/runtime/xt_scheduler.h $PKG/runtime/
for f in xt_runtime xt_threadpool xt_net xt_tls; do
  clang -target x86_64-w64-windows-gnu -O2 -c $ROOT/runtime/$f.c -o $PKG/runtime/$f.o
done

# ── 4. lib:官方库(排除 VCS 与编译中间产物);渲染桥预编译 .o ──
for L in 数组 HTTP UI 渲染; do
  (cd $ROOT/lib/$L && find . -type f ! -path "./.git/*" ! -path "./.git" ! -name "*.ll" \
     ! -name "自举输出*" ! -name ".gitignore" ! -name "渲染.o" ! -name "渲染桥.o" | while read f; do
    mkdir -p "$PKG/lib/$L/$(dirname "$f")"; cp "$f" "$PKG/lib/$L/$f"
  done)
done
clang -target x86_64-w64-windows-gnu -O2 -c $ROOT/lib/渲染/渲染桥.c -o $PKG/lib/渲染/渲染桥.o -I $ROOT/lib/渲染

# ── 5. 文档与示例:GUIDE 仅收录手册(参考手册首页 + 01~12 章节),内部笔记/清单不入包 ──
cp $ROOT/GUIDE/玄铁语言参考手册.md $PKG/GUIDE/
cp $ROOT/GUIDE/[0-9]*.md $PKG/GUIDE/
find $ROOT/examples -maxdepth 1 -name "*.xt" -exec cp {} $PKG/examples/ \;
for D in 斐波那契 数学 位运算符 UI界面; do
  mkdir -p $PKG/examples/$D
  find $ROOT/examples/$D -name "*.xt" -exec cp {} $PKG/examples/$D/ \; 2>/dev/null || true
done

# ── 6. 发行说明 ──
cat > $PKG/README.md << 'EOF'
# 玄铁 (XuanTie) v1.0-rc

中文静态强类型编译型语言。本包为绿色免安装版,解压即用:

```
xtc.exe tie hello.xt            # 编译(自带 clang/MinGW,无需装任何工具链)
xtc.exe tie hello.xt -jc     # 只检查不产出(语法+语义全量诊断)
```

- `runtime/` 玄铁 C 运行时(源码+预编译对象)
- `lib/` 官方库(数组/HTTP/UI/渲染,`引 "数组"` 裸包名直接可用)
- `tools/` 自带极简 LLVM-clang 与 TDM-GCC 子集(仅编译期使用)
- `GUIDE/` 语言手册(参考手册 + 01~12 章节)
- VSCode 插件(xuantie-*.vsix,已内置 LSP 语言服务器):双击或 `code --install-extension` 安装

渲染库已内置 libraylib.a 与预编译渲染桥,`引 "渲染"` 开箱即用。
EOF

echo "=== payload 就绪 ==="
du -sh $PKG
echo "下一步: iscc release/xuantie_setup.iss  →  release/xuantie_v1.0-rc_setup.exe"
