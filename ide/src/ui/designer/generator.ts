// 铸造厂可视化 UI 设计器 —— 设计区文本生成器
// 规范: docs/铸造厂UI设计器-设计区规范.md(v1)
// 硬规矩(全部对应规范条款):
//   ① 无尾随逗号(数组/字典) ② 键按 KEY_ORDER 规范序、键一律双引号 ③ 每叶子控件一行、
//   ④ 每容器一条 设 语句(post-order,子容器先写) ⑤ 缩进 4 空格 ⑥ 同一棵树恒产出同一字节。
import { GEN, KEY_ORDER, keyRank, LIB_ALIAS, markBegin, markEnd, REGION_NOTE } from './spec';
import type { DesignNode, Val } from './parser';

/** 字符串字面量再发射时的转义(键与串值共用) */
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
}

export function valText(v: Val): string {
  switch (v.t) {
    case 'str': return v.raw;
    case 'num': return v.raw;
    case 'bool': return v.v ? '真' : '假';
    case 'stateGet': return `${LIB_ALIAS}.态取(${v.state}, "${esc(v.key)}")`;
    case 'colorConst': return `${LIB_ALIAS}.色彩["${esc(v.key)}"]`;
    case 'fnRef': return v.name;
    case 'idRef': return v.name;
    case 'dict': return dictText(v.entries);
  }
}

/** 字典文本(选项字典与子字典共用):键按规范序、键一律双引号、空字典 {} */
export function dictText(entries: Array<{ key: string; value: Val }>): string {
  if (entries.length === 0) return '{}';
  const sorted = [...entries].sort((a, b) => keyRank(a.key) - keyRank(b.key));
  return '{' + sorted.map(e => `"${esc(e.key)}": ${valText(e.value)}`).join(', ') + '}';
}

/** 选项字典(与 dictText 同规则,语义名分开以便阅读) */
export function optionsText(opts: Array<{ key: string; value: Val }>): string {
  return dictText(opts);
}

/** 叶子控件的单行调用文本:位置实参按序,选项字典恒在末位 */
export function leafText(node: DesignNode): string {
  const parts = node.args.map(valText);
  parts.push(optionsText(node.options));
  return `${LIB_ALIAS}.${node.widget}(${parts.join(', ')})`;
}

/** 给缺名的容器按树序分配确定性默认名(设计器新建节点走这条;解析产物保留原名) */
export function ensureVarNames(root: DesignNode): void {
  let n = 0;
  const walk = (node: DesignNode, isRoot: boolean): void => {
    if (node.kind === 'container') {
      if (!node.varName) {
        n++;
        node.varName = isRoot ? GEN.rootVar : `${GEN.nodeVarPrefix}${n}`;
      }
    }
    for (const ch of node.children) walk(ch, false);
  };
  walk(root, true);
}

/** 容器语句:多行 children(每项一行、无尾随逗号),选项字典内联 */
function containerStatement(node: DesignNode): string {
  const ind = GEN.indent;
  const kids = node.children.map(ch => (ch.kind === 'container' ? ch.varName ?? '' : leafText(ch)));
  const head = `${ind}设 ${node.varName} = ${LIB_ALIAS}.${node.widget}(`;
  if (kids.length === 0) {
    return `${head}[], ${optionsText(node.options)})`;
  }
  const inner = kids.map(k => `${ind}${ind}${k}`).join(',\n');
  return `${head}[\n${inner}\n${ind}], ${optionsText(node.options)})`;
}

/** 节点树 → 完整设计区文本(含标记与说明行;行尾用 \n,由 region 层按文件风格转换) */
export function generateDesignFunction(funcName: string, stateParam: string, root: DesignNode): string {
  ensureVarNames(root);
  const ind = GEN.indent;
  const lines: string[] = [];
  lines.push(markBegin(funcName));
  lines.push(REGION_NOTE);
  lines.push(`函 ${funcName}(${stateParam}) {`);

  if (root.kind === 'container') {
    const emit = (node: DesignNode): void => {
      for (const ch of node.children) if (ch.kind === 'container') emit(ch);
      lines.push(containerStatement(node));
    };
    emit(root);
  } else {
    lines.push(`${ind}设 ${root.varName ?? GEN.rootVar} = ${leafText(root)}`);
  }

  lines.push(`${ind}返 ${root.varName ?? GEN.rootVar}`);
  lines.push('}');
  lines.push(markEnd(funcName));
  return lines.join('\n') + '\n';
}

/** 规范序的只读副本(测试/属性面板展示用) */
export const CANONICAL_KEYS: readonly string[] = [...KEY_ORDER];
