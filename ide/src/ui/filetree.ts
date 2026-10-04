// 文件树:三态显示(眼睛按钮) + codicon/专属图标 + 右键(含空白区) + 多选(ctrl/shift/框选)
// 模式(由 main.ts 注入,持久化在设置里):
//   all  = 完全显示:所有文件原位、正常亮度
//   dim  = 半显示:IDE 认准类型(.xt/已知文本)原位;其余(二进制/未知文本)淡化并整组折叠到整个树末尾
//   hide = 不显示:只渲染认准类型
import type { FileNode, TreeDisplay } from '../types';
import { relativeTo } from '../util';
import xtIco from '../assets/xuantie.ico';

export interface TreeHooks {
  openFile(path: string): void;
  // node === null 表示右键在空白区域(对工程根操作)
  onContext(e: MouseEvent, node: FileNode | null): void;
}

// 已知文本扩展(专属图标或正常显示)
const KNOWN_EXT = new Set([
  'md', 'txt', 'toml', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'csv', 'ini', 'cfg', 'lock',
  'html', 'css', 'js', 'ts', 'rs', 'go', 'c', 'h', 'py', 'sh', 'bat', 'ps1',
]);
// 二进制/构建产物扩展
const BINARY_EXT = new Set([
  'exe', 'dll', 'pdb', 'o', 'obj', 'lib', 'a', 'so', 'dylib', 'bin', 'dat',
  'zip', '7z', 'gz', 'tar', 'rar', 'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'bmp', 'webp',
  'pdf', 'mp3', 'mp4', 'wav', 'ttf', 'otf', 'woff', 'woff2', 'eot', 'll',
]);

type FileClass = 'xt' | 'known' | 'binary' | 'unknown';

function extOf(name: string): string {
  // 点开头的仓库文件(.gitignore 等)按点后内容算扩展;普通文件取最后一个点
  if (name.startsWith('.')) return name.slice(1).toLowerCase();
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

function classify(node: FileNode): FileClass {
  if (node.isDir) return 'known';
  const ext = extOf(node.name);
  if (ext === 'xt') return 'xt';
  if (ext === '' || BINARY_EXT.has(ext)) return 'binary';
  if (KNOWN_EXT.has(ext)) return 'known';
  return 'unknown';
}

function isRecognized(node: FileNode, rootPath = ''): boolean {
  if (node.isDir) return true;
  // 编译产物目录(工程\build)整目录豁免:任何显示模式下都原位正常显示,不隐藏不折叠
  if (rootPath) {
    const rel = relativeTo(rootPath, node.path).toLowerCase();
    if (rel === 'build' || rel.startsWith('build\\') || rel.startsWith('build/')) return true;
  }
  const cls = classify(node);
  return cls === 'xt' || cls === 'known';
}

function iconFor(node: FileNode, cls: FileClass): HTMLElement {
  if (cls === 'xt') {
    const img = document.createElement('img');
    img.className = 'ico-img';
    img.src = xtIco;
    img.draggable = false;
    return img;
  }
  const i = document.createElement('i');
  i.className = 'codicon ' + iconClassFor(node, cls);
  return i;
}

function iconClassFor(node: FileNode, cls: FileClass): string {
  if (node.isDir) return 'codicon-folder';
  // 工程锚 玄铁.配置.toml:同 toml 齿轮但橙色着色,与普通 toml 区分
  if (node.name === '玄铁.配置.toml') return 'codicon-settings-gear proj-config';
  const ext = extOf(node.name);
  if (cls === 'binary') return 'codicon-file-binary';
  if (ext === 'md') return 'codicon-markdown';
  if (ext === 'json' || ext === 'jsonl' || ext === 'lock') return 'codicon-json';
  if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'yaml' || ext === 'yml') return 'codicon-settings-gear';
  if (ext === 'txt') return 'codicon-file-text';
  return 'codicon-file';
}

const OTHER_KEY = '::__other__root__';

