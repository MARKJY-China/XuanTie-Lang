// 铸造厂 UI 设计器 —— 编辑器内嵌视图(Tab 栏右侧开关切换)
// 开启:编辑器区整体由代码编辑器切换为设计器(左画布 + 右检视);关闭:恢复代码编辑器。
// 切片 3(可编辑):拖拽移动 / 角柄缩放 / 吸附参考线 / 层级调整;写回一律走
// "改树 → 生成器重发整区 → region 替换 → 替换编辑器全文",每次落点 = 一步 Monaco 撤销
// (Ctrl+Z / Ctrl+Y 由 main.ts 转发到编辑器)。
// 只读边界:没有设计区、或解析未通过子集(parsed.ok=false)时,编辑入口全部关闭(平移视区不受限)。
import { parseDesignFunction, type DesignNode, type ParseResult, type Val } from './parser';
import { findRegions, regionText, replaceRegion, type RegionRef } from './region';
import { layoutTree, type Measure } from './layout';
import { paintDesign, type PaintResult } from './paint';
import { valText, generateDesignFunction } from './generator';
import { markBegin, markEnd } from './spec';
import { COLOR_PALETTE, TOOLBOX, specOf } from './props';
import {
  CONTEXT_SEP,
  showContextMenu,
  showCustomModal,
  type ContextMenuEntry,
} from '../dialogs';
import {
  applyMove,
  applyResize,
  cloneSubtree,
  defaultWidget,
  findParent,
  findPath,
  handleAxes,
  handleMovesNearEdge,
  insertNode,
  levelOp,
  lockedAxes,
  moveMode,
  nodeAtPath,
  numVal,
  removeNode,
  removeOpt,
  setInsets,
  setVal,
  snapMove,
  snapResize,
  MIN_SIZE,
  type Guide,
  type HandleCode,
  type LevelOp,
  type MoveMode,
  type Rect,
} from './edit';

export interface DesignerDeps {
  /** 取当前文件(path 供标题;text 为编辑器实时文本) */
  getActive(): { path: string; text: string } | null;
  /** 整文替换(单步可撤销):仅当编辑器当前文本 === oldText 时才执行;不一致返回 false(面板重读) */
  replaceAll(oldText: string, newText: string): boolean;
  /** 复制文本到剪贴板 */
  copy(text: string): Promise<boolean>;
}

/** 吸附阈值(画布像素)与拖拽启动阈值 */
const SNAP_THR = 6;
const DRAG_THR = 3;

/** 生成标记时用的默认界面名与空根(可直接编译运行) */
const NEW_REGION_NAME = '主界面';
function emptyRoot(): DesignNode {
  return {
    widget: '绝对', kind: 'container', varName: '根', args: [], children: [], line: 0, endLine: 0,
    options: [
      { key: '高', value: { t: 'num', raw: '560' } },
      { key: '宽', value: { t: 'num', raw: '800' } },
    ],
  };
}

/** 文本测量:离屏 2D 按真实字体量宽(与画布观感一致) */
const measure: Measure = (() => {
  const ctx = document.createElement('canvas').getContext('2d');
  return (text: string, fontSize: number) => {
    if (!ctx) return { w: text.length * fontSize * 0.6, h: Math.ceil(fontSize * 1.25) };
    ctx.font = `${fontSize}px "微软雅黑", "Microsoft YaHei", sans-serif`;
    return { w: Math.ceil(ctx.measureText(text).width), h: Math.ceil(fontSize * 1.25) };
  };
})();

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * 自绘下拉按钮:点开一个暗色菜单(复用 ctx-menu)。
 * 为什么不用原生 <select>:WebView2 的原生弹层不跟随 color-scheme,暗色主题下弹出亮块
 * (实测:设置里 :root color-scheme:dark 无效,弹层仍是白底灰字、无圆角)。
 */
function ddButton(label: string, items: () => ContextMenuEntry[], cls = ''): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ds-dd ' + cls;
  const t = document.createElement('span');
  t.className = 'ds-dd-text';
  t.textContent = label;
  const ic = document.createElement('i');
  ic.className = 'codicon codicon-chevron-down';
  b.append(t, ic);
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    const r = b.getBoundingClientRect();
    showContextMenu(r.left, r.bottom + 2, items());
  });
  return b;
}

/** 改下拉按钮的文字(状态变化后刷新标签) */
function ddLabel(b: HTMLButtonElement, label: string): void {
  const t = b.querySelector('.ds-dd-text');
  if (t) t.textContent = label;
}

/** 颜色值 → 预览色(画布同源的 12 色表;UI.色16/UI.色 由库解析,预览给出近似) */
const SWATCH: Record<string, string> = {
  白: '#ffffff', 黑: '#000000', 红: '#ff5050', 绿: '#50dc50', 蓝: '#5078ff', 黄: '#ffdc3c',
  灰: '#8c8c8c', 深灰: '#323232', 浅灰: '#dcdcdc', 透明: 'transparent', 主题: '#4682dc', 强调: '#ff8c28',
};

function colorPreview(v: Val | undefined): string | undefined {
  if (!v) return undefined;
  if (v.t === 'colorConst') return SWATCH[v.key];
  if (v.t === 'hex16') return /^#[0-9a-fA-F]{6}$/.test(v.v) ? v.v : undefined;
  if (v.t === 'rgba') {
    const [r, g, b] = v.channels.map((c) => Math.max(0, Math.min(255, Number(c))));
    return `rgb(${r},${g},${b})`;
  }
  return undefined;
}

interface DragState {
  kind: 'move' | 'resize';
  node: DesignNode;
  parent: DesignNode | null;
  mode: MoveMode;
  locked: { x: boolean; y: boolean };
  handle?: HandleCode;
  elm: HTMLElement;
  /** 元素原始局部位置(paint 写入的 left/top,相对父元素):预览与还原的基准 */
  lx: number;
  ly: number;
  box: Rect;
  sx: number;
  sy: number;
  dx: number;
  dy: number;
  moved: boolean;
}

