#!/usr/bin/env bash
# 玄铁自举链 + DDC(Deterministic Defect Check / 逐字节一致)门禁脚本
#
# 语义(用户立的永久规矩):
#   sX = Stage X。s1 = GSC(xt_gsc.exe) 编译产出的第一版 XTC;sN = 由 s(N-1) 编译产出。
#   相邻两级逐字节一致 = 到达自举固定点,才算自举验证通过(仅"能构建+测试通过"不算)。
#
# 本脚本做四件事:
#   1. 逐级自举 s1 → s2 → s3 → s4(GSC 不支持 -sc,须在独立目录内构建后改名,严禁产出 玄铁.exe 于仓库根)
#   2. 打印各级大小与 md5
#   3. DDC 硬门禁:s3 与 s4 必须逐字节一致(固定点),否则非零退出
#   4. 冒烟:用 s4 编译并运行 Test/01_基础测试.xt
#
# 用法: bash tools/bootstrap_check.sh   (项目根目录或任意目录均可;需已先 go build -o xt_gsc.exe .)
#
# 平台差异(实测):
#   * 哈希:macOS 无 md5sum,按 md5sum → md5 -q → shasum -a 256 逐级回落。
#   * DDC:Windows/Linux 上 s3 与 s4 必须逐字节一致(硬判据)。darwin 上 ld64 每次链接注入随机
#     LC_UUID,叠加 -g 的 DWARF 调试段不确定(issue #41 实测 s3/s4 差 200 字节:头部 16 字节
#     LC_UUID + 尾部 ~180 字节调试段),属平台链接器行为而非编译器不确定性,故 darwin 下默认把
#     "逐字节不一致"降级为打印差异不阻断(设 XT_DDC_SOFT=1 可在任意平台显式开启该降级);
#     构建链路与两段冒烟在 darwin 上仍全部硬判。
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GSC="$ROOT/xt_gsc.exe"
# 产物后缀:Windows MinGW 链接产出 .exe;darwin/linux 原生产物无扩展名(实测 GSC 输出"原生编译完成: probe")
EXE=".exe"; case "$(uname -s)" in Darwin|Linux) EXE="";; esac
SRC="$ROOT/xuantie_compiler/玄铁.xt"
BUILD="$ROOT/build"
SCRATCH="$ROOT/temp/_bootstrap_scratch"

fail() { echo "[自举门禁] 失败: $*" >&2; exit 1; }

# Windows 原生 exe(GSC/XTC)不认 MSYS 风格路径(/d/a/...);统一转 Windows 形式。
# (CI 首跑实证:GSC 收到 MSYS 路径会读不到源文件,且读失败仍返回 0,靠产物存在性检查兜住)
if command -v cygpath >/dev/null 2>&1; then
    W() { cygpath -w "$1"; }
else
    W() { printf '%s' "$1"; }
fi

dump_log() {
    [ -f "$1" ] || return 0
    local sz; sz=$(stat -c%s "$1" 2>/dev/null || stat -f%z "$1")
    echo "---- $1($sz 字节) ----"
    # 小日志整份打印(失败原因通常就这几行);大日志取首尾,避免刷屏
    if [ "$sz" -le 8192 ]; then cat "$1"; else head -10 "$1"; echo "  ...(略)..."; tail -30 "$1"; fi
    echo "---- 日志结束 ----"
}

# 分级哈希:Linux/Windows 用 md5sum,macOS 用 md5 -q,再退到 shasum(仅取证用,不参与判定)
hash_of() {
    if command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1
    elif command -v md5 >/dev/null 2>&1; then md5 -q "$1"
    else shasum -a 256 "$1" | cut -d' ' -f1
    fi
}

# DDC 软判开关:darwin 默认软判(平台链接器注入 LC_UUID/调试段,见头部说明)
DDC_SOFT=""
[ "$(uname -s)" = "Darwin" ] && DDC_SOFT=1
[ "${XT_DDC_SOFT:-}" = "1" ] && DDC_SOFT=1

[ -x "$GSC" ] || [ -f "$GSC" ] || fail "未找到种子编译器 $GSC(先执行: go build -o xt_gsc.exe .)"
[ -f "$SRC" ] || fail "未找到编译器源码 $SRC"
mkdir -p "$BUILD" "$SCRATCH"

# 环境自述:CI 首跑曾在此阶段失败而日志无上下文,故把关键路径与工具链版本前置打印
echo "[自举门禁] 环境: ROOT=$ROOT"
echo "[自举门禁] 环境: SRC=$(W "$SRC")"
echo "[自举门禁] 环境: SCRATCH=$SCRATCH"
echo "[自举门禁] 环境: clang=$(command -v clang || echo '(未找到)')  gcc=$(command -v gcc || echo '(未找到)')"
echo "[自举门禁] 环境: 平台=$(uname -s)  DDC=$( [ "$DDC_SOFT" = "1" ] && echo '软判(平台链接器注入 LC_UUID/调试段,不阻断)' || echo '硬判(逐字节一致)' )"
{ clang --version 2>&1 | head -1; gcc --version 2>&1 | head -1; } || true

