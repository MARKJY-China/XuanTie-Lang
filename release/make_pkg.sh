#!/bin/bash
# ══════════════════════════════════════════════════════════════
# 玄铁发行包一键组装(平台自适应)
#   windows: 开发机 Git Bash(内嵌 clang/TDM 子集 + 预编译渲染桥,行为与旧版一致)
#   linux :   CI(ubuntu-latest)——工具链用系统 clang/gcc,不带自带工具链,不含渲染预编译
#   darwin:   CI(macos-14,arm64)——同上;渲染桥在存在 darwin-arm64 raylib 时尝试预编译
# 产出: temp/pkg_test/XuanTie/(payload;Windows 供 Inno Setup 与压缩包共用)
# 依赖: 自举链产物 build/xtc_s*.exe(先跑 tools/bootstrap_check.sh)
# 编译器取自举链顶(s4→s3→s2→s1 取最先命中者),并强制校验 s3/s4 逐字节一致(自举定点);
# 绝不回落 build/xtc.exe —— 该名字是历史遗留(前代产物),极易误发改动前的旧编译器。
# 用法: windows → **Git Bash 中运行**: bash release/make_pkg.sh
#       linux/darwin → CI 中直接 bash release/make_pkg.sh
# ══════════════════════════════════════════════════════════════
set -e

# 平台探测(MINGW/MSYS=Windows Git Bash;Darwin;Linux)
UNAME_S=$(uname)
case "$UNAME_S" in
  MINGW*|MSYS*|CYGWIN*) PLATFORM=windows ;;
  Darwin)               PLATFORM=darwin ;;
  Linux)                PLATFORM=linux ;;
  *) echo "错误: 未知平台 $UNAME_S"; exit 1 ;;
esac
echo "平台: $PLATFORM ($UNAME_S)"

# 环境守卫:Windows 仅支持 Git Bash/WSL 拒绝;linux/darwin 放行(CI)
if [ "$PLATFORM" = "windows" ]; then
  if ! uname | grep -qiE "MINGW|MSYS"; then
    echo "错误: 请在 Git Bash 中运行此脚本(当前环境疑似 WSL:$(uname -a | cut -c1-60))"
    echo "      PowerShell 用法: & \"C:\Program Files\Git\bin\bash.exe\" release/make_pkg.sh"
    exit 1
  fi
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LLVM_DIR=${LLVM_DIR:-/d/LLVM}
TDM_DIR=${TDM_DIR:-/c/TDM-GCC-64}
TDM_VER=${TDM_VER:-10.3.0}  # 可 env 注入(CI 的 MinGW 版本目录与开发机 TDM 不同)
CLANG_RES_VER=22
PKG=$ROOT/temp/pkg_test/XuanTie

# 跨平台工具(macOS 无 md5sum/stat -c;bootstrap_check.sh 同款回落)
MD5()   { md5sum "$1" 2>/dev/null | cut -d' ' -f1 || md5 -q "$1"; }
FSIZE() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

# Windows 工具链前置检查(非 Windows 不需要)
if [ "$PLATFORM" = "windows" ]; then
  [ -f "$LLVM_DIR/bin/clang.exe" ] || { echo "错误: 未找到 clang($LLVM_DIR),请设 LLVM_DIR 环境变量指向 LLVM 根目录"; exit 1; }
  [ -f "$TDM_DIR/bin/gcc.exe" ]    || { echo "错误: 未找到 gcc($TDM_DIR),请设 TDM_DIR 环境变量指向 TDM-GCC 根目录"; exit 1; }
fi

# 编译器取链顶(s 为自举级次,非版本号):扫描 build/ 内最高编号的 xtc_sN。
# 纯 shell 数字比较(不依赖 sort -V:macOS 的 BSD sort 没有 -V)——此前的固定区间写法
# 已两次被链延长打脸(s4 上限→s6;6 上限→s8),必须动态扫描。
XTC_SRC=""
TOP_N=0
for _f in "$ROOT"/build/xtc_s*.exe; do
  [ -f "$_f" ] || continue
  _n=${_f##*/xtc_s}
  _n=${_n%.exe}
  case "$_n" in ''|*[!0-9]*) continue ;; esac
  if [ "$_n" -gt "$TOP_N" ]; then TOP_N=$_n; fi