export class FileTree {
  private display: TreeDisplay = 'dim';
  private expanded = new Set<string>();
  private roots: FileNode[] = [];
  private rootPath = '';
  // 多选:selected 为路径集,anchor 为 shift 连选锚点;rowEls/order 记录当前可见行(渲染时重建)
  private selected = new Set<string>();
  private anchor: string | null = null;
  private rowEls = new Map<string, HTMLElement>();
  private order: string[] = [];
  private meta = new Map<string, boolean>(); // path → isDir(跨渲染保留)

  constructor(
    private host: HTMLElement,
    private hooks: TreeHooks,
  ) {
    // 空白区域右键:对工程根新建/刷新
    host.addEventListener('contextmenu', (e) => {
      if ((e.target as HTMLElement | null)?.closest('.tree-row')) return;
      e.preventDefault();
      this.hooks.onContext(e, null);
    });
    this.setupBandDrag();
  }

  /** 框选(橡皮筋):空白处按下拖动,松开后按矩形覆盖率选中可见行。
   *  滚动条上的按下不触发(offsetX 越界判定)。 */
  private setupBandDrag(): void {
    this.host.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest('.tree-row')) return;
      if (e.target === this.host && (e.offsetX >= this.host.clientWidth || e.offsetY >= this.host.clientHeight))
        return;
      e.preventDefault(); // 抑制文本选择
      const startX = e.clientX;
      const startY = e.clientY;
      const band = document.createElement('div');
      band.className = 'tree-band';
      document.body.appendChild(band);
      let hovered = new Set<string>();
      const onMove = (ev: MouseEvent): void => {
        const x1 = Math.min(startX, ev.clientX);
        const y1 = Math.min(startY, ev.clientY);
        const x2 = Math.max(startX, ev.clientX);
        const y2 = Math.max(startY, ev.clientY);
        band.style.left = x1 + 'px';
        band.style.top = y1 + 'px';
        band.style.width = x2 - x1 + 'px';
        band.style.height = y2 - y1 + 'px';
        hovered = new Set<string>();
        for (const [path, el] of this.rowEls) {
          const r = el.getBoundingClientRect();
          const hit = r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1;
          el.classList.toggle('band', hit);
          if (hit) hovered.add(path);
        }
      };
      const onUp = (): void => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        band.remove();
        for (const el of this.rowEls.values()) el.classList.remove('band');
        if (hovered.size > 0) {
          this.selected = new Set(hovered);
          this.anchor = this.order.find((p) => this.selected.has(p)) ?? null;
          this.applySelection();
        }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  /** 当前多选项(右键菜单「添加到对话」用;按树内可见顺序)。 */
  selectedEntries(): { path: string; isDir: boolean }[] {
    return this.order
      .filter((p) => this.selected.has(p))
      .map((p) => ({ path: p, isDir: this.meta.get(p) === true }));
  }

  private applySelection(): void {
    for (const [path, el] of this.rowEls) el.classList.toggle('sel', this.selected.has(path));
  }

  private selectRange(from: string, to: string): void {
    const a = this.order.indexOf(from);
    const b = this.order.indexOf(to);
    if (a < 0 || b < 0) {
      this.selected = new Set([to]);
      this.anchor = to;
      this.applySelection();
      return;
    }
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    this.selected = new Set(this.order.slice(lo, hi + 1));
    this.applySelection();
  }

  setDisplay(d: TreeDisplay): void {
    this.display = d;
    this.render();
  }

  setTree(nodes: FileNode[], rootPath?: string): void {
    this.roots = nodes;
    if (rootPath !== undefined) this.rootPath = rootPath;
    this.render();
  }

  private render(): void {
    const top = this.host.scrollTop;
    this.host.innerHTML = '';
    this.rowEls.clear();
    this.order = [];
    for (const node of this.roots) {
      // 根层与目录子项同规则:非 all 模式下,非认准文件不原位渲染(dim 模式进树尾分组,hide 模式消失)
      if (!node.isDir && this.display !== 'all' && !isRecognized(node, this.rootPath)) continue;
      this.host.appendChild(this.buildNode(node, 0));
    }
    // 半显示:全树的非认准文件收进一个组,折叠到树末尾
    if (this.display === 'dim') {
      const others: FileNode[] = [];
      const collect = (nodes: FileNode[]): void => {
        for (const n of nodes) {
          if (!n.isDir && !isRecognized(n)) others.push(n);
          if (n.isDir) collect(n.children);
        }
      };
      collect(this.roots);
      if (others.length > 0) {
        this.host.appendChild(this.buildOtherGroup(others));
      }
    }
    this.host.scrollTop = top;
  }

