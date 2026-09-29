#!/bin/bash
# ══════════════════════════════════════════════════════════════
# 玄铁发行包一键组装(在开发机运行)
# 产出: temp/pkg_test/XuanTie/(payload,供 Inno Setup 与压缩包共用)
# 依赖: 开发机的 LLVM($LLVM_DIR)、TDM-GCC($TDM_DIR)、自举链产物 build/xtc_s*.exe、
#       已打包的 VSCode 插件 extensions/xuantie-syntax/xuantie-<版本>.vsix
# 编译器取自举链顶(s4→s3→s2→s1 取最先命中者),并强制校验 s3/s4 逐字节一致(自举定点);
# 绝不回落 build/xtc.exe —— 该名字是历史遗留(h 前代产物),极易误发改动前的旧编译器。
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

# 编译器取链顶(s 为自举级次,非版本号):s4 最新,依次回落 s3/s2/s1
XTC_SRC=""
for S in s4 s3 s2 s1; do
  [ -f "$ROOT/build/xtc_$S.exe" ] && { XTC_SRC="$ROOT/build/xtc_$S.exe"; break; }
done
[ -n "$XTC_SRC" ] || { echo "错误: 未找到 build/xtc_s*.exe,请先自举(bash tools/bootstrap_check.sh)"; exit 1; }

# 自举定点守卫:相邻两级 s3/s4 必须逐字节一致,否则链未收敛(源码改过但没重新自举)
if [ -f "$ROOT/build/xtc_s3.exe" ] && [ -f "$ROOT/build/xtc_s4.exe" ]; then
  H3=$(md5sum "$ROOT/build/xtc_s3.exe" | cut -d' ' -f1)
  H4=$(md5sum "$ROOT/build/xtc_s4.exe" | cut -d' ' -f1)
  if [ "$H3" != "$H4" ]; then
    echo "错误: 自举链未到定点(s3=$H3 ≠ s4=$H4),拒绝对未通过自举验证的编译器打包"
    echo "      请先执行 bash tools/bootstrap_check.sh 重新自举"
    exit 1
  fi
  echo "自举定点确认: $XTC_SRC (md5 $H4)"
fi

rm -rf $ROOT/temp/pkg_test
mkdir -p $PKG/{runtime,lib,tools,GUIDE,examples}

# ── 1. 编译器 / 包管理器 / VSCode 插件(LSP 二进制内置于 vsix,发行包不重复携带)──
cp "$XTC_SRC" $PKG/xtc.exe
cp $ROOT/tiepm/tiepm.exe $PKG/

# 插件:取目录内版本最高的一份(按版本号排序,非字典序);缺失即报错,不让 README 指向不存在的文件
VSIX=$(ls -1 $ROOT/extensions/xuantie-syntax/xuantie-*.vsix 2>/dev/null | sort -V | tail -1)
[ -n "$VSIX" ] || { echo "错误: 未找到 extensions/xuantie-syntax/xuantie-*.vsix,请先在插件目录执行 build.ps1"; exit 1; }
cp "$VSIX" $PKG/
echo "插件随包: $(basename "$VSIX")"

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
# _tiepm_dl* 是铁铺安装时在包目录落下的下载残留(已被 .gitignore 忽略),不是库源码,不得随包
for L in 数组 HTTP UI 渲染; do
  (cd $ROOT/lib/$L && find . -type f ! -path "./.git/*" ! -path "./.git" ! -name "*.ll" \
     ! -name "自举输出*" ! -name ".gitignore" ! -name "渲染.o" ! -name "渲染桥.o" ! -name "_tiepm_dl*" \
     | while read f; do
    mkdir -p "$PKG/lib/$L/$(dirname "$f")"; cp "$f" "$PKG/lib/$L/$f"
  done)
done
STRAY=$(find $ROOT/lib -name "_tiepm_dl*" -not -path "*/.git/*" 2>/dev/null)
[ -n "$STRAY" ] && echo "注意: 已排除铁铺下载残留(不入包): $STRAY"
clang -target x86_64-w64-windows-gnu -O2 -c $ROOT/lib/渲染/渲染桥.c -o $PKG/lib/渲染/渲染桥.o -I $ROOT/lib/渲染