done
[ "$TOP_N" -gt 0 ] || { echo "错误: 未找到 build/xtc_s*.exe,请先自举(bash tools/bootstrap_check.sh)"; exit 1; }
XTC_SRC="$ROOT/build/xtc_s$TOP_N.exe" 

# 自举定点守卫:最高两级(sN/sN-1)必须逐字节一致,否则链未收敛(源码改过但没重新自举)
PREV_N=$((TOP_N - 1))
if [ "$PREV_N" -ge 1 ] && [ -f "$ROOT/build/xtc_s$PREV_N.exe" ]; then
  HP=$(MD5 "$ROOT/build/xtc_s$PREV_N.exe")
  HT=$(MD5 "$ROOT/build/xtc_s$TOP_N.exe")
  if [ "$HP" != "$HT" ]; then
    echo "错误: 自举链未到定点(s$PREV_N=$HP ≠ s$TOP_N=$HT),拒绝对未通过自举验证的编译器打包"
    echo "      请先执行 bash tools/bootstrap_check.sh 重新自举"
    exit 1
  fi
  echo "自举定点确认: $XTC_SRC (md5 $HT)"
fi

rm -rf $ROOT/temp/pkg_test
mkdir -p $PKG/{runtime,lib,GUIDE,examples}

# ── 1. 编译器 / 包管理器 /(Windows)LSP 插件 ──
if [ "$PLATFORM" = "windows" ]; then
  cp "$XTC_SRC" $PKG/xtc.exe
  cp $ROOT/tiepm/tiepm.exe $PKG/
  # 插件:取目录内版本最高的一份(按版本号排序,非字典序);缺失即报错
  VSIX=$(ls -1 $ROOT/extensions/xuantie-syntax/xuantie-*.vsix 2>/dev/null | sort -V | tail -1)
  [ -n "$VSIX" ] || { echo "错误: 未找到 extensions/xuantie-syntax/xuantie-*.vsix,请先在插件目录执行 build.ps1"; exit 1; }
  cp "$VSIX" $PKG/
  echo "插件随包: $(basename "$VSIX")"
else
  # 非 Windows:裸可执行名(CI 已构建 tiepm 与 xt_lsp,见 release.yml)
  cp "$XTC_SRC" $PKG/xtc
  if [ -f "$ROOT/build/tiepm" ]; then cp "$ROOT/build/tiepm" $PKG/tiepm
  elif [ -f "$ROOT/tiepm/tiepm" ]; then cp "$ROOT/tiepm/tiepm" $PKG/tiepm
  else echo "错误: 未找到 tiepm 可执行(CI 中应先构建: xtc_s4 铁 tiepm/铁铺.xt -sc build/tiepm)"; exit 1; fi
  if [ -f "$ROOT/lsp/xt_lsp" ]; then cp "$ROOT/lsp/xt_lsp" $PKG/xt_lsp; echo "xt_lsp 随包"; fi
fi