export class DesignerPanel {
  private sub: HTMLElement;
  private picker: HTMLButtonElement;
  private badge: HTMLElement;
  private canvasHost: HTMLElement;
  private split: HTMLElement;
  private insp: HTMLElement;
  private issuesEl: HTMLElement;

  private regions: RegionRef[] = [];
  private regionIdx = 0;
  private fileText = '';
  private filePath = '';
  private parsed: ParseResult | null = null;
  private painted: PaintResult | null = null;
  private selected: DesignNode | null = null;
  /** 选中项在树中的下标路径(重解析后按路径还原;换文件清空) */
  private selPath: number[] | null = null;
  private open_ = false;
  private pan = { on: false, id: -1, x: 0, y: 0, moved: false };
  private justDragged = false;
  private splitDrag = { on: false, x: 0, w: 300 };
  private drag: DragState | null = null;
  private guides: HTMLElement[] = [];
  private hintTimer: number | undefined;

  constructor(host: HTMLElement, private deps: DesignerDeps) {
    // 工具条:标题 + 文件/区 + 操作提示 + 状态徽标 + 刷新
    const bar = el('div', 'ds-toolbar');
    bar.appendChild(el('span', 'ds-title', '界面设计器'));
    this.sub = el('span', 'ds-sub', '');
    this.picker = ddButton('', () =>
      this.regions.map((r, i) => ({
        label: r.name,
        checked: i === this.regionIdx,
        action: () => {
          this.regionIdx = i;
          this.selected = null;
          this.selPath = null;
          this.reparse();
        },
      })),
    );
    this.picker.className = 'ds-dd ds-picker';
    this.picker.title = '切换设计区';
    this.badge = el('span', 'ds-badge', '');
    const refresh = document.createElement('button');
    refresh.className = 'ds-btn';
    refresh.title = '重新读取当前文件';
    refresh.innerHTML = '<i class="codicon codicon-refresh"></i>';
    refresh.addEventListener('click', () => this.open());
    bar.append(this.sub, this.picker, el('span', 'ds-tip', '拖动移动 · 角柄缩放 · 吸附对齐 · Ctrl+Z 撤销'), this.badge, refresh);

    // 主体:画布 + 宽度可拖的分隔条 + 检视
    const body = el('div', 'ds-body');
    this.canvasHost = el('div', 'ds-canvas');
    this.split = el('div', 'ds-split');
    this.split.title = '拖动调整属性面板宽度';
    this.insp = el('div', 'ds-insp');
    body.append(this.canvasHost, this.split, this.insp);

    this.issuesEl = el('div', 'ds-issues');
    host.append(bar, body, this.issuesEl);

    // 画布:左键落点分流(手柄→缩放 / 控件→移动 / 其余→平移视区);中键与右键恒为平移
    this.canvasHost.addEventListener('pointerdown', (e) => this.canvasDown(e));
    this.canvasHost.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault(); // 中键:禁掉浏览器自动滚动模式
    });
    this.canvasHost.addEventListener(
      'click',
      (e) => {
        if (this.justDragged) {
          e.stopPropagation(); // 拖拽收尾的 click 不穿透到节点选择
          e.preventDefault();
        }
      },
      true,
    );

    // 分隔条:拖动改属性面板宽(仅本次会话)
    this.split.addEventListener('pointerdown', (e) => this.splitDown(e));

    // 画布右键菜单:命中控件即选中并弹出层级/复制/删除(全局已禁原生右键菜单,见 main.ts)
    this.canvasHost.addEventListener('contextmenu', (e) => {
      if (!this.painted) return;
      const t = e.target as HTMLElement;
      const nEl = t.closest('[data-ix]') as HTMLElement | null;
      if (!nEl) return;
      e.preventDefault();
      const n = this.painted.nodes[Number(nEl.dataset.ix)];
      if (!n) return;
      this.pick(n);
      if (!this.parsed?.ok) {
        this.hint('本区含非子集内容,只读(不能增删改)');
        return;
      }
      this.showNodeMenu(e.clientX, e.clientY, n);
    });
  }

  /** 控件右键菜单:层级四连 + 复制/删除(与属性面板的工具箱同源) */
  private showNodeMenu(x: number, y: number, node: DesignNode): void {
    const root = this.parsed?.root;
    const parent = root ? findParent(root, node) : null;
    const items: ContextMenuEntry[] = [
      { label: `${node.widget}${node.varName ? ' · ' + node.varName : ''}`, header: true },
      { label: '上移一层', action: () => this.doLevel('up') },
      { label: '下移一层', action: () => this.doLevel('down') },
      { label: '置顶', action: () => this.doLevel('top') },
      { label: '置底', action: () => this.doLevel('bottom') },
      CONTEXT_SEP,
      { label: '复制', action: () => this.duplicateSelected() },
      { label: '删除', danger: true, action: () => this.deleteSelected() },
    ];
    if (!parent) {
      // 根:层级/删除都不适用,给个明白话(徽标),菜单仍展示但点了会被拦
      this.hint('根容器:层级/删除不适用,可在属性面板改 宽/高');
    }
    showContextMenu(x, y, items);
  }

  // ---------------------------------------------------------------- 打开/关闭

  /** 打开(或重读)当前文件;由开关、刷新按钮、切页、模型变更时调用 */
  open(): void {
    this.open_ = true;
    const cur = this.deps.getActive();
    if (!cur) {
      this.filePath = '';
      this.regions = [];
      this.selPath = null;
      this.renderEmpty('没有打开的文件', false);
      return;
    }
    if (cur.path !== this.filePath) this.selPath = null; // 换页:选中不跨文件
    this.filePath = cur.path;
    this.fileText = cur.text;
    this.regions = findRegions(this.fileText);
    if (this.regions.length === 0) {
      this.selPath = null;
      this.renderEmpty(
        '当前文件没有设计区。点下方按钮在文件末尾生成一段可直接运行的空界面标记,\n或手动加入:\n' + markBegin(NEW_REGION_NAME),
        true,
      );
      return;
    }
    this.regionIdx = Math.min(this.regionIdx, this.regions.length - 1);
    this.reparse();
  }

  close(): void {
    this.open_ = false;
    this.endDrag(false);
  }

  /** 切页/外部改动后,若视图开着则重读(拖拽进行中不重读,避免打断预览) */
  refreshIfOpen(): void {
    if (this.open_ && !this.drag) this.open();
  }

  // ---------------------------------------------------------------- 渲染

  private reparse(): void {
    const ref = this.regions[this.regionIdx];
    const text = regionText(this.fileText, ref);
    this.parsed = parseDesignFunction(text);
    const root = this.parsed.root;
    this.selected = this.selPath && root ? nodeAtPath(root, this.selPath) : null;
    this.renderHead();
    this.renderIssues();
    this.renderCanvas();
    this.renderInspector();
  }

  private renderEmpty(msg: string, withActions: boolean): void {
    this.parsed = null;
    this.painted = null;
    this.selected = null;
    this.sub.textContent = this.filePath.split(/[\\/]/).pop() ?? '';
    this.picker.style.display = 'none';
    this.badge.textContent = '';
    this.badge.className = 'ds-badge';
    this.canvasHost.innerHTML = '';
    const d = el('div', 'ds-empty', msg);
    if (withActions) {
      const btns = el('div', 'ds-empty-btns');
      const b1 = el('button', 'mbtn primary', '在代码最后一行生成标记');
      b1.addEventListener('click', () => this.insertSkeleton());
      const b2 = el('button', 'mbtn', '复制标记');
      b2.addEventListener('click', () => void this.copyMarkers());
      btns.append(b1, b2);
      d.appendChild(btns);
    }
    this.canvasHost.appendChild(d);
    this.insp.innerHTML = '';
    this.issuesEl.textContent = '';
  }

  /** 在文件末尾追加一段"标记 + 空界面"骨架(需要时补 引 "UI"),留在未保存缓冲 */
  private insertSkeleton(): void {
    const region = generateDesignFunction(NEW_REGION_NAME, 's', emptyRoot());
    const needImport = !/^\s*引\s+"UI"/m.test(this.fileText);
    let insert = '';
    if (this.fileText.length > 0) insert += this.fileText.endsWith('\n') ? '\n' : '\n\n';
    if (needImport) insert += '引 "UI" 予 UI\n\n';
    insert += region;
    if (this.deps.replaceAll(this.fileText, this.fileText + insert)) this.open();
    else this.hint('生成失败:编辑器内容已变化,请重试', 'warn');
  }

  private async copyMarkers(): Promise<void> {
    const text = markBegin(NEW_REGION_NAME) + '\n' + markEnd(NEW_REGION_NAME) + '\n';
    const ok = await this.deps.copy(text);
    this.hint(ok ? '标记已复制' : '复制失败', ok ? 'ok' : 'warn');
  }

  private renderHead(): void {
    this.sub.textContent = (this.filePath.split(/[\\/]/).pop() ?? '') + (this.regions.length > 1 ? `(${this.regions.length} 个区)` : '');
    this.picker.style.display = this.regions.length > 1 ? '' : 'none';
    ddLabel(this.picker, this.regions[this.regionIdx]?.name ?? '设计区');
    const ok = this.parsed?.ok === true;
    this.badge.textContent = ok ? '符合子集 · 可编辑' : '子集外 · 只读';
    this.badge.className = 'ds-badge ' + (ok ? 'ok' : 'warn');
  }

  private renderIssues(): void {
    this.issuesEl.innerHTML = '';
    const issues = this.parsed?.issues ?? [];
    if (issues.length === 0) return;
    this.issuesEl.appendChild(el('div', 'ds-issues-head', `本区含 ${issues.length} 处非子集内容 → 只读(设计器不会改写):`));
    for (const it of issues.slice(0, 8)) {
      this.issuesEl.appendChild(el('div', 'ds-issue', `第 ${it.line} 行:${it.message}`));
    }
    if (issues.length > 8) this.issuesEl.appendChild(el('div', 'ds-issue', `…另有 ${issues.length - 8} 处`));
  }

  private renderCanvas(): void {
    // 重绘会清空画布 DOM(浏览器随之把滚动位置归零):先存后还原,平移/检视后的重绘不跳回原点
    const sl = this.canvasHost.scrollLeft;
    const st = this.canvasHost.scrollTop;
    this.canvasHost.innerHTML = '';
    this.painted = null;
    const root = this.parsed?.root;
    if (!root) {
      this.canvasHost.appendChild(el('div', 'ds-empty', '本区没有可解析的控件树(见下方原因)'));
      return;
    }
    const laid = layoutTree(root, measure);
    this.painted = paintDesign(this.canvasHost, laid, this.selected, (n) => this.pick(n));
    if (laid.notes.length > 0) {
      this.canvasHost.appendChild(el('div', 'ds-note', laid.notes.join(';')));
    }
    this.canvasHost.scrollLeft = sl;
    this.canvasHost.scrollTop = st;
  }

  private pick(node: DesignNode): void {
    this.selected = node;
    const root = this.parsed?.root;
    this.selPath = root ? findPath(root, node) : null;
    this.renderCanvas();
    this.renderInspector();
  }

  private renderInspector(): void {
    this.insp.innerHTML = '';
    const n = this.selected;
    const root = this.parsed?.root;
    if (!n) {
      this.insp.appendChild(el('div', 'ds-insp-hint', '点击画布中的控件查看/编辑属性;拖动可移动,角柄可缩放'));
      return;
    }
    const 段 = (t: string): void => {
      this.insp.appendChild(el('div', 'ds-sec', t));
    };
    const 行 = (label: string, val: string): void => {
      const r = el('div', 'ds-row');
      r.append(el('span', 'ds-k', label), el('span', 'ds-v', val));
      this.insp.appendChild(r);
    };
    const editable = this.parsed?.ok === true;

    段('控件');
    行('类型', n.kind === 'container' ? `容器 · ${n.widget}` : `控件 · ${n.widget}`);
    if (n.varName) 行('变量名', n.varName);
    else if (n.widget !== '空白' && n.widget !== '弹性') 行('变量名', '(内联叶子)');
    行('源码行', String(n.line));
    if (n.args.length > 0) {
      段('实参');
      n.args.forEach((a, i) => {
        if (editable && (a.t === 'str' || a.t === 'num')) this.propTextRow(`#${i + 1}`, a);
        else 行(`#${i + 1}`, valText(a));
      });
    }

    if (n.options.length > 0 || editable) {
      段('选项(' + n.options.length + ')' + (editable ? '' : ' · 只读'));
    }
    for (const o of [...n.options]) {
      if (editable) this.propRow(o.key, o.value);
      else {
        const r = el('div', 'ds-row');
        r.append(el('span', 'ds-k', o.key), el('span', 'ds-v', valText(o.value)));
        this.insp.appendChild(r);
      }
    }

    if (editable && root) {
      this.toolbox(n);
      const parent = findParent(root, n);
      const mode = moveMode(n, parent);
      const locked = lockedAxes(n, parent);
      const tags: string[] = [];
      tags.push(mode === 'none' ? '根容器:在属性面板改 宽/高' : mode === 'xy' ? '拖动写 x/y' : '拖动写 平移x/y(不改兄弟排布)');
      if (locked.x || locked.y) tags.push('锁定轴:' + [locked.x ? '水平' : '', locked.y ? '垂直' : ''].filter(Boolean).join('/'));
      段('编辑');
      this.insp.appendChild(el('div', 'ds-k', tags.join(' · ')));
      if (parent) {
        const idx = parent.children.indexOf(n);
        行('层级', `第 ${idx + 1} / ${parent.children.length} 项`);
        const row = el('div', 'ds-actions');
        const mk = (label: string, tip: string, op: LevelOp): void => {
          const b = el('button', 'ds-btn ds-act', label);
          b.title = tip;
          b.addEventListener('click', () => this.doLevel(op));
          row.appendChild(b);
        };
        mk('上移一层', '数组序前移(行/列 中即更靠左/上)', 'up');
        mk('下移一层', '数组序后移(行/列 中即更靠右/下)', 'down');
        mk('置顶', '移到数组末尾(叠/绝对 中为最上层)', 'top');
        mk('置底', '移到数组开头(叠/绝对 中为最下层)', 'bottom');
        this.insp.appendChild(row);
      }
    }
  }

  // ---------------------------------------------------------------- 属性行(可编辑)

  /** 通用提交:改树 → 写回;okMsg 出现在徽标上 */
  private editTree(mutate: (root: DesignNode, node: DesignNode) => boolean, okMsg: string): void {
    const root = this.parsed?.root;
    const n = this.selected;
    if (!root || !n || !this.parsed?.ok) return;
    if (!mutate(root, n)) {
      this.hint('没有产生改动');
      return;
    }
    this.selPath = findPath(root, n);
    if (this.writeBack()) this.hint(okMsg, 'ok');
    else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  private propRow(key: string, cur: Val): void {
    const spec = specOf(key);
    const row = el('div', 'ds-prow');
    row.appendChild(el('span', 'ds-k', key));
    const box = el('span', 'ds-pctl');
    row.appendChild(box);
    if (spec.hint) row.title = spec.hint;

    if (spec.kind === 'num') {
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'ds-in ds-num';
      if (spec.min !== undefined) inp.min = String(spec.min);
      if (spec.max !== undefined) inp.max = String(spec.max);
      inp.value = cur.t === 'num' ? cur.raw : '';
      inp.placeholder = cur.t === 'num' ? '' : valText(cur);
      inp.addEventListener('change', () => {
        const v = inp.value.trim();
        if (v === '') {
          this.editTree((_r, n2) => removeOpt(n2, key), `${key} 已清除`);
          return;
        }
        if (!Number.isFinite(Number(v))) {
          this.hint('请输入数字');
          return;
        }
        const num = Number(v);
        this.editTree((_r, n2) => {
          setVal(n2, key, numVal(num));
          return true;
        }, `${key} 已改`);
      });
      box.appendChild(inp);
    } else if (spec.kind === 'color') {
      // 颜色 = 12 色板(UI.色彩["键"]) 或自定义 hex(UI.色16("#…"));两种都是子集内的常量写法
      const isSet = cur.t === 'colorConst' || cur.t === 'hex16' || cur.t === 'rgba';
      const curName = cur.t === 'colorConst' ? cur.key : cur.t === 'hex16' ? cur.v : cur.t === 'rgba' ? `rgb(${cur.channels.slice(0, 3).join(',')})` : '(无)';
      const btn = ddButton(curName, () => {
        const items: ContextMenuEntry[] = [
          {
            label: '(无)',
            checked: !isSet,
            action: () => this.editTree((_r, n2) => removeOpt(n2, key), `${key} 已清除`),
          },
          CONTEXT_SEP,
          { label: '调色板', header: true },
          ...COLOR_PALETTE.map((c) => ({
            label: c,
            checked: cur.t === 'colorConst' && cur.key === c,
            action: () =>
              this.editTree((_r, n2) => {
                setVal(n2, key, { t: 'colorConst', key: c });
                return true;
              }, `${key} 已改`),
          })),
          CONTEXT_SEP,
          { label: '自定义颜色…(hex)', action: () => void this.pickHex(key, cur) },
        ];
        return items;
      });
      const sw = colorPreview(cur);
      if (sw) {
        const dot = el('span', 'ds-swatch');
        dot.style.background = sw;
        btn.prepend(dot);
      }
      box.appendChild(btn);
    } else if (spec.kind === 'enum') {
      // 归一:字面量与库常量等价(库中 对齐中 = "中"),统一按常量形态显示
      const curText = cur.t === 'libConst' ? cur.name : cur.t === 'str' ? JSON.stringify(cur.v) : '';
      const alias: Record<string, string> = {
        '"始"': 'UI.对齐始', '"中"': 'UI.对齐中', '"末"': 'UI.对齐末', '"间"': 'UI.对齐间', '"均"': 'UI.对齐均', '"均等"': 'UI.对齐均等',
        '"叉始"': 'UI.叉始', '"叉中"': 'UI.叉中', '"叉末"': 'UI.叉末', '"叉撑"': 'UI.叉撑',
      };
      const curNorm = alias[curText] ?? curText;
      const show = (v: string): string => (v.startsWith('UI.') ? v.slice(3) : v);
      const btn = ddButton(curNorm === '' ? '(默认)' : show(curNorm), () => {
        const items: ContextMenuEntry[] = [
          {
            label: '(默认/清除)',
            checked: curNorm === '',
            action: () => this.editTree((_r, n2) => removeOpt(n2, key), `${key} 已清除`),
          },
          CONTEXT_SEP,
          ...(spec.enums ?? []).map((en) => ({
            label: show(en),
            checked: curNorm === en,
            action: () =>
              this.editTree((_r, n2) => {
                if (en.startsWith('UI.')) setVal(n2, key, { t: 'libConst', name: en });
                else setVal(n2, key, { t: 'str', raw: en, v: JSON.parse(en) as string });
                return true;
              }, `${key} 已改`),
          })),
        ];
        return items;
      });
      box.appendChild(btn);
    } else if (spec.kind === 'bool') {
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ds-chk';
      cb.checked = cur.t === 'bool' ? cur.v : false;
      cb.addEventListener('change', () => {
        this.editTree((_r, n2) => { setVal(n2, key, { t: 'bool', v: cb.checked }); return true; }, `${key} 已改`);
      });
      box.appendChild(cb);
      box.appendChild(el('span', 'ds-hex', cur.t === 'bool' ? (cur.v ? '真' : '假') : valText(cur)));
    } else if (spec.kind === 'insets') {
      const edges = cur.t === 'dict' ? cur.entries : [];
      const plain = cur.t === 'num' ? cur.raw : undefined;
      const get = (e: string): string => {
        const v = edges.find((x) => x.key === e)?.value;
        return v && v.t === 'num' ? v.raw : '';
      };
      const inputs: Array<[string, HTMLInputElement]> = [];
      for (const e of ['左', '上', '右', '下'] as const) {
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'ds-in ds-edge';
        inp.placeholder = e;
        inp.title = e;
        if (plain !== undefined && edges.length === 0) inp.value = e === '左' ? plain : '';
        else inp.value = get(e);
        if (spec.min !== undefined) inp.min = String(spec.min);
        if (spec.max !== undefined) inp.max = String(spec.max);
        inputs.push([e, inp]);
        box.appendChild(inp);
      }
      const commit = (): void => {
        const vals: Partial<Record<'左' | '上' | '右' | '下', number | undefined>> = {};
        for (const [e, inp] of inputs) {
          const v = inp.value.trim();
          vals[e as '左' | '上' | '右' | '下'] = v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v);
        }
        this.editTree((_r, n2) => setInsets(n2, key, vals), `${key} 已改`);
      };
      for (const [, inp] of inputs) inp.addEventListener('change', commit);
      box.appendChild(el('span', 'ds-edge-tag', '左/上/右/下'));
    } else {
      // 只读键:给值 + 提示
      box.appendChild(el('span', 'ds-v', valText(cur)));
      if (spec.hint) box.appendChild(el('span', 'ds-ro', '只读'));
    }
    this.insp.appendChild(row);
  }

  /** 实参里的字符串/数字:就地编辑(容器名引用、状态引用等不给改) */
  private propTextRow(label: string, cur: Val): void {
    const node = this.selected;
    if (!node) return;
    const idx = Number(label.slice(1)) - 1;
    const row = el('div', 'ds-prow');
    row.appendChild(el('span', 'ds-k', label));
    const box = el('span', 'ds-pctl');
    const inp = document.createElement('input');
    inp.className = 'ds-in ds-text';
    inp.type = 'text';
    inp.value = cur.t === 'str' ? cur.v : cur.t === 'num' ? cur.raw : '';
    inp.addEventListener('change', () => {
      const v = inp.value;
      this.editTree((_r, n2) => {
        const a = n2.args[idx];
        if (!a) return false;
        if (a.t === 'str') {
          n2.args[idx] = { t: 'str', raw: JSON.stringify(v), v };
          return true;
        }
        if (a.t === 'num') {
          if (!Number.isFinite(Number(v))) return false;
          n2.args[idx] = numVal(Number(v));
          return true;
        }
        return false;
      }, `${label} 已改`);
    });
    box.appendChild(inp);
    row.appendChild(box);
    this.insp.appendChild(row);
  }

  /** 自定义颜色输入(走 IDE 自己的弹窗,不用 window.prompt —— WebView2 内不可靠) */
  private async pickHex(key: string, cur: Val): Promise<void> {
    const initial = cur.t === 'hex16' ? cur.v : '#3B82F6';
    const res = await showCustomModal(
      '自定义颜色',
      (body, close) => {
        const inp = document.createElement('input');
        inp.className = 'ds-in ds-text';
        inp.value = initial;
        inp.placeholder = '#RRGGBB';
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') close(inp.value.trim());
        });
        const foot = el('div', 'm-foot');
        const cancel = el('button', 'mbtn', '取消');
        cancel.addEventListener('click', () => close(undefined));
        const ok = el('button', 'mbtn primary', '确定');
        ok.addEventListener('click', () => close(inp.value.trim()));
        foot.append(cancel, ok);
        body.append(inp, foot);
        window.setTimeout(() => inp.focus(), 0);
      },
      '支持 #RGB / #RRGGBB / #RRGGBBAA;写回为 UI.色16("…")',
    );
    if (typeof res !== 'string' || res === '') return;
    if (!/^#[0-9a-fA-F]{3,8}$/.test(res)) {
      this.hint('颜色格式应为 #RRGGBB');
      return;
    }
    this.editTree((_r, n2) => {
      setVal(n2, key, { t: 'hex16', v: res });
      return true;
    }, `${key} 已改`);
  }

  // ---------------------------------------------------------------- 工具箱

  private toolbox(node: DesignNode): void {
    this.insp.appendChild(el('div', 'ds-sec', '工具箱'));
    const row = el('div', 'ds-actions');
    const sel = ddButton('选择控件…', () =>
      TOOLBOX.flatMap((g, gi) => [
        ...(gi > 0 ? [CONTEXT_SEP as ContextMenuEntry] : []),
        { label: g.group, header: true } as ContextMenuEntry,
        ...g.widgets.map((w) => ({ label: w, action: () => this.addWidget(w) }) as ContextMenuEntry),
      ]),
    );
    sel.title = '把新控件加进选中的容器(或选中控件的父容器)';
    row.appendChild(sel);
    const bCopy = el('button', 'ds-btn ds-act', '复制');
    bCopy.title = '深拷贝选中控件(容器会拿到新变量名),插在其后';
    bCopy.addEventListener('click', () => this.duplicateSelected());
    const bDel = el('button', 'ds-btn ds-act', '删除');
    bDel.title = '从父容器中删除选中控件(可 Ctrl+Z 撤销)';
    bDel.addEventListener('click', () => this.deleteSelected());
    row.append(bCopy, bDel);
    this.insp.appendChild(row);
    const hint = el(
      'div',
      'ds-k',
      node.kind === 'container' ? '添加目标:选中的容器(追加为其子项)' : '添加目标:选中控件的父容器(插在其后)',
    );
    this.insp.appendChild(hint);
  }

  private addWidget(widget: string): void {
    const root = this.parsed?.root;
    const n = this.selected;
    if (!root || !n || !this.parsed?.ok) {
      this.hint('先选中一个控件或容器');
      return;
    }
    const fresh = defaultWidget(widget, this.parsed.stateParam ?? 's');
    const pos: 'child' | 'after' = n.kind === 'container' ? 'child' : 'after';
    if (!insertNode(root, n, fresh, pos)) {
      this.hint('添加失败:该位置不可插入');
      return;
    }
    this.selected = fresh;
    this.selPath = findPath(root, fresh);
    if (this.writeBack()) this.hint(`已添加 ${widget}`, 'ok');
    else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  private duplicateSelected(): void {
    const root = this.parsed?.root;
    const n = this.selected;
    if (!root || !n || !this.parsed?.ok) return;
    const copy = cloneSubtree(n);
    if (!insertNode(root, n, copy, 'after')) {
      this.hint('根容器不能复制');
      return;
    }
    this.selected = copy;
    this.selPath = findPath(root, copy);
    if (this.writeBack()) this.hint('已复制', 'ok');
    else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  private deleteSelected(): void {
    const root = this.parsed?.root;
    const n = this.selected;
    if (!root || !n || !this.parsed?.ok) return;
    const parent = findParent(root, n);
    if (!parent) {
      this.hint('根容器不能删除');
      return;
    }
    if (!removeNode(root, n)) {
      this.hint('删除失败');
      return;
    }
    this.selected = parent;
    this.selPath = findPath(root, parent);
    if (this.writeBack()) this.hint('已删除(可 Ctrl+Z 撤销)', 'ok');
    else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  /** 状态徽标短暂提示(2.6s 后回到标准文案) */
  private hint(msg: string, kind: 'ok' | 'warn' = 'warn'): void {
    this.badge.textContent = msg;
    this.badge.className = 'ds-badge ' + kind;
    if (this.hintTimer !== undefined) window.clearTimeout(this.hintTimer);
    this.hintTimer = window.setTimeout(() => {
      this.hintTimer = undefined;
      this.renderHead();
    }, 2600);
  }

  // ---------------------------------------------------------------- 写回

  /** 把当前树重发整区并替换编辑器全文;返回是否写入成功 */
  private writeBack(): boolean {
    const root = this.parsed?.root;
    const ref = this.regions[this.regionIdx];
    if (!root || !ref || !this.parsed?.funcName) return false;
    const region = generateDesignFunction(this.parsed.funcName, this.parsed.stateParam ?? 's', root);
    const next = replaceRegion(this.fileText, ref, region);
    if (next === this.fileText) return false;
    if (!this.deps.replaceAll(this.fileText, next)) return false;
    this.fileText = next;
    return true;
  }

  /** 层级操作:改树 → 写回;失败或越界都不静默 —— 徽标给话 */
  private doLevel(op: LevelOp): void {
    const root = this.parsed?.root;
    const n = this.selected;
    if (!root || !n || !this.parsed?.ok) return;
    if (!levelOp(root, n, op)) {
      this.hint('已在边界,未移动');
      return;
    }
    this.selPath = findPath(root, n);
    if (this.writeBack()) this.hint('层级已调整', 'ok');
    else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  // ---------------------------------------------------------------- 画布编辑交互

  private canvasDown(e: PointerEvent): void {
    if (e.button === 0 && this.painted) {
      const t = e.target as HTMLElement;
      const hEl = t.closest('[data-h]') as HTMLElement | null;
      const nEl = t.closest('[data-ix]') as HTMLElement | null;
      if (!this.parsed?.ok) {
        if (nEl) this.hint('本区含非子集内容,只读(可拖动平移视区)');
      } else if (hEl && this.selected) {
        if (this.beginResize(hEl.dataset.h as HandleCode, this.selected, e)) return;
      } else if (nEl) {
        const n = this.painted.nodes[Number(nEl.dataset.ix)];
        if (n && this.beginMove(n, e)) return;
      }
    }
    this.panDown(e); // 空画布 / 中键 / 右键 / 不可动控件 → 平移视区
  }

  private beginMove(node: DesignNode, e: PointerEvent): boolean {
    const root = this.parsed?.root;
    if (!root || !this.painted) return false;
    const parent = findParent(root, node);
    const mode = moveMode(node, parent);
    if (mode === 'none') {
      this.hint('根容器:移动请拖其子项,整体尺寸在属性面板改 宽/高');
      return false;
    }
    const box = this.painted.boxes.get(node);
    if (!box) return false;
    const i = this.painted.nodes.indexOf(node);
    const elm = this.painted.els[i];
    if (!elm) return false;
    this.drag = {
      kind: 'move', node, parent, mode, locked: lockedAxes(node, parent), elm,
      lx: parseFloat(elm.style.left) || 0,
      ly: parseFloat(elm.style.top) || 0,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false,
    };
    this.selected = node;
    this.selPath = findPath(root, node); // 拖完重绘时高亮跟随
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragUp);
    window.addEventListener('pointercancel', this.onDragUp);
    return true;
  }

  private beginResize(handle: HandleCode, node: DesignNode, e: PointerEvent): boolean {
    const root = this.parsed?.root;
    if (!root || !this.painted) return false;
    const parent = findParent(root, node);
    const mode = moveMode(node, parent);
    const locked = lockedAxes(node, parent);
    const axes = handleAxes(handle);
    if (!((axes.x && !locked.x) || (axes.y && !locked.y))) {
      this.hint('该轴尺寸由 锚(双挂)或弹性份额决定,不能手调');
      return false;
    }
    if (handleMovesNearEdge(handle) && mode === 'none') {
      this.hint('根容器:改用 右下/下/右 手柄,或先在属性面板改 宽/高');
      return false;
    }
    const box = this.painted.boxes.get(node);
    if (!box) return false;
    const i = this.painted.nodes.indexOf(node);
    const elm = this.painted.els[i];
    if (!elm) return false;
    this.drag = {
      kind: 'resize', node, parent, mode, locked, handle, elm,
      lx: parseFloat(elm.style.left) || 0,
      ly: parseFloat(elm.style.top) || 0,
      box: { x: box.x, y: box.y, w: box.w, h: box.h },
      sx: e.clientX, sy: e.clientY, dx: 0, dy: 0, moved: false,
    };
    this.selected = node;
    this.selPath = findPath(root, node);
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.onDragUp);
    window.addEventListener('pointercancel', this.onDragUp);
    return true;
  }

  private onDragMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    if (e.buttons === 0) {
      this.endDrag(false); // 在窗口外松开:取消本次拖拽,不写回
      return;
    }
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THR) return;
    d.moved = true;
    this.canvasHost.classList.add(d.kind === 'move' ? 'ds-dragging' : 'ds-sizing');
    const targets = this.snapTargets(d);
    if (d.kind === 'move') {
      const s = snapMove(d.box, targets, dx, dy, SNAP_THR);
      d.dx = s.dx;
      d.dy = s.dy;
      d.elm.style.transform = `translate(${Math.round(s.dx)}px, ${Math.round(s.dy)}px)`;
      this.showGuides(s.guides);
    } else {
      const s = snapResize(d.box, targets, d.handle!, dx, dy, SNAP_THR);
      d.dx = s.dx;
      d.dy = s.dy;
      this.previewResize(d, s.dx, s.dy);
      this.showGuides(s.guides);
    }
    e.preventDefault();
  };

  private onDragUp = (e: PointerEvent): void => {
    if (!this.drag) return;
    if (e.type === 'pointerup') this.endDrag(true);
    else this.endDrag(false);
  };

  /** 缩放预览:与 applyResize 的截断口径保持一致(下限 MIN_SIZE) */
  private previewResize(d: DragState, dx: number, dy: number): void {
    const h = d.handle!;
    const b = d.box;
    let x = b.x;
    let y = b.y;
    let w = b.w;
    let ht = b.h;
    if (h.includes('e')) w = Math.max(MIN_SIZE, b.w + dx);
    else if (h.includes('w')) {
      w = Math.max(MIN_SIZE, b.w - dx);
      x = b.x + (b.w - w);
    }
    if (h.includes('s')) ht = Math.max(MIN_SIZE, b.h + dy);
    else if (h.includes('n')) {
      ht = Math.max(MIN_SIZE, b.h - dy);
      y = b.y + (b.h - ht);
    }
    d.elm.style.left = d.lx + (x - b.x) + 'px';
    d.elm.style.top = d.ly + (y - b.y) + 'px';
    d.elm.style.width = w + 'px';
    d.elm.style.height = ht + 'px';
  }

  private snapTargets(d: DragState): Rect[] {
    const out: Rect[] = [];
    if (!d.parent || !this.painted) return out;
    const skip = new Set<DesignNode>();
    const mark = (n: DesignNode): void => {
      skip.add(n);
      for (const c of n.children) mark(c);
    };
    mark(d.node);
    for (const ch of d.parent.children) {
      if (skip.has(ch)) continue;
      const b = this.painted.boxes.get(ch);
      if (b) out.push({ x: b.x, y: b.y, w: b.w, h: b.h });
    }
    const pb = this.painted.boxes.get(d.parent);
    if (pb) out.push({ x: pb.x, y: pb.y, w: pb.w, h: pb.h });
    return out;
  }

  private showGuides(guides: Guide[]): void {
    this.clearGuides();
    const frame = this.painted?.frame;
    if (!frame) return;
    for (const g of guides) {
      const line = el('div', 'ds-guide-line ds-guide-' + (g.axis === 'x' ? 'x' : 'y'));
      if (g.axis === 'x') {
        line.style.left = g.pos + 'px';
        line.style.top = g.from + 'px';
        line.style.height = Math.max(0, g.to - g.from) + 'px';
      } else {
        line.style.top = g.pos + 'px';
        line.style.left = g.from + 'px';
        line.style.width = Math.max(0, g.to - g.from) + 'px';
      }
      frame.appendChild(line);
      this.guides.push(line);
    }
  }

  private clearGuides(): void {
    for (const g of this.guides) g.remove();
    this.guides = [];
  }

  /** 结束拖拽:commit=true 落点写回;false 只还原预览 */
  private endDrag(commit: boolean): void {
    const d = this.drag;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragUp);
    window.removeEventListener('pointercancel', this.onDragUp);
    this.drag = null;
    this.canvasHost.classList.remove('ds-dragging', 'ds-sizing');
    this.clearGuides();
    if (!d) return;
    // 还原预览样式(重绘在写回后到达;不还原会残留位移/尺寸)
    d.elm.style.transform = '';
    if (d.kind === 'resize') {
      d.elm.style.left = d.lx + 'px';
      d.elm.style.top = d.ly + 'px';
      d.elm.style.width = d.box.w + 'px';
      d.elm.style.height = d.box.h + 'px';
    }
    if (d.moved) {
      this.justDragged = true;
      window.setTimeout(() => {
        this.justDragged = false;
      }, 0);
    }
    if (!d.moved || !commit) {
      if (d.moved) this.open(); // 取消:恢复画面
      return;
    }
    const edited =
      d.kind === 'move'
        ? applyMove(d.node, d.mode, d.dx, d.dy)
        : applyResize(d.node, d.mode, d.box, d.handle!, d.dx, d.dy, d.locked);
    if (!edited) {
      this.hint('本次拖拽没有产生可用改动');
      this.open();
      return;
    }
    if (this.writeBack()) {
      this.hint(
        d.kind === 'move' && d.mode === 'offset'
          ? `已写 ${'平移x/y'}(流式布局内不改兄弟排布)`
          : d.kind === 'move'
            ? '已写 x/y'
            : '已写 宽/高',
        'ok',
      );
    } else {
      this.hint('写回被拒(编辑器内容已变化),已重读');
      this.open();
    }
  }

  // ---------------------------------------------------------------- 画布平移

  private panDown(e: PointerEvent): void {
    if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
    this.pan = { on: true, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    window.addEventListener('pointermove', this.onPanMove);
    window.addEventListener('pointerup', this.onPanUp);
    window.addEventListener('pointercancel', this.onPanUp);
  }

  private onPanMove = (e: PointerEvent): void => {
    if (!this.pan.on || e.pointerId !== this.pan.id) return;
    if (e.buttons === 0) {
      this.endPan(); // 在窗口外松开(收不到 pointerup)时兜底,避免平移"粘住"
      return;
    }
    const dx = e.clientX - this.pan.x;
    const dy = e.clientY - this.pan.y;
    if (!this.pan.moved && Math.abs(dx) + Math.abs(dy) < 4) return; // 阈值内视为单击
    this.pan.moved = true;
    this.pan.x = e.clientX;
    this.pan.y = e.clientY;
    this.canvasHost.classList.add('ds-panning');
    this.canvasHost.scrollLeft -= dx;
    this.canvasHost.scrollTop -= dy;
    e.preventDefault();
  };

  private onPanUp = (e: PointerEvent): void => {
    if (!this.pan.on || e.pointerId !== this.pan.id) return;
    this.endPan();
  };

  private endPan(): void {
    const moved = this.pan.moved;
    this.pan.on = false;
    window.removeEventListener('pointermove', this.onPanMove);
    window.removeEventListener('pointerup', this.onPanUp);
    window.removeEventListener('pointercancel', this.onPanUp);
    this.canvasHost.classList.remove('ds-panning');
    if (moved) {
      this.justDragged = true; // 拖拽收尾的那次 click 不当作选择
      window.setTimeout(() => {
        this.justDragged = false;
      }, 0);
    }
  }

  // ---------------------------------------------------------------- 分隔条

  private splitDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    this.splitDrag = { on: true, x: e.clientX, w: this.insp.getBoundingClientRect().width };
    this.split.classList.add('dragging');
    document.body.classList.add('ds-col-resize');
    this.split.setPointerCapture(e.pointerId); // 指针移出窗口也能收到 up
    window.addEventListener('pointermove', this.onSplitMove);
    window.addEventListener('pointerup', this.onSplitUp);
    window.addEventListener('pointercancel', this.onSplitUp);
  }

  private onSplitMove = (e: PointerEvent): void => {
    if (!this.splitDrag.on) return;
    const w = Math.min(640, Math.max(180, this.splitDrag.w - (e.clientX - this.splitDrag.x)));
    this.insp.style.width = Math.round(w) + 'px';
    e.preventDefault();
  };

  private onSplitUp = (): void => {
    if (!this.splitDrag.on) return;
    this.splitDrag.on = false;
    this.split.classList.remove('dragging');
    document.body.classList.remove('ds-col-resize');
    window.removeEventListener('pointermove', this.onSplitMove);
    window.removeEventListener('pointerup', this.onSplitUp);
    window.removeEventListener('pointercancel', this.onSplitUp);
  };
}