  private buildNode(node: FileNode, depth: number): HTMLElement {
    const wrap = document.createElement('div');
    wrap.appendChild(this.buildRow(node, depth, false));
    if (node.isDir && this.expanded.has(node.path)) {
      for (const child of node.children) {
        // dim/hide 模式:非认准文件不原位渲染(all 模式原位正常显示)
        if (!child.isDir && this.display !== 'all' && !isRecognized(child, this.rootPath)) continue;
        wrap.appendChild(this.buildNode(child, depth + 1));
      }
    }
    return wrap;
  }

  private buildOtherGroup(items: FileNode[]): HTMLElement {
    const open = this.expanded.has(OTHER_KEY);
    const wrap = document.createElement('div');
    const row = document.createElement('div');
    row.className = 'tree-row tree-group';
    const twist = document.createElement('span');
    twist.className = 'twist';
    const chev = document.createElement('i');
    chev.className = 'codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right');
    twist.appendChild(chev);
    const icon = document.createElement('i');
    icon.className = 'codicon codicon-ellipsis';
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = `其他文件 (${items.length})`;
    row.append(twist, icon, name);
    row.addEventListener('click', () => {
      if (open) this.expanded.delete(OTHER_KEY);
      else this.expanded.add(OTHER_KEY);
      this.render();
    });
    wrap.appendChild(row);
    if (open) {
      for (const child of items) {
        wrap.appendChild(this.buildRow(child, 1, true, relativeTo(this.rootPath, child.path)));
      }
    }
    return wrap;
  }

  private buildRow(node: FileNode, depth: number, dim: boolean, labelOverride?: string): HTMLElement {
    const row = document.createElement('div');
    const cls = classify(node);
    row.className = 'tree-row' + (cls === 'xt' ? ' xt-file' : '') + (dim ? ' dim' : '');
    row.style.paddingLeft = 8 + depth * 14 + 'px';

    const twist = document.createElement('span');
    twist.className = 'twist';
    if (node.isDir) {
      const chev = document.createElement('i');
      chev.className = 'codicon ' + (this.expanded.has(node.path) ? 'codicon-chevron-down' : 'codicon-chevron-right');
      twist.appendChild(chev);
    }
    const icon = iconFor(node, cls);
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = labelOverride ?? node.name;
    name.title = node.path;
    row.append(twist, icon, name);

    // 多选登记:路径 → 行元素(框选/选中态刷新用)
    this.rowEls.set(node.path, row);
    this.order.push(node.path);
    this.meta.set(node.path, node.isDir);
    if (this.selected.has(node.path)) row.classList.add('sel');

    row.addEventListener('click', (e) => {
      if (e.shiftKey && this.anchor) {
        this.selectRange(this.anchor, node.path);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        if (this.selected.has(node.path)) this.selected.delete(node.path);
        else this.selected.add(node.path);
        this.anchor = node.path;
        this.applySelection();
        return;
      }
      this.selected = new Set([node.path]);
      this.anchor = node.path;
      if (node.isDir) {
        if (this.expanded.has(node.path)) this.expanded.delete(node.path);
        else this.expanded.add(node.path);
        this.render();
      } else {
        this.applySelection();
        this.hooks.openFile(node.path);
      }
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 右键落在未选中行上 → 先单选该行(标准文件管理器行为);已在选区内则保留多选
      if (!this.selected.has(node.path)) {
        this.selected = new Set([node.path]);
        this.anchor = node.path;
        this.applySelection();
      }
      this.hooks.onContext(e, node);
    });
    return row;
  }
}