# ── 2. 自带极简工具链(仅 Windows:发行机无 C 工具链时的最小集)──
if [ "$PLATFORM" = "windows" ]; then
  mkdir -p $PKG/tools/clang/bin $PKG/tools/clang/lib/clang
  cp $LLVM_DIR/bin/clang.exe $PKG/tools/clang/bin/
  cp -r $LLVM_DIR/lib/clang/$CLANG_RES_VER $PKG/tools/clang/lib/clang/
  rm -rf $PKG/tools/clang/lib/clang/$CLANG_RES_VER/lib $PKG/tools/clang/lib/clang/$CLANG_RES_VER/share

  M=$PKG/tools/mingw
  mkdir -p $M/bin $M/libexec/gcc/x86_64-w64-mingw32/$TDM_VER $M/lib/gcc/x86_64-w64-mingw32/$TDM_VER \
           $M/x86_64-w64-mingw32/bin $M/x86_64-w64-mingw32/lib
  # 宽松扫拷 + 必需清单硬校验:开发机是 TDM-GCC(10.3,DLL 带 _64 后缀且在 libexec),
  # CI 是 choco mingw64(16.x,DLL 在 bin 且命名不同)——不逐个猜名,改为"目录扫拷 DLL +
  # 跨发行版稳定的必需件清单",缺件时汇总报错并打印现场目录(首跑实测教训)。
  MISSING=0
  cp "$TDM_DIR/bin/gcc.exe" $M/bin/ || { echo "!! 缺件: bin/gcc.exe"; MISSING=$((MISSING+1)); }
  cp "$TDM_DIR"/bin/*.dll $M/bin/ 2>/dev/null || true
  cp "$TDM_DIR/libexec/gcc/x86_64-w64-mingw32/$TDM_VER/collect2.exe" $M/libexec/gcc/x86_64-w64-mingw32/$TDM_VER/ 2>/dev/null \
    || { echo "!! 缺件: libexec/gcc/x86_64-w64-mingw32/$TDM_VER/collect2.exe"; MISSING=$((MISSING+1)); }
  cp "$TDM_DIR/libexec/gcc/x86_64-w64-mingw32/$TDM_VER"/*.dll $M/libexec/gcc/x86_64-w64-mingw32/$TDM_VER/ 2>/dev/null || true
  cp "$TDM_DIR/x86_64-w64-mingw32/bin/ld.exe" $M/x86_64-w64-mingw32/bin/ 2>/dev/null \
    || cp "$TDM_DIR/bin/ld.exe" $M/x86_64-w64-mingw32/bin/ 2>/dev/null \
    || { echo "!! 缺件: ld.exe(mingw 与 bin 两处均无)"; MISSING=$((MISSING+1)); }
  for f in crtbegin.o crtend.o libgcc.a libgcc_s.a; do
    cp "$TDM_DIR/lib/gcc/x86_64-w64-mingw32/$TDM_VER/$f" $M/lib/gcc/x86_64-w64-mingw32/$TDM_VER/ 2>/dev/null \
      || { echo "!! 缺件: lib/gcc/.../$f"; MISSING=$((MISSING+1)); }
  done
  for f in crt2.o libmingw32.a libmingwex.a libmsvcrt.a libmsvcrt-os.a libkernel32.a libuser32.a libws2_32.a libsecur32.a libadvapi32.a libshell32.a libole32.a libuuid.a libopengl32.a libgdi32.a libwinmm.a libimm32.a libmingwthrd.a libpthread.a libmoldname.a libwinpthread.a libcomdlg32.a default-manifest.o; do
    cp "$TDM_DIR/x86_64-w64-mingw32/lib/$f" $M/x86_64-w64-mingw32/lib/ 2>/dev/null \
      || { echo "!! 缺件: x86_64-w64-mingw32/lib/$f"; MISSING=$((MISSING+1)); }
  done
  if [ "$MISSING" -gt 0 ]; then
    echo "内嵌工具链抽取失败(共缺 $MISSING 项);现场目录(据此调参):"
    ls "$TDM_DIR" 2>/dev/null | head -30 || true
    ls "$TDM_DIR/libexec/gcc/x86_64-w64-mingw32/" 2>/dev/null || true
    ls "$TDM_DIR/x86_64-w64-mingw32/lib/" 2>/dev/null | head -20 || true
    exit 1
  fi
  mkdir -p $PKG/tools
else
  mkdir -p $PKG/tools
  echo "非 Windows:不带自带工具链(发行环境需系统 clang/gcc;要求见 README)"
fi

# ── 3. runtime:源码 + 预编译 .o ──
cp $ROOT/runtime/xt_runtime.c $ROOT/runtime/xt_runtime.h \
   $ROOT/runtime/xt_threadpool.c $ROOT/runtime/xt_threadpool.h \
   $ROOT/runtime/xt_net.c $ROOT/runtime/xt_net.h \
   $ROOT/runtime/xt_tls.c $ROOT/runtime/xt_scheduler.h $PKG/runtime/
if [ "$PLATFORM" = "windows" ]; then
  for f in xt_runtime xt_threadpool xt_net xt_tls; do
    clang -target x86_64-w64-windows-gnu -O2 -c $ROOT/runtime/$f.c -o $PKG/runtime/$f.o
  done
else
  for f in xt_runtime xt_threadpool xt_net xt_tls; do
    clang -O2 -c $ROOT/runtime/$f.c -o $PKG/runtime/$f.o
  done
fi

# ── 4. lib:官方库(排除 VCS 与编译中间产物)──
for L in 数组 HTTP UI 渲染; do
  (cd $ROOT/lib/$L && find . -type f ! -path "./.git/*" ! -path "./.git" ! -name "*.ll" \
     ! -name "自举输出*" ! -name ".gitignore" ! -name "渲染.o" ! -name "渲染桥.o*" ! -name "_tiepm_dl*" \
     | while read f; do
    mkdir -p "$PKG/lib/$L/$(dirname "$f")"; cp "$f" "$PKG/lib/$L/$f"
  done)
done
STRAY=$(find $ROOT/lib -name "_tiepm_dl*" -not -path "*/.git/*" 2>/dev/null)
[ -n "$STRAY" ] && echo "注意: 已排除铁铺下载残留(不入包): $STRAY"

# 渲染桥预编译:Windows 必做(开箱即用);darwin 在 raylib 库就位时尝试;linux 无 raylib 库产物则跳过
if [ "$PLATFORM" = "windows" ]; then
  clang -target x86_64-w64-windows-gnu -O2 -c $ROOT/lib/渲染/渲染桥.c -o $PKG/lib/渲染/渲染桥.o -I $ROOT/lib/渲染
elif [ "$PLATFORM" = "darwin" ]; then
  RAYLIB_LIB=""
  for cand in libraylib.darwin-arm64.a libraylib.a; do
    [ -f "$ROOT/lib/渲染/$cand" ] && { RAYLIB_LIB=$cand; break; }
  done
  if [ -n "$RAYLIB_LIB" ]; then
    if clang -O2 -c $ROOT/lib/渲染/渲染桥.c -o $PKG/lib/渲染/渲染桥.o -I $ROOT/lib/渲染 2>/tmp/raylib_bridge_build.log; then
      echo "渲染桥已预编译(darwin,raylib=$RAYLIB_LIB)"
    else
      echo "注意: darwin 渲染桥预编译失败(不阻塞主包;日志见 /tmp/raylib_bridge_build.log)"
      rm -f $PKG/lib/渲染/渲染桥.o
    fi
  else
    echo "注意: 缺 darwin raylib 库,渲染桥未预编译"
  fi
else
  echo "注意: linux 暂无 raylib 库产物,渲染桥未预编译(渲染库需自行构建 raylib,详见 README)"
fi

# ── 5. 文档与示例 ──
cp $ROOT/GUIDE/玄铁语言参考手册.md $PKG/GUIDE/
cp $ROOT/GUIDE/[0-9]*.md $PKG/GUIDE/
cp -r $ROOT/GUIDE/手册 $PKG/GUIDE/
cp -r $ROOT/GUIDE/关键字 $PKG/GUIDE/
cp -r $ROOT/GUIDE/UI $PKG/GUIDE/
find $ROOT/examples -maxdepth 1 -name "*.xt" -exec cp {} $PKG/examples/ \;
for D in 斐波那契 数学 位运算符 UI界面; do
  mkdir -p $PKG/examples/$D
  find $ROOT/examples/$D -name "*.xt" -exec cp {} $PKG/examples/$D/ \; 2>/dev/null || true
done

# ── 6. 发行说明(版本号从各库 tiepm.toml 取,避免与库漂移)──
UI_VER=$(grep -m1 '^版本' $ROOT/lib/UI/tiepm.toml     | sed 's/.*"\(.*\)".*/\1/')
XU_VER=$(grep -m1 '^版本' $ROOT/lib/渲染/tiepm.toml   | sed 's/.*"\(.*\)".*/\1/')
if [ "$PLATFORM" = "windows" ]; then
  XTC_NAME=xtc.exe
  cat > $PKG/README.md << 'EOF'