# ── 5. 文档与示例:GUIDE 收录手册(首页 + 手册/章节 + 关键字/速查 + 01~12 指南 + UI 库文档)──
# UI 库文档必须随包:12 章指南里的控件/选项键/渲染条目相对链接指向 GUIDE/UI/,缺了全是断链
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
cat > $PKG/README.md << 'EOF'
# 玄铁 (XuanTie) v1.0-rc.2

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

# ── 7. 构建清单 MANIFEST.txt(第三方核验"二进制是否对应这份源码"的唯一凭据)──
# 动机:版本号是源码里的一行常量,v1.0-rc.2 窗口内的任意一次提交产出的二进制都自称 v1.0-rc.2;
# 而发行物此前不记录任何指纹 → 任何人都无法核验对应关系,只能猜(已发生过一次误判)。
# 这里把编译器 md5、自举链各级 md5、提交哈希、包内全部文件 md5 一并落盘;
# 其中「编译器自述」段由 xtc.exe -h 原样打印,故裸 exe 也能自证。
PKG_VER=$("$PKG/xtc.exe" -h 2>/dev/null | head -1 | sed 's/.*驱动 //' | tr -d '\r')
XTC_MD5=$(md5sum "$PKG/xtc.exe" | cut -d' ' -f1)
XTC_SIZE=$(stat -c%s "$PKG/xtc.exe")
COMMIT=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo "(非 git 工作区,无法记录提交)")
DIRTY=$(git -C "$ROOT" status --porcelain 2>/dev/null | head -1 || true)
DDC3=$(md5sum "$ROOT/build/xtc_s3.exe" 2>/dev/null | cut -d' ' -f1 || echo "(缺)")
DDC4=$(md5sum "$ROOT/build/xtc_s4.exe" 2>/dev/null | cut -d' ' -f1 || echo "(缺)")
CLANG_V=$(clang --version 2>/dev/null | head -1 || echo "(未知)")
GCC_V=$(gcc --version 2>/dev/null | head -1 || echo "(未知)")
{
  echo "玄铁发行包构建清单 (MANIFEST)"
  echo "生成时间: $(date '+%Y-%m-%d %H:%M:%S %z')"
  echo
  echo "# 以下「编译器自述」段由 xtc.exe -h 原样打印(裸 exe 也能自证),标记行格式请勿改动"
  echo "[编译器自述]"
  echo "版本: $PKG_VER"
  echo "提交: $COMMIT"
  echo "编译器: xtc.exe  $XTC_SIZE 字节  md5=$XTC_MD5"
  echo "自举定点: s3=$DDC3  s4=$DDC4  $([ "$DDC3" = "$DDC4" ] && echo '逐字节一致' || echo '不一致(异常)')"
  echo "构建工具链: $CLANG_V | $GCC_V"
  echo "[/编译器自述]"
  echo
  echo "[自举链各级产物]"
  for _n in 1 2 3 4; do
    if [ -f "$ROOT/build/xtc_s$_n.exe" ]; then
      echo "s$_n: md5=$(md5sum "$ROOT/build/xtc_s$_n.exe" | cut -d' ' -f1)  $(stat -c%s "$ROOT/build/xtc_s$_n.exe") 字节"
    fi
  done
  echo
  echo "[包内全部文件]      # path  md5  字节数"
  (cd "$PKG" && find . -type f ! -name "MANIFEST.txt" | sed 's|^\./||' | sort | while read -r _f; do
    echo "$_f  $(md5sum "$_f" | cut -d' ' -f1)  $(stat -c%s "$_f")"
  done)
  echo
  echo "[工作区状态] $( [ -n "$DIRTY" ] && echo '有未提交改动 —— 包内文件可能含未进任何提交的内容,发布前请先提交' || echo '干净(包内容全部对应上面记录的提交)' )"
} > $PKG/MANIFEST.txt
echo "清单: MANIFEST.txt($(grep -c . $PKG/MANIFEST.txt) 行, 含 $(grep -c '  ' $PKG/MANIFEST.txt) 条含哈希记录)"

echo "=== payload 就绪 ==="
du -sh $PKG
echo "编译器: $XTC_SRC"
echo "插件:   $(basename "$VSIX")"
echo "库:     UI v$UI_VER / 渲染 v$XU_VER"
echo "下一步: bash release/make_release.sh  (组包→安装器→压缩包)"
echo "        或单独出安装器: (cd release && ../temp/innosetup/ISCC.exe xuantie_setup.iss)"
