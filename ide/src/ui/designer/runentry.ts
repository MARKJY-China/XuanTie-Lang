// 设计器的渲染入口生成:设计区只产出 `函 界面(s) { … }`,
// 没有窗口初始化时程序不会渲染。这里补一段可直接运行的 UI.应用 主程序。
// 纯函数,便于单测;真正的文件写入与运行由 panel.ts / main.ts 负责。
import type { DesignNode, Val } from './parser';

/** 入口段首行标记:重复点「初始化渲染窗口」时据此判断已有入口 */
export const ENTRY_TOKEN = '铸造厂·渲染入口';
export const ENTRY_MARK =
  '// ===== 铸造厂·渲染入口(设计器生成;删掉本段即回到纯函数,程序不再渲染窗口)  =====';

/** 生成的状态容器变量名(避让用户变量名很少见,固定即可读) */
export const ENTRY_STATE_VAR = '界面状态';

export interface RenderEntryOpts {
  /** UI 库别名(文件里 `引 "UI" 予 X` 的 X;缺省 UI) */
  alias: string;
  /** 设计函数名(如 主界面) */
  funcName: string;
  /** 设计函数的状态参数名(通常是 s) */
  stateParam: string;
  /** 窗口标题(一般用设计区名) */
  title: string;
  width: number;
  height: number;
  /** 设计里 态取 用到的键(入口里先给 0 占位,用户可改) */
  stateKeys: string[];
}

/** 文件里已有 `引 "UI" 予 X` 时返回别名 X,否则 null */
export function uiAliasOf(text: string): string | null {
  const m = /^\s*引\s+"UI"\s+予\s+(\S+)/m.exec(text);
  return m ? m[1] : null;
}

/** 补 `引 "UI" 予 UI`(放文件最前;已有任何 UI 引入则原样返回) */
export function ensureUiImport(text: string): string {
  if (uiAliasOf(text)) return text;
  return '引 "UI" 予 UI\n\n' + text.replace(/^\uFEFF/, '');
}

/** 是否已有渲染入口(本设计器生成的,或用户自己的 应用/初始化窗口 循环) */
export function hasRenderEntry(text: string): boolean {
  return text.includes(ENTRY_TOKEN) || /UI\s*\.\s*应用\s*\(/.test(text) || /初始化窗口\s*\(/.test(text);
}

/** 收集设计里 态取(s, "键") 用到的键(去重,按出现序) */
export function collectStateKeys(root: DesignNode): string[] {
  const out = new Set<string>();
  const visitVal = (v: Val): void => {
    if (v.t === 'stateGet') out.add(v.key);
    else if (v.t === 'dict') for (const e of v.entries) visitVal(e.value);
  };
  const walk = (n: DesignNode): void => {
    for (const a of n.args) visitVal(a);
    for (const o of n.options) visitVal(o.value);
    for (const c of n.children) walk(c);
  };
  walk(root);
  return [...out];
}

function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** 生成入口段(以 \n 结尾;文件行尾由 appendEntry 适配) */
export function buildRenderEntry(o: RenderEntryOpts): string {
  const state =
    o.stateKeys.length > 0 ? '{' + o.stateKeys.map((k) => `"${esc(k)}": 0`).join(', ') + '}' : '{}';
  const width = Number.isFinite(o.width) && o.width > 0 ? Math.round(o.width) : 800;
  const height = Number.isFinite(o.height) && o.height > 0 ? Math.round(o.height) : 560;
  const opts = `{"宽": ${width}, "高": ${height}, "标题": "${esc(o.title)}"}`;
  return [
    ENTRY_MARK,
    `设 ${ENTRY_STATE_VAR} = ${o.alias}.造状态(${state})`,
    `${o.alias}.应用(${ENTRY_STATE_VAR}, 函(${o.stateParam}) { 返 ${o.funcName}(${o.stateParam}) }, ${opts})`,
    '',
  ].join('\n');
}

/** 追加入口段:文件尾留一个空行分隔;行尾风格随文件(CRLF/LF) */
export function appendEntry(text: string, entry: string): string {
  const crlf = text.includes('\r\n');
  const flat = text.replace(/\r\n/g, '\n').replace(/[ \t\r\n]+$/, '');
  const head = flat.length > 0 ? flat + '\n\n' : '';
  const out = head + entry.replace(/\r\n/g, '\n');
  return crlf ? out.replace(/\n/g, '\r\n') : out;
}
