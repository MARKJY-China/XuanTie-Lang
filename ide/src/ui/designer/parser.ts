// 铸造厂可视化 UI 设计器 —— 设计区子集解析器
// 规范: docs/铸造厂UI设计器-设计区规范.md(v1);本模块只认规范定义的子集,
// 子集之外(若/遍历/内联闭包/表达式/未知控件/多余语句/槽位形态不符)一律记入 issues
// 并置 ok=false,由上层据此把该设计区切为"只读"(绝不改写不理解的内容)。
import { LIB_ALIAS, WIDGETS, type ArgShape } from './spec';

/** 设计区里可出现的值(白名单;raw 保留源字面以便逐字节再生) */
export type Val =
  | { t: 'str'; raw: string; v: string }
  | { t: 'num'; raw: string }
  | { t: 'bool'; v: boolean }
  | { t: 'stateGet'; state: string; key: string } // UI.态取(s, "键")
  | { t: 'colorConst'; key: string }              // UI.色彩["键"]
  | { t: 'fnRef'; name: string }                  // 具名函引用(可跨模块:B.处理点击)
  | { t: 'idRef'; name: string };                 // 标识符引用(子容器名/状态实参)

export interface DesignNode {
  widget: string;
  kind: 'container' | 'leaf';
  /** 容器必有(设 <名> = …);叶子无 */
  varName?: string;
  /** 位置实参,按 WIDGETS[widget].args 中非结构槽(value/src/num/state/key)的顺序 */
  args: Val[];
  /** 选项字典(保持源出现序;生成时按规范序重排) */
  options: Array<{ key: string; value: Val }>;
  children: DesignNode[];
  /** 相对传入文本的行号(1-based) */
  line: number;
  endLine: number;
}

export interface ParseIssue {
  line: number;
  message: string;
}

export interface ParseResult {
  /** true = 完全符合子集(设计器可编辑并重写);false = 含非子集内容(只读) */
  ok: boolean;
  issues: ParseIssue[];
  funcName?: string;
  stateParam?: string;
  root?: DesignNode;
}

// ---------------------------------------------------------------- 词法

interface Token {
  t: 'id' | 'str' | 'num' | 'p' | 'eof';
  v: string;
  raw: string;
  line: number;
}

const ID_START = /[\p{L}_]/u;
const ID_CONT = /[\p{L}\p{N}_]/u;

function decodeStr(raw: string): string {
  // raw 含两端引号;只解规范要求的最小转义集,其余原样保留
  const inner = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\' && i + 1 < inner.length) {
      const n = inner[i + 1];
      if (n === '"' || n === '\\') { out += n; i++; continue; }
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
    }
    out += c;
  }
  return out;
}

function tokenize(src: string, issues: ParseIssue[]): Token[] {
  const toks: Token[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      const start = i;
      const startLine = line;
      i++;
      let closed = false;
      while (i < n) {
        if (src[i] === '\\' && i + 1 < n) { i += 2; continue; }
        if (src[i] === '"') { closed = true; i++; break; }
        if (src[i] === '\n') break;
        i++;
      }
      if (!closed) {
        issues.push({ line: startLine, message: '字符串字面量未闭合' });
        continue;
      }
      const raw = src.slice(start, i);
      toks.push({ t: 'str', v: decodeStr(raw), raw, line: startLine });
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < n && ((src[i] >= '0' && src[i] <= '9') || src[i] === '.')) i++;
      const raw = src.slice(start, i);
      toks.push({ t: 'num', v: raw, raw, line });
      continue;
    }
    if (ID_START.test(c)) {
      const start = i;
      while (i < n && ID_CONT.test(src[i])) i++;
      const raw = src.slice(start, i);
      toks.push({ t: 'id', v: raw, raw, line });
      continue;
    }
    if ('(){}[],:=.'.includes(c)) {
      toks.push({ t: 'p', v: c, raw: c, line });
      i++;
      continue;
    }
    issues.push({ line, message: `不支持的字符 '${c}'(子集外)` });
    i++;
  }
  toks.push({ t: 'eof', v: '', raw: '', line });
  return toks;
}

