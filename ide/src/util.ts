// 路径小工具(Windows 反斜杠为主,兼容正斜杠)
export function basename(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i >= 0 ? p.slice(i + 1) : p;
}

export function dirname(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i > 0 ? p.slice(0, i) : p;
}

export function isXtFile(p: string): boolean {
  return p.toLowerCase().endsWith('.xt');
}
