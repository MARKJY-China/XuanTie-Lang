#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""玄铁性能基准跑分器。

设计原则(与 bench/README.md 的测量纪律一致):
  * 只用标准库, 任何一台装了 Python 的机器都能跑;
  * 每个数字都带机器与工具链信息 —— 没有上下文的数字不算数据;
  * 取多次运行的中位数, 同时保留全部原始值, 便于看抖动;
  * 与历史快照对比时**显式提示口径差异**(单次测量 vs 中位数), 不静默混比。

用法:
  python bench/run.py                       # 跑玄铁基准 → bench/results/<日期>.json
  python bench/run.py --runs 7              # 指定运行次数(默认 5)
  python bench/run.py --with-peers          # 同时跑 node/java/go/python 对照
  python bench/run.py --xtc build/xtc_s4.exe
  python bench/run.py --compare             # 对比 results/ 里最近两份快照
  python bench/run.py --compare a.json b.json
"""
import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / 'bench'
CASES = BENCH / 'cases'
RESULTS = BENCH / 'results'

# 输出形如 "空函数调用1e6: 1234 微秒" / "fib30递归: 1234 微秒 (f=832040)"(各语言同构)
CASE_RE = re.compile(r'^\s*(.+?)\s*[:：]\s*([0-9]+(?:\.[0-9]+)?)\s*微秒')


def sh(cmd, cwd=None, env=None, timeout=1800):
    """执行并返回 (退出码, stdout+stderr 文本)。非零退出不抛异常, 由调用方决定如何处理。"""
    e = dict(os.environ)
    e.update({'PYTHONUTF8': '1', 'PYTHONIOENCODING': 'utf-8'})
    if env:
        e.update(env)
    try:
        p = subprocess.run(cmd, cwd=str(cwd or ROOT), env=e, timeout=timeout,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        return p.returncode, p.stdout.decode('utf-8', 'replace')
    except FileNotFoundError as ex:
        return 127, f'(未找到可执行文件: {ex})'
    except subprocess.TimeoutExpired:
        return 124, '(超时)'


def parse_cases(text):
    """从程序输出里抽取 {用例名: 微秒}。"""
    out = {}
    for line in text.splitlines():
        m = CASE_RE.match(line)
        if m:
            name = m.group(1).strip()
            if name not in out:          # 同名取首次出现
                out[name] = float(m.group(2))
    return out


def md5_of(path):
    try:
        return hashlib.md5(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def machine_info():
    info = {
        'platform': platform.platform(),
        'machine': platform.machine(),
        'cpu_count': os.cpu_count(),
        'python': platform.python_version(),
    }
    if os.name == 'nt':
        rc, out = sh(['wmic', 'cpu', 'get', 'name'], timeout=60)
        if rc == 0:
            names = [ln.strip() for ln in out.splitlines()[1:] if ln.strip()]
            if names:
                info['cpu'] = names[0]
    if not info.get('cpu'):
        info['cpu'] = platform.processor() or '未知'
    return info


def toolchain_info(xtc):
    """记录一切会改变数字的东西: 编译器身份、自举链指纹、各对照语言版本。"""
    t = {'xtc_path': str(xtc)}
    if Path(xtc).exists():
        t['xtc_md5'] = md5_of(xtc)
        rc, out = sh([str(xtc), '-h'], timeout=60)
        if rc == 0 and out:
            t['xtc_version'] = out.splitlines()[0].strip()
    chain = {}
    for n in (1, 2, 3, 4):
        f = ROOT / f'build/xtc_s{n}.exe'
        if f.exists():
            chain[f's{n}'] = {'size': f.stat().st_size, 'md5': md5_of(f)}
    if chain:
        t['bootstrap_chain'] = chain
    for name, cmd in (('go', ['go', 'version']), ('node', ['node', '--version']),
                      ('java', ['java', '-version']), ('python', ['python', '--version']),
                      ('clang', ['clang', '--version']), ('gcc', ['gcc', '--version'])):
        rc, out = sh(cmd, timeout=60)
        if rc == 0 and out.strip():
            t[name] = out.strip().splitlines()[0].strip()
    rc, out = sh(['go', 'env', 'GOHOSTARCH'], timeout=60)
    if rc == 0 and out.strip():
        t['go_host_arch'] = out.strip()
    return t


# ── 基准主体 ──────────────────────────────────────────────────────────────

def bench_xt(xtc, runs, do_compile=True):
    """玄铁: 编译计时(冷/热) + 运行 N 次取中位数。"""
    src = CASES / 'xt_bench.xt'
    work = Path(tempfile.mkdtemp(prefix='xt_bench_'))
    exe = work / 'xt_bench.exe'
    result = {'lang': '玄铁', 'source': str(src.relative_to(ROOT))}
    if do_compile:
        cache = work / 'cache'
        cache.mkdir(parents=True, exist_ok=True)
        cold_env = {'TMPDIR': str(cache), 'TEMP': str(cache), 'TMP': str(cache)}
        t0 = time.perf_counter()
        rc, out = sh([str(xtc), 'tie', str(src), '-sc', str(exe)], env=cold_env)
        result['compile_cold_ms'] = round((time.perf_counter() - t0) * 1000, 1)
        if rc != 0:
            result['compile_error'] = out[-2000:]
            return result, {}
        t0 = time.perf_counter()
        rc, _ = sh([str(xtc), 'tie', str(src), '-sc', str(exe)], env=cold_env)
        result['compile_warm_ms'] = round((time.perf_counter() - t0) * 1000, 1)
        result['binary_bytes'] = exe.stat().st_size
    if not exe.exists():
        rc, out = sh([str(xtc), 'tie', str(src), '-sc', str(exe)])
        if rc != 0:
            result['compile_error'] = out[-2000:]
            return result, {}
    per_case = {}
    for _ in range(runs):
        rc, out = sh([str(exe)], timeout=900)
        if rc != 0:
            result.setdefault('run_errors', []).append(f'退出码 {rc}: {out[-400:]}')
        for k, v in parse_cases(out).items():
            per_case.setdefault(k, []).append(v)
    return result, per_case


def bench_startup(xtc, runs):
    """启动耗时: 空程序(无输出, 只测进程启动 + 运行时初始化 + 退出)。"""
    work = Path(tempfile.mkdtemp(prefix='xt_startup_'))
    src = work / 'noop.xt'
    src.write_text('设 x = 1\n', encoding='utf-8')
    exe = work / 'noop.exe'
    rc, out = sh([str(xtc), 'tie', str(src), '-sc', str(exe)])
    if rc != 0:
        return {'error': out[-800:]}
    vals = []
    for _ in range(runs):
        t0 = time.perf_counter()
        rc, _ = sh([str(exe)], timeout=120)
        vals.append((time.perf_counter() - t0) * 1000)
    return {'min_ms': round(min(vals), 3), 'median_ms': round(statistics.median(vals), 3),
            'all_ms': [round(v, 3) for v in vals]}


PEERS = {
    'node': {'cmd': ['node', str(CASES / 'node_bench.js')], 'build': None},
    'java': {'cmd': ['java', '-Dstdout.encoding=UTF-8', '-Dfile.encoding=UTF-8',
                     str(CASES / 'BenchJava.java')], 'build': None},
    'go': {'cmd': None, 'build': ['go', 'build', '-o', '{exe}', str(CASES / 'go_bench.go')]},
    'python': {'cmd': ['python', str(CASES / 'python_bench.py')], 'build': None},
}


def bench_peer(name, runs):
    cfg = PEERS[name]
    work = Path(tempfile.mkdtemp(prefix=f'{name}_bench_'))
    exe = work / (name + ('.exe' if os.name == 'nt' else ''))
    entry = {'lang': name}
    cmd = cfg['cmd']
    if cfg['build']:
        bc = [str(exe) if a == '{exe}' else a for a in cfg['build']]
        t0 = time.perf_counter()
        rc, out = sh(bc)
        entry['compile_ms'] = round((time.perf_counter() - t0) * 1000, 1)
        if rc != 0:
            entry['error'] = out[-800:]
            return entry, {}
        cmd = [str(exe)]
    rc, probe = sh(cmd, timeout=900)
    if rc != 0:
        entry['error'] = probe[-800:]
        return entry, {}
    per_case = {}
    for k, v in parse_cases(probe).items():
        per_case.setdefault(k, []).append(v)
    for _ in range(max(0, runs - 1)):
        rc, out = sh(cmd, timeout=900)
        for k, v in parse_cases(out).items():
            per_case.setdefault(k, []).append(v)
    return entry, per_case


def snapshot(xtc, runs, with_peers):
    cases, xtc_entry = [], None
    xt_entry, per_case = bench_xt(xtc, runs)
    xtc_entry = xt_entry
    for name, vals in per_case.items():
        cases.append({'lang': '玄铁', 'name': name, 'median_us': round(statistics.median(vals), 1),
                      'min_us': min(vals), 'all_us': [round(v, 1) for v in vals]})
    if with_peers:
        for peer in ('node', 'java', 'go', 'python'):
            entry, per = bench_peer(peer, runs)
            xtc_entry.setdefault('peers', {})[peer] = {k: v for k, v in entry.items()}
            for name, vals in per.items():
                cases.append({'lang': peer, 'name': name,
                              'median_us': round(statistics.median(vals), 1),
                              'min_us': min(vals), 'all_us': [round(v, 1) for v in vals]})
    return {
        'date': time.strftime('%Y-%m-%d'),
        'time': time.strftime('%H:%M:%S'),
        'kind': 'measured',
        'method': {'runs': runs, 'aggregate': 'median',
                   'note': '玄铁用 XTC 默认优化等级(与 2026-08-15 历史口径同); 编译计时分冷/热(冷=空缓存目录)'},
        'machine': machine_info(),
        'toolchain': toolchain_info(xtc),
        'compile_and_binary': xtc_entry,
        'startup': bench_startup(xtc, runs),
        'cases': cases,
    }, xtc_entry


def field(d, path, default=None):
    cur = d
    for k in path.split('.'):
        if not isinstance(cur, dict) or k not in cur:
            return default
        cur = cur[k]
    return cur


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def cmd_compare(a_path, b_path):
    a, b = load(a_path), load(b_path)
    print(f'A: {a_path}  ({a.get("date")} {a.get("time","")}, 口径 {field(a,"method.aggregate","单次")})')
    print(f'B: {b_path}  ({b.get("date")} {b.get("time","")}, 口径 {field(b,"method.aggregate","单次")})')
    if field(a, 'method.aggregate', '单次') != field(b, 'method.aggregate', '单次'):
        print('!! 注意: 两份快照的测量口径不同(单次 vs 中位数), 下面的百分比只能当方向性参考')
    print()
    key = lambda c: (c.get('lang'), c.get('name'))
    amap = {key(c): c for c in a.get('cases', [])}
    rows = []
    for c in b.get('cases', []):
        old = amap.get(key(c))
        if not old:
            rows.append((c['lang'], c['name'], old, c))
            continue
        rows.append((c['lang'], c['name'], old, c))
    print(f'{"语言":<8}{"用例":<16}{"旧(µs)":>12}{"新(µs)":>12}{"变化":>14}{"差值(ms)":>12}')
    print('-' * 76)
    for lang, name, old, new in rows:
        if not old:
            print(f'{lang:<8}{name:<16}{"—":>12}{new["median_us"]:>12,.0f}{"(新增)":>14}{"—":>12}')
            continue
        o, n = old['median_us'], new['median_us']
        pct = (n - o) / o * 100 if o else 0
        print(f'{lang:<8}{name:<16}{o:>12,.0f}{n:>12,.0f}{pct:>+13.1f}%{(n-o)/1000:>+12,.1f}')
    for label, path in (('A', 'compile_and_binary.compile_cold_ms'),
                        ('B', 'compile_and_binary.compile_cold_ms')):
        pass
    ca = field(a, 'compile_and_binary.compile_cold_ms')
    cb = field(b, 'compile_and_binary.compile_cold_ms')
    if ca and cb:
        print(f'\n玄铁编译(冷): {ca:.0f} ms → {cb:.0f} ms  ({(cb-ca)/ca*100:+.1f}%, {(cb-ca):+.0f} ms)')
    sa = field(a, 'startup.min_ms')
    sb = field(b, 'startup.min_ms')
    if sa and sb:
        print(f'启动(空程序): {sa:.2f} ms → {sb:.2f} ms  ({(sb-sa)/sa*100:+.1f}%, {sb-sa:+.2f} ms)')


def main():
    ap = argparse.ArgumentParser(description='玄铁性能基准跑分器')
    ap.add_argument('--xtc', default=None, help='编译器路径(默认 build/xtc_s4.exe, 回退 build/xtc.exe)')
    ap.add_argument('--runs', type=int, default=5, help='运行次数(默认 5, 取中位数)')
    ap.add_argument('--with-peers', action='store_true', help='同时跑 node/java/go/python 对照')
    ap.add_argument('--label', default=None, help='结果文件名标签(默认当天日期)')
    ap.add_argument('--out', default=None, help='直接指定输出 JSON 路径')
    ap.add_argument('--compare', nargs='*', help='对比两份快照; 不带参数则取 results/ 里最近两份')
    args = ap.parse_args()

    if args.compare is not None:
        if len(args.compare) == 2:
            return cmd_compare(args.compare[0], args.compare[1])
        files = sorted(RESULTS.glob('*.json'))
        if len(files) < 2:
            print('results/ 里不足两份快照, 无法对比', file=sys.stderr)
            return 2
        return cmd_compare(str(files[-2]), str(files[-1]))

    xtc = args.xtc or str(ROOT / 'build/xtc_s4.exe')
    if not Path(xtc).exists():
        alt = ROOT / 'build/xtc.exe'
        if alt.exists():
            xtc = str(alt)
        else:
            print(f'错误: 未找到编译器 {xtc}(跑过一次自举门禁即可生成)', file=sys.stderr)
            return 1

    print(f'编译器: {xtc}')
    snap, _ = snapshot(xtc, args.runs, args.with_peers)
    out = Path(args.out) if args.out else RESULTS / f'{args.label or snap["date"]}.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snap, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'已写入 {out.relative_to(ROOT)}')
    print(f'  编译(冷/热): {snap["compile_and_binary"].get("compile_cold_ms")} / '
          f'{snap["compile_and_binary"].get("compile_warm_ms")} ms')
    print(f'  启动(空程序): {snap["startup"].get("min_ms")} ms')
    for c in snap['cases']:
        print(f'  {c["lang"]:<7}{c["name"]:<16}{c["median_us"]:>12,.0f} µs')
    return 0


if __name__ == '__main__':
    sys.exit(main())