// ---------------------------------------------------------------- 语法

interface Cursor {
  toks: Token[];
  i: number;
  issues: ParseIssue[];
  funcStateParam: string;
}

function peek(c: Cursor, off = 0): Token { return c.toks[Math.min(c.i + off, c.toks.length - 1)]; }
function next(c: Cursor): Token { const t = peek(c); if (t.t !== 'eof') c.i++; return t; }
function bad(c: Cursor, message: string, line?: number): void {
  c.issues.push({ line: line ?? peek(c).line, message });
}

function expectP(c: Cursor, ch: string): boolean {
  const t = peek(c);
  if (t.t === 'p' && t.v === ch) { next(c); return true; }
  bad(c, `此处应为 '${ch}'(实际:${t.t === 'eof' ? '文本结束' : `'${t.raw}'`})`);
  return false;
}

function expectId(c: Cursor, what: string): string {
  const t = peek(c);
  if (t.t === 'id') { next(c); return t.v; }
  bad(c, `此处应为${what}(实际:${t.t === 'eof' ? '文本结束' : `'${t.raw}'`})`);
  return '';
}

/** 值白名单:字面量 / UI.态取(s,"键") / UI.色彩["键"] / 具名引用(可跨模块) / 负数字面量 */
function parseValue(c: Cursor, slot: 'option' | 'value' | 'src' | 'state' | 'key' | 'num'): Val | undefined {
  const t = peek(c);
  if (t.t === 'str') { next(c); return { t: 'str', raw: t.raw, v: t.v }; }
  if (t.t === 'num') { next(c); return { t: 'num', raw: t.raw }; }
  if (t.t === 'p' && t.v === '-') {
    next(c);
    const num = peek(c);
    if (num.t === 'num') { next(c); return { t: 'num', raw: '-' + num.raw }; }
    bad(c, '负号后应为数字字面量');
    return undefined;
  }
  if (t.t === 'id') {
    if (t.v === '真' || t.v === '假') { next(c); return { t: 'bool', v: t.v === '真' }; }
    if (slot === 'state') { next(c); return { t: 'idRef', name: t.v }; }
    if (t.v === LIB_ALIAS && peek(c, 1).t === 'p' && peek(c, 1).v === '.') {
      const mem = peek(c, 2);
      if (mem.t === 'id' && mem.v === '态取') {
        next(c); next(c); next(c); // UI . 态取
        if (!expectP(c, '(')) return undefined;
        const state = expectId(c, '状态变量名');
        if (!expectP(c, ',')) return undefined;
        const key = peek(c);
        if (key.t !== 'str') { bad(c, `${LIB_ALIAS}.态取 的键应为字符串字面量`); return undefined; }
        next(c);
        if (!expectP(c, ')')) return undefined;
        return { t: 'stateGet', state, key: key.v };
      }
      if (mem.t === 'id' && mem.v === '色彩') {
        next(c); next(c); next(c); // UI . 色彩
        if (!expectP(c, '[')) return undefined;
        const key = peek(c);
        if (key.t !== 'str') { bad(c, `${LIB_ALIAS}.色彩 的键应为字符串字面量`); return undefined; }
        next(c);
        if (!expectP(c, ']')) return undefined;
        return { t: 'colorConst', key: key.v };
      }
      bad(c, `值槽只允许 字面量 / ${LIB_ALIAS}.态取 / ${LIB_ALIAS}.色彩 / 具名引用(发现 ${LIB_ALIAS}.${mem.t === 'id' ? mem.v : '?'})`);
      return undefined;
    }
    let name = t.v;
    next(c);
    if (peek(c).t === 'p' && peek(c).v === '.') {
      next(c);
      name = name + '.' + expectId(c, '模块成员名');
    }
    return { t: 'fnRef', name };
  }
  bad(c, `值槽只允许 字面量 / ${LIB_ALIAS}.态取 / ${LIB_ALIAS}.色彩 / 具名引用`);
  return undefined;
}

