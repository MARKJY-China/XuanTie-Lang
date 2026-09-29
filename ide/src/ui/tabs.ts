// 编辑器标签页:打开/激活/脏标记/保存/关闭(关闭脏文档先确认)
import * as monaco from 'monaco-editor';
import * as backend from '../backend';
import { basename } from '../util';

export interface TabHooks {
  onDidOpen(path: string, text: string): void;
  onDidChange(path: string, text: string): void;
  onDidSave(path: string): void;
  onDidClose(path: string): void;
  onActivate(path: string | null): void;
}

export interface RevealTarget {
  line: number;
  column: number;
}

interface OpenDoc {
  path: string;
  model: monaco.editor.ITextModel;
  tabEl: HTMLElement;
  savedText: string;
}

export class TabManager {
  private docs = new Map<string, OpenDoc>();
  private order: string[] = [];
  private activePath: string | null = null;

  constructor(
    private tabBar: HTMLElement,
    private editor: monaco.editor.IStandaloneCodeEditor,
    private hooks: TabHooks,
    private confirmDiscard: (path: string) => Promise<boolean>,
  ) {
    editor.onDidChangeModelContent(() => {
      const doc = this.active();
      if (!doc) return;
      this.refreshDirty(doc);
      this.hooks.onDidChange(doc.path, doc.model.getValue());
    });
  }

  private active(): OpenDoc | undefined {
    return this.activePath ? this.docs.get(this.activePath) : undefined;
  }

  getActivePath(): string | null {
    return this.activePath;
  }

  isOpen(path: string): boolean {
    return this.docs.has(path);
  }

  getAllPaths(): string[] {
    return [...this.order];
  }

  getText(path: string): string | null {
    const doc = this.docs.get(path);
    return doc ? doc.model.getValue() : null;
  }

  getActiveText(): string | null {
    const doc = this.active();
    return doc ? doc.model.getValue() : null;
  }

  isDirty(path: string): boolean {
    const doc = this.docs.get(path);
    return doc ? doc.model.getValue() !== doc.savedText : false;
  }

  async openFile(path: string, reveal?: RevealTarget): Promise<void> {
    const existing = this.docs.get(path);
    if (existing) {
      this.activate(path);
      if (reveal) this.reveal(existing.model, reveal);
      return;
    }
    const text = await backend.fsReadFile(path);
    const uri = monaco.Uri.file(path);
    let model = monaco.editor.getModel(uri);
    if (model) {
      model.setValue(text);
    } else {
      model = monaco.editor.createModel(text, 'xuantie', uri);
    }
    const tabEl = this.buildTab(path);
    this.tabBar.appendChild(tabEl);
    this.docs.set(path, { path, model, tabEl, savedText: text });
    this.order.push(path);
    this.hooks.onDidOpen(path, text);
    this.activate(path);
    if (reveal) this.reveal(model, reveal);
  }

  activate(path: string | null): void {
    if (path !== null && !this.docs.has(path)) return;
    this.activePath = path;
    for (const [p, doc] of this.docs) {
      doc.tabEl.classList.toggle('active', p === path);
    }
    const doc = this.active();
    this.editor.setModel(doc ? doc.model : null);
    this.hooks.onActivate(path);
  }

  async save(path: string): Promise<void> {
    const doc = this.docs.get(path);
    if (!doc) return;
    const text = doc.model.getValue();
    await backend.fsWriteFile(path, text);
    doc.savedText = text;
    this.refreshDirty(doc);
    this.hooks.onDidSave(path);
  }

  async saveAll(): Promise<void> {
    for (const p of this.order) {
      if (this.isDirty(p)) await this.save(p);
    }
  }

  async close(path: string): Promise<boolean> {
    const doc = this.docs.get(path);
    if (!doc) return true;
    if (this.isDirty(path)) {
      const ok = await this.confirmDiscard(path);
      if (!ok) return false;
    }
    const idx = this.order.indexOf(path);
    this.order.splice(idx, 1);
    this.docs.delete(path);
    doc.tabEl.remove();
    if (this.activePath === path) {
      const next = this.order.length > 0 ? this.order[this.order.length - 1] : null;
      this.activate(next);
    }
    doc.model.dispose();
    this.hooks.onDidClose(path);
    return true;
  }

  private refreshDirty(doc: OpenDoc): void {
    const dirty = doc.model.getValue() !== doc.savedText;
    doc.tabEl.classList.toggle('dirty', dirty);
  }

  private reveal(model: monaco.editor.ITextModel, target: RevealTarget): void {
    this.editor.revealLineInCenter(target.line);
    this.editor.setPosition({ lineNumber: target.line, column: target.column });
    this.editor.focus();
    void model;
  }

  private buildTab(path: string): HTMLElement {
    const tab = document.createElement('div');
    tab.className = 'tab';
    const name = document.createElement('span');
    name.className = 'tname';
    name.textContent = basename(path);
    name.title = path;
    const dot = document.createElement('span');
    dot.className = 'dirty';
    dot.textContent = '●';
    const closeBtn = document.createElement('span');
    closeBtn.className = 'tclose';
    const closeIco = document.createElement('i');
    closeIco.className = 'codicon codicon-close';
    closeBtn.appendChild(closeIco);
    tab.append(name, dot, closeBtn);
    tab.addEventListener('click', () => this.activate(path));
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void this.close(path);
    });
    return tab;
  }
}
