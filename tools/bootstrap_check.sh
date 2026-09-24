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
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
GSC="$ROOT/xt_gsc.exe"
SRC="$ROOT/xuantie_compiler/玄铁.xt"
BUILD="$ROOT/build"
SCRATCH="$ROOT/temp/_bootstrap_scratch"

fail() { echo "[自举门禁] 失败: $*" >&2; exit 1; }

[ -x "$GSC" ] || [ -f "$GSC" ] || fail "未找到种子编译器 $GSC(先执行: go build -o xt_gsc.exe .)"
[ -f "$SRC" ] || fail "未找到编译器源码 $SRC"
mkdir -p "$BUILD" "$SCRATCH"

echo "[自举门禁] 阶段一:GSC → s1(在独立目录内构建,避免产出仓库根的 玄铁.exe)"
rm -f "$SCRATCH/玄铁.exe"
( cd "$SCRATCH" && "$GSC" 铁 "$SRC" ) > "$SCRATCH/s1.log" 2>&1 || { tail -20 "$SCRATCH/s1.log"; fail "GSC 编译 s1 失败"; }
[ -f "$SCRATCH/玄铁.exe" ] || fail "GSC 未产出 玄铁.exe(检查 s1.log)"
mv -f "$SCRATCH/玄铁.exe" "$BUILD/xtc_s1.exe"

echo "[自举门禁] 阶段二:逐级自举 s1 → s2 → s3 → s4"
for pair in "1 2" "2 3" "3 4"; do
    set -- $pair
    parent="$1"; child="$2"
    "$BUILD/xtc_s$parent.exe" 铁 "$SRC" -sc "$BUILD/xtc_s$child.exe" \
        > "$SCRATCH/s$child.log" 2>&1 || { tail -20 "$SCRATCH/s$child.log"; fail "s$parent → s$child 失败"; }
    [ -f "$BUILD/xtc_s$child.exe" ] || fail "s$parent → s$child 未产出产物"
done

echo "[自举门禁] 阶段三:各级产物指纹"
for n in 1 2 3 4; do
    f="$BUILD/xtc_s$n.exe"
    size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
    hash=$(md5sum "$f" | cut -d' ' -f1)
    echo "  s$n  size=$size  md5=$hash"
done

echo "[自举门禁] 阶段四:DDC 硬门禁(相邻级逐字节比对)"
for pair in "1 2" "2 3" "3 4"; do
    set -- $pair
    if cmp -s "$BUILD/xtc_s$1.exe" "$BUILD/xtc_s$2.exe"; then
        echo "  s$1 vs s$2: 逐字节一致"
        SAME="yes"
    else
        diff_bytes=$(cmp -l "$BUILD/xtc_s$1.exe" "$BUILD/xtc_s$2.exe" 2>/dev/null | wc -l)
        echo "  s$1 vs s$2: 差异 $diff_bytes 字节"
        SAME="no"
    fi
    if [ "$1" = "3" ] && [ "$SAME" != "yes" ]; then
        fail "s3 与 s4 未逐字节一致 —— 自举未到达固定点(源码变更后须重新收敛,或存在不确定性来源)"
    fi
done

echo "[自举门禁] 阶段五:链顶冒烟(s4 编译并运行 Test/01_基础测试.xt)"
SMOKE_EXE="$SCRATCH/smoke01.exe"
rm -f "$SMOKE_EXE"
"$BUILD/xtc_s4.exe" 铁 "$ROOT/Test/01_基础测试.xt" -sc "$SMOKE_EXE" > "$SCRATCH/smoke.log" 2>&1 \
    || { tail -20 "$SCRATCH/smoke.log"; fail "s4 编译冒烟用例失败"; }
( cd "$ROOT" && "$SMOKE_EXE" ) > "$SCRATCH/smoke_run.log" 2>&1 \
    || { tail -20 "$SCRATCH/smoke_run.log"; fail "s4 产物运行失败(退出码非零)"; }
grep -q "01_基础测试 结束" "$SCRATCH/smoke_run.log" || fail "冒烟输出不完整(未见结束标记)"

echo "[自举门禁] 通过:s1..s4 建成,固定点在 s3→s4,s4 冒烟正常"