# 玄铁 (XuanTie) v1.0-rc.3

中文静态强类型编译型语言。本包为绿色免安装版,解压即用:

```
xtc.exe tie hello.xt          # 编译(自带 clang/MinGW,无需装任何工具链)
xtc.exe tie hello.xt -jc      # 只检查不产出(语法+语义全量诊断)
xtc.exe 跑 hello.xt           # 编译并立即运行(透传参数与退出码)
```

- `runtime/` 玄铁 C 运行时(源码+预编译对象)
- `lib/` 官方库:`数组`/`HTTP` 与 `UI` v@@UI_VER@@ + `渲染` v@@XU_VER@@
  (`引 "数组"` 裸包名直接可用;渲染已内置 libraylib.a 与预编译渲染桥,开箱即用)
- `tools/` 自带极简 LLVM-clang 与 TDM-GCC 子集(仅编译期使用)
- `GUIDE/` 语言手册(参考手册 + 01~12 指南 + 关键字速查 + UI 库文档)
- `MANIFEST.txt` 构建清单:编译器与自举链各级 md5、对应提交哈希、包内全部文件 md5
  (敲 `xtc.exe -h` 会打印其中「编译器自述」段——版本号是常量不随提交移动,核验请看这份清单)
- `@@VSIX@@` VSCode 插件(已内置 LSP 语言服务器):双击安装,或 `code --install-extension @@VSIX@@`
EOF
  sed -i "s/@@UI_VER@@/$UI_VER/; s/@@XU_VER@@/$XU_VER/; s/@@VSIX@@/$(basename "$VSIX")/" $PKG/README.md
