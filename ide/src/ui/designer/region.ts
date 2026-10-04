// 铸造厂可视化 UI 设计器 —— 设计区定位与读写
// 铁律:任何写入只替换"标记区间"的行;区外内容(含行尾风格 CRLF/LF)逐字节保留。
import { MARK_BEGIN_RE, MARK_END_RE } from './spec';

/** 一段设计区的定位(0-based 行号,含首尾标记行) */
export interface RegionRef {
  name: string;
  startLine: number;
  endLine: number;
}

/** 找全部成对的设计区;未闭合的开始标记忽略(不完整区间不可安全改写) */
export function findRegions(text: string): RegionRef[] {
  const lines = text.split('\n');
  const out: RegionRef[] = [];
  let cur: { name: string; start: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    const mB = MARK_BEGIN_RE.exec(raw);
    const mE = MARK_END_RE.exec(raw);
    if (mB && !cur) cur = { name: mB[1], start: i };
    else if (mE && cur && mE[1] === cur.name) {
      out.push({ name: cur.name, startLine: cur.start, endLine: i });
      cur = undefined;
    }
  }
  return out;
}

/** 取某段设计区的原始文本(含标记行) */
export function regionText(text: string, ref: RegionRef): string {
  return text.split('\n').slice(ref.startLine, ref.endLine + 1).join('\n');
}

function toFileEol(content: string, crlf: boolean): string[] {
  const body = content.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  return body.map(l => (crlf ? l + '\r' : l));
}

/** 用新文本替换该段设计区;区外逐字节保留 */
export function replaceRegion(text: string, ref: RegionRef, newRegion: string): string {
  const lines = text.split('\n');
  const crlf = text.includes('\r\n');
  const newLines = toFileEol(newRegion, crlf);
  return [...lines.slice(0, ref.startLine), ...newLines, ...lines.slice(ref.endLine + 1)].join('\n');
}

/** 在文件末尾追加一段设计区(空行分隔);行尾随文件风格 */
export function appendRegion(text: string, newRegion: string): string {
  const crlf = text.includes('\r\n');
  const eol = crlf ? '\r\n' : '\n';
  let base = text;
  if (base.length > 0 && !base.endsWith('\n')) base += eol;
  if (base.length > 0) base += eol;
  return base + toFileEol(newRegion, crlf).join('\n') + eol;
}
