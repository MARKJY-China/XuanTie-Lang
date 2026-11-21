// 玄铁 API 文档书独立窗口入口。由主窗口 Rust open_docs_window 创建,
// 支持 ?target=method:取字节 / page:关键字/字节 深链,以及已开窗口的 docs-open 事件。
import { listen } from '@tauri-apps/api/event';
import '@vscode/codicons/dist/codicon.css';
import { DocsBook } from '../ui/docs-book';

const book = new DocsBook({ standalone: true });
book.open();

function applyTarget(target: string | null | undefined): void {
  if (!target) return;
  if (target.startsWith('method:')) book.openMethod(target.slice('method:'.length));
  else if (target.startsWith('page:')) book.openPage(target.slice('page:'.length));
}

const initial = new URLSearchParams(location.search).get('target');
if (initial) applyTarget(initial);

void listen<string>('docs-open', (ev) => applyTarget(ev.payload)).catch(() => undefined);
