// 铸造厂内置 API 文档书:浏览 GUIDE/API、GUIDE/关键字 与标准库手册。
// 数据由 tools/gen-ide-api-docs.mjs 生成并随 IDE 打包,离线可用。
// 与编辑器联动:方法悬停用 METHOD_DOCS,Ctrl+点击打开对应方法页。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { DOC_PAGES, METHOD_DOCS, type DocPage } from '../docs/api-docs.generated';
import { showToast } from './dialogs';
import './docs-book.css';

const PAGE_BY_ID = new Map(DOC_PAGES.map((p) => [p.id, p]));
const GROUP_ORDER = ['语言内建', '库 API', '手册'];
const METHOD_NAMES = [...new Set(METHOD_DOCS.map((m) => m.name))].sort((a, b) => a.localeCompare(b, 'zh-CN'));

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** 把文档里的相对链接解析成打包页 id;解析不到返回 null。 */
function resolvePageLink(href: string, fromId: string): string | null {
  let clean = href.split('#')[0].split('?')[0].trim();
  if (!clean) return null;
  if (clean.startsWith('doc:')) clean = clean.slice(4);
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 保留原样
  }
  if (/^(?:https?:|mailto:|data:)/i.test(clean) || clean.startsWith('#')) return null;
  clean = clean.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = fromId.split('/');
  parts.pop();
  for (const seg of clean.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  let id = parts.join('/').replace(/\.md$/i, '');
  // GUIDE 旧链接可能省略/改动层级;尝试直接按 id 再匹配一次
  if (!PAGE_BY_ID.has(id)) {
    const noExt = clean.replace(/\.md$/i, '');
    if (PAGE_BY_ID.has(noExt)) id = noExt;
    else if (PAGE_BY_ID.has('关键字/' + noExt)) id = '关键字/' + noExt;
    else return null;
  }
  return id;
}

export interface DocsBookOptions {
  /** 独立窗口模式:关闭按钮/Esc 关闭当前 Tauri 窗口,而非隐藏覆盖层 */
  standalone?: boolean;
}

export class DocsBook {
  private readonly root: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly content: HTMLElement;
  private readonly search: HTMLInputElement;
  private currentPageId = '';
  private navEntries: { el: HTMLElement; search: string }[] = [];

