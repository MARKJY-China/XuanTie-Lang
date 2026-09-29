// 文件树:全量渲染 + 展开/折叠 + 右键菜单回调(行与子树分层,行内 flex 不受子树影响)
import type { FileNode } from '../types';

export interface TreeHooks {
  openFile(path: string): void;
  onContext(e: MouseEvent, node: FileNode): void;
}

export class FileTree {
  private expanded = new Set<string>();
  private roots: FileNode[] = [];

  constructor(
    private host: HTMLElement,
    private hooks: TreeHooks,
  ) {}

  setTree(nodes: FileNode[]): void {
    this.roots = nodes;
    this.render();
  }

  private render(): void {
    const top = this.host.scrollTop;
    this.host.innerHTML = '';
    for (const node of this.roots) {
      this.host.appendChild(this.buildNode(node, 0));
    }
    this.host.scrollTop = top;
  }

  private buildNode(node: FileNode, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(this.buildRow(node, depth));
    if (node.isDir && this.expanded.has(node.path)) {
      for (const child of node.children) {
        wrap.appendChild(this.buildNode(child, depth + 1));
      }
    }
    return wrap;
  }

  private buildRow(node: FileNode, depth: number): HTMLElement {
    const row = document.createElement('div');
    const isXt = !node.isDir && node.name.toLowerCase().endsWith('.xt');
    row.className = 'tree-row' + (isXt ? ' xt-file' : '');
    row.style.paddingLeft = 8 + depth * 14 + 'px';

    const twist = document.createElement('span');
    twist.className = 'twist';
    twist.textContent = node.isDir ? (this.expanded.has(node.path) ? '▾' : '▸') : '';
    const icon = document.createElement('span');
    icon.className = 'ficon';
    icon.textContent = node.isDir ? '🗂' : '📄';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = node.name;
    name.title = node.path;
    row.append(twist, icon, name);

    row.addEventListener('click', () => {
      if (node.isDir) {
        if (this.expanded.has(node.path)) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.render();
      } else {
        this.hooks.openFile(node.path);
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.hooks.onContext(e, node);
    });
    return row;
  }
}
