// 问题面板:汇总各文件诊断,点击跳转;右键/双击可「添加到对话」
import type { DiagnosticDto } from '../types';
import { basename } from '../util';
import { showContextMenu, CONTEXT_SEP } from './dialogs';

interface ProblemRow {
  path: string;
  diag: DiagnosticDto;
}

export class ProblemsPanel {
  private data = new Map<string, DiagnosticDto[]>();

  constructor(
    private host: HTMLElement,
    private openAt: (path: string, line: number, column: number) => void,
    /** 「添加到对话」:把该问题项(错误/警告 + 消息 + 位置)交给 AI 输入栏 */
    private addToChat?: (text: string) => void,
  ) {}

  /** 问题行 → 引用文本(严重级 + 消息 + 完整位置) */
  private rowText(row: ProblemRow): string {
    const line = row.diag.range.start.line + 1;
    const col = row.diag.range.start.character + 1;
    const kind = row.diag.severity === 1 ? '错误' : '警告';
    return `${kind}: ${row.diag.message}\n位置: ${row.path}:${line}:${col}`;
  }

  update(path: string, diags: DiagnosticDto[]): void {
    if (diags.length === 0) this.data.delete(path);
    else this.data.set(path, diags);
    this.render();
  }

  clear(): void {
    this.data.clear();
    this.render();
  }

  count(): number {
    let n = 0;
    for (const diags of this.data.values()) n += diags.length;
    return n;
  }

  private render(): void {
    this.host.innerHTML = '';
    const rows: ProblemRow[] = [];
    for (const [path, diags] of this.data) {
      for (const diag of diags) rows.push({ path, diag });
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.id = 'problems-empty';
      empty.textContent = '没有问题。保存文件时 xt_lsp 会跑 xtc --检查 做语义级全查。';
      this.host.appendChild(empty);
      return;
    }
    rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.diag.range.start.line - b.diag.range.start.line));
    for (const row of rows) {
      const isErr = row.diag.severity === 1;
      const el = document.createElement('div');
      el.className = 'problem-row ' + (isErr ? 'err' : 'warn');
      const icon = document.createElement('span');
      icon.className = 'picon';
      const ico = document.createElement('i');
      ico.className = 'codicon ' + (isErr ? 'codicon-error' : 'codicon-warning');
      icon.appendChild(ico);
      const msg = document.createElement('span');
      msg.className = 'pmsg';
      msg.textContent = row.diag.message;
      const loc = document.createElement('span');
      loc.className = 'ploc';
      loc.textContent = `${basename(row.path)}:${row.diag.range.start.line + 1}:${row.diag.range.start.character + 1}`;
      el.append(icon, msg, loc);
      el.addEventListener('click', () => {
        this.openAt(row.path, row.diag.range.start.line + 1, row.diag.range.start.character + 1);
      });
      // 问题项不可文本选中:双击直接添加,右键出菜单(用户指定交互)
      el.addEventListener('dblclick', () => this.addToChat?.(this.rowText(row)));
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: '添加到对话', action: () => this.addToChat?.(this.rowText(row)) },
          CONTEXT_SEP,
          {
            label: '复制完整位置',
            action: () => void navigator.clipboard.writeText(`${row.path}:${row.diag.range.start.line + 1}:${row.diag.range.start.character + 1}`),
          },
        ]);
      });
      this.host.appendChild(el);
    }
  }
}
