# -*- coding: utf-8 -*-
# 玄铁 VSCode 语法(TextMate)自检脚本 —— 防止着色规则退化的永久门禁
#
# 为什么需要它:TextMate 规则是同位置「先匹配者胜」,而 Oniguruma 的 \b 只把 [A-Za-z0-9_]
# 当单词字符(CJK 不算),所以关键字/词形操作符若用 \b 或干脆不设边界,就会出现
# 「是否完成」里的「是」被当成操作符、标识符被劈成两半这类缺陷——纯靠肉眼看编辑器很难查全。
# 本脚本:① 校验所有词形规则的边界断言(含转义是否正确) ② 离线复现着色并断言若干样本。
#
# 用法: python tools/check_grammar.py            (项目根目录)
import io, json, os, regex, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
GRAMMAR = os.path.join(ROOT, "extensions", "xuantie-syntax", "syntaxes", "xuantie.tmLanguage.json")
ID = r'[\p{L}\p{N}_?]'

def load():
    return json.loads(io.open(GRAMMAR, encoding='utf-8').read())

def flatten(patterns, repo, depth=0):
    out = []
    if depth > 1:
        return out
    for p in patterns:
        if 'include' in p:
            ref = p['include']
            sub = {'patterns': repo['__self__']} if ref == '$self' else repo[ref.lstrip('#')]
            out.extend(flatten(sub.get('patterns', []), repo, depth + 1))
        elif 'match' in p:
            out.append({'name': p.get('name', ''), 're': p['match'], 'kind': 'match'})
        elif 'begin' in p:
            out.append({'name': p.get('name', ''), 'begin': p['begin'], 'end': p['end'],
                        'kind': 'block'})
    return out

def tokenize(line, rules):
    spans, i, n = [], 0, len(line)
    while i < n:
        hit = None
        for r in rules:
            pat = r['re'] if r['kind'] == 'match' else r['begin']
            m = regex.compile(pat).search(line, i)
            if m and m.start() == i and m.end() > m.start():
                hit = (r, m)
                break
        if not hit:
            i += 1
            continue
        r, m = hit
        if r['kind'] == 'match':
            spans.append((m.start(), m.end(), r['name']))
            i = m.end()
        else:
            endm = regex.compile(r['end']).search(line, m.end())
            e = endm.end() if endm else len(line)
            spans.append((m.start(), e, r['name']))
            i = e
    return spans

def main():
    g = load()
    repo = dict(g['repository'])
    repo['__self__'] = g['patterns']
    rules = flatten(g['patterns'], repo)
    bad = 0

    # ① 边界断言自检:词形规则必须含 CJK 边界,且反斜杠只有一层(两层会退化为字面反斜杠)
    wordy = []
    for key in ('keywords', 'operators', 'constants'):
        for p in g['repository'][key]['patterns']:
            m = p.get('match', '')
            if any('\u4e00' <= ch <= '\u9fff' for ch in m):
                wordy.append((key, p.get('name'), m))
    for key, name, m in wordy:
        has_b = ('(?!' + ID + ')') in m or ('(?<!' + ID + ')') in m
        double_esc = r'[\\p' in m
        if double_esc or not has_b:
            bad += 1
            print('BAD 词形规则边界缺失/转义错误: [%s] %s -> %s' % (key, name, m))
    print('① 词形规则边界自检: 共 %d 条, 异常 %d 条' % (len(wordy), bad))

    # ② 着色样本断言:期望用「候选 scope 集合」——同一段文字可能被 keywords 或 operators 先匹配
    #    (两处列表都含 是/且/或/非,同位置先匹配者胜;此处只要颜色类别合理即可)
    samples = [
        ('设 是否完成:布尔 = 假', [[('variable.other.readwrite.xt', '是否完成')]], '标识符不被劈开'),
        ('设 是非 = 真',       [[('variable.other.readwrite.xt', '是非')]],      '是非 整体为标识符'),
        ('若 x 是 整 { }',    [[('keyword.operator.logical.xt', '是'), ('keyword.control.xt', '是')]],
         '独立 是 仍是关键字/操作符'),
        ('设 a=1',            [[('keyword.operator.assignment.xt', '=')]],     '无空格赋值仍识别(符号类不加 CJK 边界)'),
        ('设 s = "https://a.b"', [[('string.quoted.double.xt', '"https://a.b"')]], '字符串内的 // 不被当注释'),
        ('设 真空 = 1',       [[('variable.other.readwrite.xt', '真空')]],      '真空 不是常量 真'),
        ('设 位与数 = 1',     [[('variable.other.readwrite.xt', '位与数')]],    '位与数 不是位与操作符'),
        ('设 x = a 位与 b',   [[('keyword.operator.bitwise.xt', '位与')]],      '独立 位与 是操作符'),
        ('设 这等于 = 1',     [[('variable.other.readwrite.xt', '这等于')]],    '这等于 不是 等于 操作符'),
    ]
    for line, want_groups, desc in samples:
        spans = tokenize(line, rules)
        got = [(s[2], line[s[0]:s[1]]) for s in spans]
        for group in want_groups:
            if not any(cand in got for cand in group):
                bad += 1
                print('BAD 着色: %-28s 期望 %s; 实得 %s' % (line, group, got))
    print('② 着色样本: 共 %d 条' % len(samples))

    if bad:
        print('语法自检失败: %d 项' % bad)
        return 1
    print('语法自检通过')
    return 0

if __name__ == '__main__':
    sys.exit(main())