/** 槽位形态校验(严格子集:形态不符即只读,避免再生时改义) */
function checkSlotShape(c: Cursor, slot: ArgShape, v: Val, line: number): void {
  const ok =
    slot === 'value' || slot === 'src' ? (v.t === 'str' || v.t === 'stateGet')
    : slot === 'key' ? v.t === 'str'
    : slot === 'num' ? v.t === 'num'
    : slot === 'state' ? v.t === 'idRef'
    : true;
  if (!ok) bad(c, `槽位形态不符:该实参应为 ${slot}(值类型:${v.t})`, line);
}

function parseOptions(c: Cursor): Array<{ key: string; value: Val }> {
  const out: Array<{ key: string; value: Val }> = [];
  if (!expectP(c, '{')) return out;
  if (peek(c).t === 'p' && peek(c).v === '}') { next(c); return out; }
  for (;;) {
    const kt = peek(c);
    let key: string | undefined;
    if (kt.t === 'str') { key = kt.v; next(c); }
    else if (kt.t === 'id') { key = kt.v; next(c); } // 裸标识符键(CSS 风)
    else { bad(c, '选项键应为字符串或裸标识符'); break; }
    if (!expectP(c, ':')) break;
    const val = parseValue(c, 'option');
    if (!val) break;
    out.push({ key, value: val });
    const sep = peek(c);
    if (sep.t === 'p' && sep.v === ',') { next(c); continue; }
    break;
  }
  expectP(c, '}');
  return out;
}

/** children 槽:叶子调用内联,容器通过"名字"引用(规范:容器必须先 设 成名字) */
function parseChildren(c: Cursor): { nodes: DesignNode[]; refs: Array<{ name: string; line: number }> } {
  const nodes: DesignNode[] = [];
  const refs: Array<{ name: string; line: number }> = [];
  if (!expectP(c, '[')) return { nodes, refs };
  if (peek(c).t === 'p' && peek(c).v === ']') { next(c); return { nodes, refs }; }
  for (;;) {
    const t = peek(c);
    if (t.t === 'id' && peek(c, 1).t === 'p' && peek(c, 1).v === '.') {
      const r = parseUiCall(c);
      if (r) {
        if (r.node.kind === 'container') {
          bad(c, `children 里不允许内联容器调用('${r.node.widget}'),请先 设 <名> = ${LIB_ALIAS}.${r.node.widget}(…),再引用该名字`, r.node.line);
        } else {
          nodes.push(r.node);
        }
      }
    } else if (t.t === 'id') {
      next(c);
      refs.push({ name: t.v, line: t.line });
    } else {
      bad(c, 'children 槽只允许 叶子控件调用 或 容器名字引用');
      break;
    }
    const sep = peek(c);
    if (sep.t === 'p' && sep.v === ',') { next(c); continue; }
    break;
  }
  expectP(c, ']');
  return { nodes, refs };
}

interface CallResult {
  node: DesignNode;
  childRefs: Array<{ name: string; line: number }>;
}

/** 解析 UI.<控件>(…)(含参数形态校验) */
function parseUiCall(c: Cursor): CallResult | undefined {
  const aliasTok = peek(c);
  if (aliasTok.t !== 'id' || aliasTok.v !== LIB_ALIAS) {
    bad(c, `设计区内只允许 ${LIB_ALIAS}.<控件>(…) 调用`);
    return undefined;
  }
  next(c);
  if (!expectP(c, '.')) return undefined;
  const nameTok = peek(c);
  if (nameTok.t !== 'id') { bad(c, '控件名缺失'); return undefined; }
  next(c);
  const widget = nameTok.v;
  const spec = WIDGETS[widget];
  if (!spec) {
    bad(c, `未知控件 '${widget}'(设计区只认 UI 库 14 个构造器之一;如需新控件请先扩充规范与元数据表)`, nameTok.line);
    return undefined;
  }
  const node: DesignNode = {
    widget, kind: spec.kind, args: [], options: [], children: [],
    line: nameTok.line, endLine: nameTok.line,
  };
  let childRefs: Array<{ name: string; line: number }> = [];
  if (!expectP(c, '(')) return undefined;
  for (let ai = 0; ai < spec.args.length; ai++) {
    const shape = spec.args[ai];
    if (shape === 'children') {
      const r = parseChildren(c);
      node.children = r.nodes;
      childRefs = r.refs;
    } else if (shape === 'options') {
      node.options = parseOptions(c);
    } else {
      const line = peek(c).line;
      const v = parseValue(c, shape);
      if (!v) return undefined;
      checkSlotShape(c, shape, v, line);
      node.args.push(v);
    }
    if (ai < spec.args.length - 1 && !expectP(c, ',')) return undefined;
  }
  expectP(c, ')');
  node.endLine = peek(c).line;
  return { node, childRefs };
}

