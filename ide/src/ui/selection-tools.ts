// 编辑器选中浮层(Trae 式):选中一段代码后,选区上方浮出「编辑 / 添加到对话」。
// - 编辑(Ctrl+I):浮层就地变输入栏,回车把「指令 + 选中代码引用」发给智器对话;
// - 添加到对话(Ctrl+U):把引用 chip(文件:行范围)加到 AI 输入栏,发送时随消息带出。
// 定位用 monaco 的 getScrolledVisiblePosition(相对编辑器容器);浮层挂在 #editor-host 绝对定位。
import * as monaco from 'monaco-editor';
import { uriToPath } from '../uri';

export interface SelectionRef {
  path: string;
  /** 1-based,含 */
  startLine: number;
  /** 1-based,含 */
  endLine: number;
  text: string;
}

export interface SelectionToolsDeps {
  /** 「编辑」提交:把指令与选中代码交给智器对话 */
  onEdit(ref: SelectionRef, instruction: string): void;
  /** 「添加到对话」:引用 chip 加进 AI 输入栏 */
  onAddToChat(ref: SelectionRef): void;
}

const HIDE_DELAY_MS = 150;

export class SelectionTools {
  private bar: HTMLElement;
  private btnEdit: HTMLButtonElement;
  private btnAdd: HTMLButtonElement;
  private inputRow: HTMLElement;
  private input: HTMLInputElement;
  private submitBtn: HTMLButtonElement;
  private inputMode = false;
  private hideTimer: number | undefined;

