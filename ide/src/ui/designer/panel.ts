// 铸造厂 UI 设计器 —— 编辑器内嵌视图(Tab 栏右侧开关切换)
// 开启:编辑器区整体由代码编辑器切换为设计器(左画布 + 右检视);关闭:恢复代码编辑器。
// 当前阶段对设计区严格只读(绝不改写不理解的内容);文件无设计区时提供「生成标记 / 复制标记」。
import { parseDesignFunction, type DesignNode, type ParseResult } from './parser';
import { findRegions, regionText, type RegionRef } from './region';
import { layoutTree, type Measure } from './layout';
import { paintDesign } from './paint';
import { valText, generateDesignFunction } from './generator';
import { markBegin, markEnd } from './spec';

export interface DesignerDeps {
  /** 取当前文件(path 供标题;text 为编辑器实时文本) */
  getActive(): { path: string; text: string } | null;
  /** 通过编辑器模型在文件末尾追加文本(留在未保存缓冲,由用户决定何时保存) */
  appendToFile(text: string): boolean;
  /** 复制文本到剪贴板 */
  copy(text: string): Promise<boolean>;
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

function el(tag: string, cls: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class DesignerPanel {
  private sub: HTMLElement;
  private picker: HTMLSelectElement;
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
  private selected: DesignNode | null = null;
  private open_ = false;
  private pan = { on: false, id: -1, x: 0, y: 0, moved: false };
  private justDragged = false;
  private splitDrag = { on: false, x: 0, w: 300 };

  constructor(host: HTMLElement, private deps: DesignerDeps) {
    // 工具条:标题 + 文件/区 + 刷新 + 只读徽标
    const bar = el('div', 'ds-toolbar');
    bar.appendChild(el('span', 'ds-title', '界面设计器'));
    this.sub = el('span', 'ds-sub', '');
    this.picker = document.createElement('select');
    this.picker.className = 'ds-picker';
    this.picker.addEventListener('change', () => {
      this.regionIdx = Number(this.picker.value) || 0;
      this.selected = null;
      this.reparse();
    });
    this.badge = el('span', 'ds-badge', '');
    const refresh = document.createElement('button');
    refresh.className = 'ds-btn';
    refresh.title = '重新读取当前文件';
    refresh.innerHTML = '<i class="codicon codicon-refresh"></i>';
    refresh.addEventListener('click', () => this.open());
    bar.append(this.sub, this.picker, this.badge, refresh);

    // 主体:画布 + 宽度可拖的分隔条 + 检视
    const body = el('div', 'ds-body');
    this.canvasHost = el('div', 'ds-canvas');
    this.split = el('div', 'ds-split');
    this.split.title = '拖动调整属性面板宽度';
    this.insp = el('div', 'ds-insp');
    body.append(this.canvasHost, this.split, this.insp);

    this.issuesEl = el('div', 'ds-issues');
    host.append(bar, body, this.issuesEl);

    // 画布拖拽平移:左/中/右任一键按住拖动移动视区;未移动的单击仍作选择
    this.canvasHost.addEventListener('pointerdown', (e) => this.panDown(e));
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

  /** 打开(或重读)当前文件;由开关、刷新按钮、切页时调用 */
  open(): void {
    this.open_ = true;
    const cur = this.deps.getActive();
    if (!cur) {
      this.renderEmpty('没有打开的文件', false);
      return;
    }
    this.filePath = cur.path;
    this.fileText = cur.text;
    this.regions = findRegions(this.fileText);
    if (this.regions.length === 0) {
      this.renderEmpty(
        '当前文件没有设计区。点下方按钮在文件末尾生成一段可直接运行的空界面标记,\n或手动加入:\n' + markBegin(NEW_REGION_NAME),
        true,
      );
      return;
    }
    this.regionIdx = Math.min(this.regionIdx, this.regions.length - 1);
    this.selected = null;
    this.reparse();
  }

  close(): void {
    this.open_ = false;
  }

  /** 切页/外部改动后,若视图开着则重读 */
  refreshIfOpen(): void {
    if (this.open_) this.open();
  }

  // ---------------------------------------------------------------- 渲染

  private reparse(): void {
    const ref = this.regions[this.regionIdx];
    const text = regionText(this.fileText, ref);
    this.parsed = parseDesignFunction(text);
    this.renderHead();
    this.renderIssues();
    this.renderCanvas();
    this.renderInspector();
  }

  private renderEmpty(msg: string, withActions: boolean): void {
    this.parsed = null;
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
    if (this.deps.appendToFile(insert)) this.open();
    else {
      this.sub.textContent = '生成失败:没有可编辑的编辑器缓冲区';
    }
  }

  private async copyMarkers(): Promise<void> {
    const text = markBegin(NEW_REGION_NAME) + '\n' + markEnd(NEW_REGION_NAME) + '\n';
    const ok = await this.deps.copy(text);
    const old = this.badge.textContent;
    this.badge.textContent = ok ? '标记已复制' : '复制失败';
    this.badge.className = 'ds-badge ' + (ok ? 'ok' : 'warn');
    window.setTimeout(() => {
      this.badge.textContent = old ?? '';
      this.renderHead();
    }, 1600);
  }

  private renderHead(): void {
    this.sub.textContent = (this.filePath.split(/[\\/]/).pop() ?? '') + (this.regions.length > 1 ? `(${this.regions.length} 个区)` : '');
    this.picker.style.display = this.regions.length > 1 ? '' : 'none';
    this.picker.innerHTML = '';
    this.regions.forEach((r, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = r.name;
      this.picker.appendChild(o);
    });
    this.picker.value = String(this.regionIdx);
    const ok = this.parsed?.ok === true;
    this.badge.textContent = ok ? '符合子集 · 可编辑(待切片3)' : '子集外 · 只读';
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
    this.canvasHost.innerHTML = '';
    const root = this.parsed?.root;
    if (!root) {
      this.canvasHost.appendChild(el('div', 'ds-empty', '本区没有可解析的控件树(见下方原因)'));
      return;
    }
    const laid = layoutTree(root, measure);
    paintDesign(this.canvasHost, laid, this.selected, (n) => {
      this.selected = n;
      this.renderCanvas();
      this.renderInspector();
    });
    if (laid.notes.length > 0) {
      this.canvasHost.appendChild(el('div', 'ds-note', laid.notes.join(';')));
    }
  }

  private renderInspector(): void {
    this.insp.innerHTML = '';
    const n = this.selected;
    if (!n) {
      this.insp.appendChild(el('div', 'ds-insp-hint', '点击画布中的控件查看属性'));
      return;
    }
    const 行 = (label: string, val: string): void => {
      const r = el('div', 'ds-row');
      r.append(el('span', 'ds-k', label), el('span', 'ds-v', val));
      this.insp.appendChild(r);
    };
    const 段 = (t: string): void => {
      this.insp.appendChild(el('div', 'ds-sec', t));
    };
    段('控件');
    行('类型', n.kind === 'container' ? `容器 · ${n.widget}` : `控件 · ${n.widget}`);
    if (n.varName) 行('变量名', n.varName);
    else if (n.widget !== '空白' && n.widget !== '弹性') 行('变量名', '(内联叶子)');
    行('源码行', String(n.line));
    if (n.args.length > 0) {
      段('实参');
      n.args.forEach((a, i) => 行(`#${i + 1}`, valText(a)));
    }
    if (n.options.length > 0) {
      段('选项(' + n.options.length + ')');
      for (const o of n.options) 行(o.key, valText(o.value));
    }
    if (n.children.length > 0) 段(`子项(${n.children.length})`);
  }
}