else
  XTC_NAME=xtc
  if [ "$PLATFORM" = "darwin" ]; then
    PKG_LABEL="macOS (arm64)"
  else
    PKG_LABEL="Linux (x86_64)"
  fi
  cat > $PKG/README.md << EOF
# 玄铁 (XuanTie) v1.0-rc.3 — $PKG_LABEL

中文静态强类型编译型语言。本包为绿色免安装版,解压即用:

\`\`\`
./xtc tie hello.xt          # 编译(需要系统 clang;见下方"前置")
./xtc tie hello.xt -jc      # 只检查不产出(语法+语义全量诊断)
./xtc 跑 hello.xt           # 编译并立即运行(透传参数与退出码)
\`\`\`

- \`runtime/\` 玄铁 C 运行时(源码+预编译对象)
- \`lib/\` 官方库:\`数组\`/\`HTTP\` 与 \`UI\` v$UI_VER + \`渲染\` v$XU_VER
- \`GUIDE/\` 语言手册(参考手册 + 01~12 指南 + 关键字速查 + UI 库文档)
- \`MANIFEST.txt\` 构建清单:编译器与自举链各级 md5、对应提交哈希、包内全部文件 md5

## 前置

- 系统需有 \`clang\`(\`clang --version\` 可用;Ubuntu: \`apt install clang\`)
$( [ "$PLATFORM" = "linux" ] && printf -- '- **Linux 版网络限制**:当前无系统 TLS 通道,`求()` 仅支持 http,https 会明确失败\n' )
$( [ "$PLATFORM" = "darwin" ] && printf -- '- 渲染库:本包已含 darwin-arm64 的 raylib 与预编译渲染桥(如构建步骤成功)\n' )
$( [ "$PLATFORM" = "linux" ] && printf -- '- 渲染库:本包未含 raylib 库产物,渲染功能需自行构建 raylib(见 lib/渲染/changelog.md)\n' )
- 本包不含自带工具链(Windows 包自带 clang/MinGW;本平台使用系统工具链)
EOF
fi

# ── 7. 构建清单 MANIFEST.txt(第三方核验"二进制是否对应这份源码"的唯一凭据)──
PKG_VER=$("$PKG/$XTC_NAME" -h 2>/dev/null | head -1 | sed 's/.*驱动 //' | tr -d '\r')
XTC_MD5=$(MD5 "$PKG/$XTC_NAME")
XTC_SIZE=$(FSIZE "$PKG/$XTC_NAME")
COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "(非 git 工作区,无法记录提交)")
DIRTY=$(git -C "$ROOT" status --porcelain 2>/dev/null | head -1 || true)
DDC_P=$(MD5 "$ROOT/build/xtc_s${PREV_N}.exe" 2>/dev/null || echo "(缺)")
DDC_T=$(MD5 "$ROOT/build/xtc_s${TOP_N}.exe" 2>/dev/null || echo "(缺)")
CLANG_V=$(clang --version 2>/dev/null | head -1 || echo "(未知)")
GCC_V=$(gcc --version 2>/dev/null | head -1 || echo "(未知)")
{
  echo "玄铁发行包构建清单 (MANIFEST)"
  echo "平台: $PLATFORM ($UNAME_S $(uname -m))"
  echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo
  echo "# 以下「编译器自述」段由 $XTC_NAME -h 原样打印(裸 exe 也能自证),标记行格式请勿改动"
  echo "[编译器自述]"
  echo "版本: $PKG_VER"
  echo "提交: $COMMIT"
  echo "编译器: $XTC_NAME  $XTC_SIZE 字节  md5=$XTC_MD5"
  echo "自举定点: s$PREV_N=$DDC_P  s$TOP_N=$DDC_T  $([ "$DDC_P" = "$DDC_T" ] && echo '逐字节一致' || echo '不一致(异常)')"
  echo "构建工具链: $CLANG_V | $GCC_V"
  echo "[/编译器自述]"
  echo
  echo "[自举链各级产物]"
  for _n in $(seq 1 "$TOP_N"); do
    if [ -f "$ROOT/build/xtc_s$_n.exe" ]; then
      echo "s$_n: md5=$(MD5 "$ROOT/build/xtc_s$_n.exe")  $(FSIZE "$ROOT/build/xtc_s$_n.exe") 字节"
    fi
  done
  echo
  echo "[包内全部文件]      # path  md5  字节数"
  (cd "$PKG" && find . -type f ! -name "MANIFEST.txt" | sed 's|^\./||' | sort | while read -r _f; do
    echo "$_f  $(MD5 "$_f")  $(FSIZE "$_f")"
  done)
  echo
  echo "[工作区状态] $( [ -n "$DIRTY" ] && echo '有未提交改动 —— 包内文件可能含未进任何提交的内容,发布前请先提交' || echo '干净(包内容全部对应上面记录的提交)' )"
} > $PKG/MANIFEST.txt
echo "清单: MANIFEST.txt($(grep -c . $PKG/MANIFEST.txt) 行, 含 $(grep -c '  ' $PKG/MANIFEST.txt) 条含哈希记录)"

echo "=== payload 就绪 ==="
du -sh $PKG
echo "编译器: $XTC_SRC"
echo "库:     UI v$UI_VER / 渲染 v$XU_VER"
if [ "$PLATFORM" = "windows" ]; then
  echo "下一步: bash release/make_release.sh  (组包→安装器→压缩包)"
else
  echo "下一步(CI): cd temp/pkg_test && tar -czf ../../release/xuantie_${PKG_VER}_${PLATFORM}_$(uname -m).tar.gz XuanTie"
fi
