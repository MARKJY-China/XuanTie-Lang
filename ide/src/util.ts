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

// 相对某根目录的路径(不带前导分隔符);非根下原样返回
export function relativeTo(root: string, p: string): string {
  const normRoot = root.endsWith('\\') || root.endsWith('/') ? root : root + '\\';
  if (p.startsWith(normRoot)) return p.slice(normRoot.length);
  const altRoot = normRoot.replace(/\\/g, '/');
  if (p.startsWith(altRoot)) return p.slice(altRoot.length);
  return p;
}

// 写剪贴板:优先 Clipboard API,失败回落隐藏 textarea + execCommand(WebView2 兜底)
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