// ---------------------------------------------------------------- 顶层

interface RawDecl { name: string; node: DesignNode; refs: Array<{ name: string; line: number }>; line: number }

export function parseDesignFunction(src: string): ParseResult {
  const issues: ParseIssue[] = [];
  const toks = tokenize(src, issues);
  const c: Cursor = { toks, i: 0, issues, funcStateParam: '' };

  // 找构建函(标记行是注释,已在词法阶段跳过)
  while (peek(c).t !== 'eof' && !(peek(c).t === 'id' && peek(c).v === '函')) next(c);
  if (peek(c).t === 'eof') {
    issues.push({ line: 1, message: '设计区内未找到 函 <名字>(<状态>) { … }' });
    return { ok: false, issues };
  }
  next(c);
  const funcName = expectId(c, '函数名');
  if (!expectP(c, '(')) return { ok: false, issues };
  const stateParam = expectId(c, '状态参数名');
  c.funcStateParam = stateParam;
  if (!expectP(c, ')')) return { ok: false, issues };
  if (!expectP(c, '{')) return { ok: false, issues };

  // 语句:若干 设 <名> = UI.控件(…)
  const decls = new Map<string, RawDecl>();
  const order: string[] = [];
  while (peek(c).t === 'id' && peek(c).v === '设') {
    next(c);
    const nameTok = peek(c);
    const name = expectId(c, '变量名');
    if (!expectP(c, '=')) break;
    const call = parseUiCall(c);
    if (!call) break;
    if (name) {
      if (decls.has(name)) bad(c, `变量名重复:'${name}'`, nameTok.line);
      else if (call.node.kind === 'leaf') bad(c, `叶子控件不参与 设 命名('${name}');直接写在 children 里即可`, nameTok.line);
      else {
        call.node.varName = name;
        decls.set(name, { name, node: call.node, refs: call.childRefs, line: nameTok.line });
        order.push(name);
      }
    }
  }

  // 末尾 返 <根名>
  let rootName = '';
  if (peek(c).t === 'id' && peek(c).v === '返') {
    next(c);
    rootName = expectId(c, '根节点变量名');
  } else {
    bad(c, '设计区函数末尾缺少 返 <根变量名>');
  }
  expectP(c, '}');
  if (peek(c).t !== 'eof') {
    bad(c, '设计区内除构建函外不允许其它内容(一个区一个界面)');
  }

  // 组装树:展开容器引用,检环 / 检未定义 / 检未引用
  const used = new Set<string>();
  const expand = (name: string, chain: string[], refLine?: number): DesignNode | undefined => {
    const decl = decls.get(name);
    if (!decl) {
      issues.push({ line: refLine ?? peek(c).line, message: `引用了未定义的容器 '${name}'` });
      return undefined;
    }
    if (chain.includes(name)) {
      issues.push({ line: decl.line, message: `容器引用成环:${[...chain, name].join(' → ')}` });
      return undefined;
    }
    used.add(name);
    for (const r of decl.refs) {
      const child = expand(r.name, [...chain, name], r.line);
      if (child) decl.node.children.push(child);
    }
    return decl.node;
  };

  let root: DesignNode | undefined;
  if (rootName) root = expand(rootName, []);
  for (const nm of order) {
    if (!used.has(nm)) issues.push({ line: decls.get(nm)!.line, message: `容器 '${nm}' 声明后未被引用(设计区不允许死代码)` });
  }

  return { ok: issues.length === 0 && !!root, issues, funcName, stateParam, root };
}