echo "[自举门禁] 阶段零:工具链自检(GSC 编译并运行最小程序,隔离"工具链坏"与"大源码编译失败")"
PROBE_SRC="$SCRATCH/probe.xt"
PROBE_EXE="$SCRATCH/probe$EXE"
printf '示("工具链自检通过")\n' > "$PROBE_SRC"
rm -f "$PROBE_EXE"
( cd "$SCRATCH" && "$GSC" 铁 "$(W "$PROBE_SRC")" ) > "$SCRATCH/probe.log" 2>&1 \
    || { dump_log "$SCRATCH/probe.log"; fail "工具链自检:GSC 编译最小程序失败(clang/gcc 链路问题)"; }
[ -f "$PROBE_EXE" ] || { dump_log "$SCRATCH/probe.log"; fail "工具链自检:GSC 未产出 probe.exe"; }
"$PROBE_EXE" > "$SCRATCH/probe_run.log" 2>&1 || { dump_log "$SCRATCH/probe_run.log"; fail "工具链自检:probe.exe 运行失败"; }
grep -q "工具链自检通过" "$SCRATCH/probe_run.log" || { dump_log "$SCRATCH/probe_run.log"; fail "工具链自检:probe 输出异常"; }

echo "[自举门禁] 阶段一:GSC → s1(在独立目录内构建,避免产出仓库根的 玄铁.exe)"
# GSC 不支持 -sc,输出名取自源文件基名;而 Windows CI runner 区域为 en-US(CP1252),
# MinGW 的 gcc/ld 走窄字符 API,中文输出名会被打成 "??.exe" 致链接失败(实测 Issue #21:
# "ld.exe: cannot open output file ??.exe: Invalid argument")。故把源码整套复制到 scratch
# 并把入口改名为 ASCII(兄弟模块保留原名——`引 "编译"` 等按文件名解析,且只读不写)。
mkdir -p "$SCRATCH/src"
cp -f "$ROOT"/xuantie_compiler/*.xt "$SCRATCH/src/"
ENTRY="$SCRATCH/src/xentry.xt"
cp -f "$ROOT/xuantie_compiler/玄铁.xt" "$ENTRY"
rm -f "$SCRATCH/src/xentry$EXE" "$SCRATCH/xentry$EXE"
( cd "$SCRATCH" && "$GSC" 铁 "$(W "$ENTRY")" ) > "$SCRATCH/s1.log" 2>&1 || { dump_log "$SCRATCH/s1.log"; fail "GSC 编译 s1 失败"; }
[ -f "$SCRATCH/xentry$EXE" ] || { dump_log "$SCRATCH/s1.log"; fail "GSC 未产出 xentry.exe(见上方日志)"; }
mv -f "$SCRATCH/xentry$EXE" "$BUILD/xtc_s1$EXE"

echo "[自举门禁] 阶段二:逐级自举 s1 → s2 → s3 → s4"
for pair in "1 2" "2 3" "3 4"; do
    set -- $pair
    parent="$1"; child="$2"
    "$BUILD/xtc_s$parent$EXE" 铁 "$(W "$SRC")" -sc "$(W "$BUILD/xtc_s$child$EXE")" \
        > "$SCRATCH/s$child.log" 2>&1 || { dump_log "$SCRATCH/s$child.log"; fail "s$parent → s$child 失败"; }
    [ -f "$BUILD/xtc_s$child$EXE" ] || { dump_log "$SCRATCH/s$child.log"; fail "s$parent → s$child 未产出产物"; }
done

echo "[自举门禁] 阶段三:各级产物指纹"
    for n in 1 2 3 4; do
    f="$BUILD/xtc_s$n$EXE"
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    hash=$(hash_of "$f")
    echo "  s$n  size=$size  md5=$hash"
done

echo "[自举门禁] 阶段四:DDC 硬门禁(相邻级逐字节比对)"
for pair in "1 2" "2 3" "3 4"; do
    set -- $pair
    if cmp -s "$BUILD/xtc_s$1$EXE" "$BUILD/xtc_s$2$EXE"; then
        echo "  s$1 vs s$2: 逐字节一致"
        SAME="yes"
    else
        diff_bytes=$(cmp -l "$BUILD/xtc_s$1$EXE" "$BUILD/xtc_s$2$EXE" 2>/dev/null | wc -l)
        echo "  s$1 vs s$2: 差异 $diff_bytes 字节"
        SAME="no"
    fi
    if [ "$1" = "3" ] && [ "$SAME" != "yes" ]; then
        if [ "$DDC_SOFT" = "1" ]; then
            echo "  [DDC 软判] s3 与 s4 相差 $diff_bytes 字节,不直接阻断 —— darwin 上 ld64 每次链接注入随机 LC_UUID,"
            echo "             叠加 -g 的 DWARF 调试段不确定(issue #41 实测 200 字节),属平台链接器行为。"
            # 把"链接器注入的差异"与"代码生成差异"分开:s3/s4 各编同一个 fixture 并 -bl 保留中间产物,
            # 逐字节比对编译器自己生成的 IR —— IR 不含链接器注入的 LC_UUID/调试段,darwin 上同样可作硬判据。
            DDC_FIX="$SCRATCH/ddc_fixture.xt"
            printf '示("ddc")\n' > "$DDC_FIX"
            for n in 3 4; do
                rm -f "$SCRATCH/自举输出.ll" "$SCRATCH/ddc_s$n.ll"
                ( cd "$SCRATCH" && "$BUILD/xtc_s$n$EXE" 铁 "$(W "$DDC_FIX")" -bl -sc "$(W "$SCRATCH/ddc_s$n.exe")" ) \
                    > "$SCRATCH/ddc_s$n.log" 2>&1 || { dump_log "$SCRATCH/ddc_s$n.log"; fail "DDC 补判:s$n 编译 fixture 失败"; }
                [ -f "$SCRATCH/自举输出.ll" ] || { dump_log "$SCRATCH/ddc_s$n.log"; fail "DDC 补判:s$n 未保留 IR(-bl)"; }
                mv -f "$SCRATCH/自举输出.ll" "$SCRATCH/ddc_s$n.ll"
            done
            if cmp -s "$SCRATCH/ddc_s3.ll" "$SCRATCH/ddc_s4.ll"; then
                echo "  [DDC 补判] s3 与 s4 生成的 IR 逐字节一致 —— 已隔离链接器注入项,视为到达固定点"
            else
                ir_diff=$(cmp -l "$SCRATCH/ddc_s3.ll" "$SCRATCH/ddc_s4.ll" 2>/dev/null | wc -l)
                fail "DDC 补判:s3 与 s4 生成的 IR 不一致(差 $ir_diff 字节)—— 存在真实代码生成不确定性,不接受"
            fi
        else
            fail "s3 与 s4 未逐字节一致 —— 自举未到达固定点(源码变更后须重新收敛,或存在不确定性来源)"
        fi
    fi
done

echo "[自举门禁] 阶段五:链顶冒烟(s4 编译并运行 Test/01_基础测试.xt)"
SMOKE_EXE="$SCRATCH/smoke01$EXE"
rm -f "$SMOKE_EXE"
"$BUILD/xtc_s4$EXE" 铁 "$(W "$ROOT/Test/01_基础测试.xt")" -sc "$(W "$SMOKE_EXE")" > "$SCRATCH/smoke.log" 2>&1 \
    || { dump_log "$SCRATCH/smoke.log"; fail "s4 编译冒烟用例失败"; }
( cd "$ROOT" && "$SMOKE_EXE" ) > "$SCRATCH/smoke_run.log" 2>&1 \
    || { dump_log "$SCRATCH/smoke_run.log"; fail "s4 产物运行失败(退出码非零)"; }
grep -q "01_基础测试 结束" "$SCRATCH/smoke_run.log" || { dump_log "$SCRATCH/smoke_run.log"; fail "冒烟输出不完整(未见结束标记)"; }

echo "[自举门禁] 阶段六:pao/跑 冒烟(编译后立即运行;校验输出、噪声与退出码透传)"
PAO_SRC="$SCRATCH/pao_probe.xt"
PAO_LOG="$SCRATCH/pao.log"
printf '示("pao 冒烟通过")
' > "$PAO_SRC"
( cd "$SCRATCH" && "$BUILD/xtc_s4$EXE" pao "$(W "$PAO_SRC")" ) > "$PAO_LOG" 2>&1 || { dump_log "$PAO_LOG"; fail "pao 运行失败"; }
grep -q "pao 冒烟通过" "$PAO_LOG" || { dump_log "$PAO_LOG"; fail "pao 输出异常(未见程序输出)"; }
if grep -q "原生编译完成" "$PAO_LOG"; then dump_log "$PAO_LOG"; fail "pao 不该打印编译完成噪声(对齐 go run)"; fi
printf '终 3
' > "$PAO_SRC"
( cd "$SCRATCH" && "$BUILD/xtc_s4$EXE" 跑 "$(W "$PAO_SRC")" ) > "$PAO_LOG" 2>&1
pao_rc=$?
[ "$pao_rc" = "3" ] || { dump_log "$PAO_LOG"; fail "pao 退出码未透传(得到 $pao_rc,期望 3)"; }
# 产物名是 pao_<源基名>(纯 ASCII;中文会被 MinGW 打成 ? 致链接失败,已修)
if find "$SCRATCH" -maxdepth 1 -name "pao_*" ! -name "*.xt" | grep -q .; then fail "pao 未清理临时产物"; fi

echo "[自举门禁] 通过:s1..s4 建成,固定点在 s3→s4,s4 冒烟正常"