  constructor(private readonly opts: DocsBookOptions = {}) {
    this.root = document.createElement('div');
    this.root.id = 'docs-book';
    this.root.className = 'hidden' + (this.opts.standalone ? ' docs-standalone' : '');
    const winControls = this.opts.standalone
      ? `<div class="docs-win-controls">
          <button class="docs-win-btn" data-win="min" title="最小化"><i class="codicon codicon-chrome-minimize"></i></button>
          <button class="docs-win-btn" data-win="max" title="最大化"><i class="codicon codicon-chrome-maximize"></i></button>
          <button class="docs-win-btn close" data-win="close" title="关闭"><i class="codicon codicon-chrome-close"></i></button>
        </div>`
      : `<button class="docs-close" title="关闭 (Esc)"><i class="codicon codicon-close"></i></button>`;
    this.root.innerHTML = `
      <div class="docs-head">
        <button class="docs-icon-btn" id="docs-nav-toggle" title="收起目录"><i class="codicon codicon-layout-sidebar-left"></i></button>
        <i class="codicon codicon-book docs-brand"></i>
        <span class="docs-title">玄铁 API 文档书</span>
        <input class="docs-search" type="search" placeholder="搜索页面 / 方法…" spellcheck="false" />
        <div class="docs-head-spacer"></div>
        ${winControls}
      </div>
      <div class="docs-main">
        <aside class="docs-nav"></aside>
        <section class="docs-content"></section>
      </div>`;
    document.body.appendChild(this.root);
    this.nav = this.root.querySelector('.docs-nav') as HTMLElement;
    this.content = this.root.querySelector('.docs-content') as HTMLElement;
    this.search = this.root.querySelector('.docs-search') as HTMLInputElement;
    this.nav.addEventListener('click', (ev) => this.onNavClick(ev));
    this.content.addEventListener('click', (ev) => this.onContentClick(ev));
    this.root.querySelector('.docs-close')?.addEventListener('click', () => this.requestClose());
    this.search.addEventListener('input', () => this.filterNav());
    this.initWindowChrome();
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !this.root.classList.contains('hidden')) {
        ev.preventDefault();
        this.requestClose();
      }
    });
    this.renderNav();
  }

  /** 独立窗口自绘标题栏:拖动区、最小化/最大化/关闭、侧栏收起。 */
  private initWindowChrome(): void {
    const toggle = this.root.querySelector<HTMLButtonElement>('#docs-nav-toggle');
    let collapsed = false;
    try {
      collapsed = localStorage.getItem('xuantie.docs.navCollapsed') === '1';
    } catch {
      // localStorage 不可用时保持展开
    }
    const applyCollapsed = (v: boolean): void => {
      this.root.classList.toggle('nav-collapsed', v);
      const ico = toggle?.querySelector('i');
      if (ico) ico.className = 'codicon ' + (v ? 'codicon-layout-sidebar-left-off' : 'codicon-layout-sidebar-left');
      if (toggle) toggle.title = v ? '展开目录' : '收起目录';
      try {
        localStorage.setItem('xuantie.docs.navCollapsed', v ? '1' : '0');
      } catch {
        // 忽略
      }
    };
    applyCollapsed(collapsed);
    toggle?.addEventListener('click', () => applyCollapsed(!this.root.classList.contains('nav-collapsed')));

    if (!this.opts.standalone) return;
    const win = getCurrentWindow();
    const head = this.root.querySelector<HTMLElement>('.docs-head');
    this.root.querySelectorAll<HTMLButtonElement>('[data-win]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = btn.dataset.win;
        if (act === 'min') void win.minimize().catch(() => undefined);
        else if (act === 'max') void win.toggleMaximize().then(() => this.syncMaxIcon()).catch(() => undefined);
        else if (act === 'close') void win.close().catch(() => undefined);
      });
    });
    head?.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      if ((ev.target as HTMLElement).closest('button,input,select,textarea')) return;
      // 与主窗口同口径:手动 startDragging,不依赖 data-tauri-drag-region
      void win.startDragging().catch(() => undefined);
    });
    head?.addEventListener('dblclick', (ev) => {
      if ((ev.target as HTMLElement).closest('button,input,select,textarea')) return;
      void win.toggleMaximize().then(() => this.syncMaxIcon()).catch(() => undefined);
    });
    void this.syncMaxIcon();
    void win.onResized(() => void this.syncMaxIcon()).catch(() => undefined);
  }

  private async syncMaxIcon(): Promise<void> {
    const ico = this.root.querySelector<HTMLElement>('[data-win="max"] i');
    if (!ico) return;
    try {
      const max = await getCurrentWindow().isMaximized();
      ico.className = 'codicon ' + (max ? 'codicon-chrome-restore' : 'codicon-chrome-maximize');
    } catch {
      // 窗口关闭竞态
    }
  }

  open(): void {
    this.root.classList.remove('hidden');
    if (!this.currentPageId) this.openPage('API/README');
  }

  openPage(id: string): void {
    this.root.classList.remove('hidden');
    const page = PAGE_BY_ID.get(id);
    if (!page) {
      showToast(`文档中未找到页面:${id}`, 'err');
      return;
    }
    this.currentPageId = id;
    this.markActive(`page:${id}`);
    this.content.scrollTop = 0;
    this.content.innerHTML = this.renderMarkdown(page.markdown, id);
    this.search.value = '';
    this.filterNav();
  }

  openMethod(name: string): void {
    this.root.classList.remove('hidden');
    const entries = METHOD_DOCS.filter((m) => m.name === name);
    this.currentPageId = `method:${name}`;
    this.markActive(`method:${name}`);
    this.content.scrollTop = 0;
    if (entries.length === 0) {
      this.content.innerHTML = `<article class="docs-article"><h1>${escapeHtml(name)}</h1><p>API 文档中暂未收录方法 <code>${escapeHtml(name)}</code>。</p></article>`;
      return;
    }
    const sections = entries
      .map((e) => {
        const link = `[查看《${e.pageTitle}》完整文档](doc:${e.pageId})`;
        return [
          `## ${e.receiver}.${e.name}`,
          '',
          `**签名**：\`${e.signature}\``,
          '',
          e.summary,
          '',
          link,
          '',
        ].join('\n');
      })
      .join('\n');
    const md = [`# 方法：${name}`, '', '> 语言内建方法。悬停与 Ctrl+点击共用本索引。', '', sections].join('\n');
    this.content.innerHTML = this.renderMarkdown(md, `method:${name}`);
    this.search.value = '';
    this.filterNav();
  }

  /** 独立窗口直接关窗口;主窗口覆盖层模式只隐藏。 */
  private requestClose(): void {
    if (this.opts.standalone) void getCurrentWindow().close();
    else this.close();
  }

  close(): void {
    this.root.classList.add('hidden');
  }

  private renderNav(): void {
    this.nav.innerHTML = '';
    this.navEntries = [];
    const section = (title: string): HTMLElement => {
      const h = document.createElement('div');
      h.className = 'docs-nav-group';
      h.textContent = title;
      this.nav.appendChild(h);
      return h;
    };
    const item = (label: string, key: string, search: string, cls = ''): void => {
      const b = document.createElement('button');
      b.className = 'docs-nav-item' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.dataset.key = key;
      this.nav.appendChild(b);
      this.navEntries.push({ el: b, search });
    };

    section('内建方法');
    for (const name of METHOD_NAMES) item(name, `method:${name}`, name, 'docs-nav-method');

    const groups = new Map<string, DocPage[]>();
    for (const p of DOC_PAGES) {
      if (!groups.has(p.group)) groups.set(p.group, []);
      groups.get(p.group)!.push(p);
    }
    for (const g of GROUP_ORDER) {
      const pages = groups.get(g);
      if (!pages || pages.length === 0) continue;
      section(g);
      for (const p of pages) item(p.title, `page:${p.id}`, `${p.title} ${p.id}`);
    }
  }

  private onNavClick(ev: MouseEvent): void {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('.docs-nav-item');
    if (!btn?.dataset.key) return;
    const key = btn.dataset.key;
    if (key.startsWith('method:')) this.openMethod(key.slice('method:'.length));
    else if (key.startsWith('page:')) this.openPage(key.slice('page:'.length));
  }

  private markActive(key: string): void {
    for (const it of this.navEntries) it.el.classList.toggle('active', it.el.dataset.key === key);
    const active = this.navEntries.find((it) => it.el.dataset.key === key)?.el;
    active?.scrollIntoView({ block: 'nearest' });
  }

  private filterNav(): void {
    const q = this.search.value.trim().toLowerCase();
    for (const it of this.navEntries) {
      it.el.classList.toggle('hidden', q !== '' && !it.search.toLowerCase().includes(q));
    }
  }

  private renderMarkdown(markdown: string, fromId: string): string {
    let raw = '';
    try {
      raw = marked.parse(markdown, { async: false, gfm: true, breaks: false }) as string;
    } catch (err) {
      return `<article class="docs-article"><h1>文档渲染失败</h1><pre>${escapeHtml(String(err))}</pre></article>`;
    }
    const tpl = document.createElement('template');
    tpl.innerHTML = raw;

    const used = new Map<string, number>();
    tpl.content.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((el) => {
      const base = slugify(el.textContent ?? '');
      const n = (used.get(base) ?? 0) + 1;
      used.set(base, n);
      el.id = n === 1 ? base : `${base}-${n}`;
    });

    tpl.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
      const href = a.getAttribute('href') ?? '';
      a.removeAttribute('href');
      if (href.startsWith('#')) {
        a.setAttribute('data-doc-anchor', href.slice(1));
      } else if (/^(?:https?:|mailto:)/i.test(href)) {
        a.setAttribute('data-doc-external', href);
      } else if (href.startsWith('doc:')) {
        a.setAttribute('data-doc-page', href.slice(4));
      } else {
        const id = resolvePageLink(href, fromId);
        if (id) a.setAttribute('data-doc-page', id);
        else a.setAttribute('data-doc-missing', href);
      }
      a.setAttribute('rel', 'noopener noreferrer');
    });

    // 文档图片不随页面打包:保留 alt,避免 WebView 去请求相对路径
    tpl.content.querySelectorAll<HTMLImageElement>('img[src]').forEach((img) => {
      const src = img.getAttribute('src') ?? '';
      if (!/^(?:data:|https?:)/i.test(src)) {
        img.removeAttribute('src');
        img.classList.add('docs-image-missing');
      }
    });

    const clean = DOMPurify.sanitize(tpl.innerHTML, {
      ADD_ATTR: ['data-doc-anchor', 'data-doc-page', 'data-doc-external', 'data-doc-missing'],
    });
    return `<article class="docs-article">${clean}</article>`;
  }

  private onContentClick(ev: MouseEvent): void {
    const a = (ev.target as HTMLElement).closest<HTMLAnchorElement>('a[data-doc-page],a[data-doc-anchor],a[data-doc-external],a[data-doc-missing]');
    if (!a) return;
    ev.preventDefault();
    const page = a.getAttribute('data-doc-page');
    if (page) {
      this.openPage(page);
      return;
    }
    const anchor = a.getAttribute('data-doc-anchor');
    if (anchor) {
      this.content.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    const external = a.getAttribute('data-doc-external');
    if (external) {
      void openUrl(external).catch(() => undefined);
      return;
    }
    const missing = a.getAttribute('data-doc-missing');
    if (missing) showToast(`该链接未随 IDE 打包:${missing}`, '');
  }
}