  constructor(
    private editor: monaco.editor.IStandaloneCodeEditor,
    host: HTMLElement,
    private deps: SelectionToolsDeps,
  ) {
    this.bar = document.createElement('div');
    this.bar.className = 'sel-toolbar hidden';

    // 按钮态(图1):编辑 / 添加到对话
    const btnRow = document.createElement('div');
    btnRow.className = 'sel-btn-row';
    this.btnEdit = this.mkButton('codicon-sparkle', '编辑', 'Ctrl+I');
    this.btnAdd = this.mkButton('codicon-add', '添加到对话', 'Ctrl+U');
    btnRow.append(this.btnEdit, this.btnAdd);

    // 输入态(图2):指令输入栏
    this.inputRow = document.createElement('div');
    this.inputRow.className = 'sel-input-row hidden';
    this.input = document.createElement('input');
    this.input.type = 'text';
    this.input.className = 'sel-input';
    this.input.placeholder = '输入指令,回车发送(ESC 关闭)';
    this.submitBtn = document.createElement('button');
    this.submitBtn.className = 'sel-submit';
    this.submitBtn.title = '发送';
    this.submitBtn.innerHTML = '<i class="codicon codicon-arrow-up"></i>';
    this.inputRow.append(this.input, this.submitBtn);

    this.bar.append(btnRow, this.inputRow);
    host.appendChild(this.bar);

    this.btnEdit.addEventListener('click', () => this.enterEditMode());
    this.btnAdd.addEventListener('click', () => this.addCurrent());
    this.submitBtn.addEventListener('click', () => this.submitEdit());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.submitEdit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.hide();
      }
    });
    // 浮层自身交互不丢编辑器选区:统一在捕获阶段阻止默认的 focus 夺走
    this.bar.addEventListener('mousedown', (e) => {
      if (e.target !== this.input) e.preventDefault();
    });

    this.editor.onDidChangeCursorSelection(() => this.scheduleShow());
    this.editor.onDidScrollChange(() => {
      if (!this.bar.classList.contains('hidden')) this.position();
    });
    // 切换文件(模型变化)→ 关闭
    this.editor.onDidChangeModel(() => this.hide());
    // 点击浮层外任意区域 → 关闭(编辑器内点击也走这里;若随后产生新选区,selection 回调会重新亮起)
    document.addEventListener(
      'mousedown',
      (e) => {
        if (this.bar.classList.contains('hidden')) return;
        const t = e.target as Node | null;
        if (t && this.bar.contains(t)) return;
        this.hide();
      },
      true,
    );
    // ESC 全局关闭:焦点可能已不在输入框(点击编辑器输入态等处),输入框自身监听不够
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key === 'Escape' && !this.bar.classList.contains('hidden')) {
          this.hide();
        }
      },
      true,
    );
    this.editor.onDidBlurEditorText(() => {
      // 焦点进了浮层(输入态)不算离开
      window.setTimeout(() => {
        const active = document.activeElement;
        if (active && this.bar.contains(active)) return;
        if (!this.editor.hasTextFocus()) this.hide();
      }, 0);
    });
  }

  private mkButton(icon: string, label: string, shortcut: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'sel-tb-btn';
    const ic = document.createElement('i');
    ic.className = 'codicon ' + icon;
    const txt = document.createElement('span');
    txt.textContent = label;
    const sc = document.createElement('span');
    sc.className = 'sel-tb-sc';
    sc.textContent = shortcut;
    b.append(ic, txt, sc);
    return b;
  }

  /** 当前选区 → SelectionRef(空选区/非本编辑器模型 → null) */
  currentRef(): SelectionRef | null {
    const model = this.editor.getModel();
    const sel = this.editor.getSelection();
    if (!model || !sel || sel.isEmpty()) return null;
    const startLine = Math.min(sel.startLineNumber, sel.endLineNumber);
    const endLine = Math.max(sel.startLineNumber, sel.endLineNumber);
    const text = model.getValueInRange(new monaco.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine)));
    if (text.trim().length === 0) return null;
    return {
      path: uriToPath(model.uri.toString()),
      startLine,
      endLine,
      text,
    };
  }

  /** 选区变化后延迟显示(拖动/双击选中时不闪) */
  private scheduleShow(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      const ref = this.currentRef();
      if (!ref) {
        // 取消选中即关闭(输入态也关:用户取消选区后指令栏失去目标,理论/体验上都应关闭)
        this.hide();
        return;
      }
      if (this.inputMode) return; // 选中仍存在时,输入态不因选区微调而重置
      this.show();
    }, HIDE_DELAY_MS);
  }

  private show(): void {
    this.bar.classList.remove('hidden');
    this.setInputMode(false);
    this.position();
  }

  hide(): void {
    this.bar.classList.add('hidden');
    this.setInputMode(false);
    this.input.value = '';
  }

  /** 快捷键入口(等价点击「编辑」) */
  triggerEdit(): void {
    if (this.currentRef()) this.enterEditMode();
  }

  /** 快捷键入口(等价点击「添加到对话」) */
  triggerAdd(): void {
    this.addCurrent();
  }

  private enterEditMode(): void {
    const ref = this.currentRef();
    if (!ref) return;
    this.bar.classList.remove('hidden');
    this.setInputMode(true);
    this.position();
    this.input.focus();
  }

  private addCurrent(): void {
    const ref = this.currentRef();
    if (!ref) return;
    this.deps.onAddToChat(ref);
    this.hide();
  }

  private submitEdit(): void {
    const ref = this.currentRef();
    const instruction = this.input.value.trim();
    if (!ref || !instruction) return;
    this.deps.onEdit(ref, instruction);
    this.hide();
  }

  private setInputMode(v: boolean): void {
    this.inputMode = v;
    this.inputRow.classList.toggle('hidden', !v);
    this.bar.querySelector('.sel-btn-row')?.classList.toggle('hidden', v);
  }

  /** 定位于选区上方;上方空间不足时落到选区下方 */
  private position(): void {
    const sel = this.editor.getSelection();
    if (!sel) return;
    const start = this.editor.getScrolledVisiblePosition(sel.getStartPosition());
    const end = this.editor.getScrolledVisiblePosition(sel.getEndPosition());
    if (!start || !end) {
      this.hide();
      return;
    }
    // 视觉上的首行(选择方向可能是自下而上)
    const above = start.top <= end.top ? start : end;
    const below = above === start ? end : start;
    const barH = this.bar.offsetHeight || 34;
    const barW = this.bar.offsetWidth || 260;
    const hostW = this.bar.parentElement?.clientWidth ?? 800;
    const left = Math.max(8, Math.min(above.left, hostW - barW - 8));
    if (above.top >= barH + 10) {
      this.bar.style.top = `${above.top - barH - 6}px`;
    } else {
      this.bar.style.top = `${below.top + below.height + 6}px`;
    }
    this.bar.style.left = `${left}px`;
  }
}
