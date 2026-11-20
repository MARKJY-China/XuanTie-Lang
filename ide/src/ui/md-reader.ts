// Markdown 阅读器:铸造厂内 .md 默认以渲染视图打开,可切回源码。
// 安全边界:marked 产出 → 预处理链接/图片 → DOMPurify 净化;脚本/事件属性全部丢弃。
// 链接:外链交给系统浏览器,本地 .md 交给 IDE 打开,锚点在本页滚动。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import 'katex/dist/katex.min.css';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as backend from '../backend';
import { dirname } from '../util';

export interface MarkdownReaderOptions {
  /** 打开本地文件(相对链接解析后的绝对路径) */
  openFile: (path: string) => void;
}

const BLOCK_TAGS = 'h1,h2,h3,h4,h5,h6';

function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\w\u0080-\uFFFF]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/** 把相对路径按 Markdown 文件所在目录解析成绝对路径(Windows 反斜杠优先)。 */
export function resolveMarkdownPath(baseFile: string, href: string): string {
  let clean = href.split('#')[0].split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // 保留原样
  }
  if (/^[a-zA-Z]:[\\/]/.test(clean) || clean.startsWith('\\\\') || clean.startsWith('/')) {
    return clean;
  }
  const sep = baseFile.includes('\\') ? '\\' : '/';
  const parts = dirname(baseFile).split(sep).filter(Boolean);
  const segments = clean.replace(/[\\/]+/g, sep).split(sep);
  for (const seg of segments) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const joined = parts.join(sep);
  return sep === '\\' ? joined : '/' + joined;
}

/**
 * 渲染态 Markdown 阅读器。一个实例复用一个 DOM host,按路径保存滚动位置。
 */
export class MarkdownReader {
  private currentPath = '';
  private currentText = '';
  private renderSeq = 0;
  private scrollByPath = new Map<string, number>();
  private readonly article: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: MarkdownReaderOptions,
  ) {
    host.classList.add('md-reader-host');
    this.article = document.createElement('article');
    this.article.className = 'md-reader';
    host.replaceChildren(this.article);
    host.addEventListener('click', (ev) => this.onClick(ev));
  }

  /** 是否已经有可见文档 */
  get active(): boolean {
    return !this.host.classList.contains('hidden');
  }

  show(path: string, text: string): void {
    if (this.currentPath === path && this.currentText === text && this.article.childElementCount > 0) {
      this.host.classList.remove('hidden');
      return;
    }
    if (this.currentPath && this.currentPath !== path) {
      this.scrollByPath.set(this.currentPath, this.host.scrollTop);
    }
    this.currentPath = path;
    this.currentText = text;
    this.renderSeq++;
    const seq = this.renderSeq;
    this.host.classList.remove('hidden');

    try {
      const raw = marked.parse(text, { async: false, gfm: true, breaks: false }) as string;
      const tpl = document.createElement('template');
      tpl.innerHTML = raw;

      // 标题 id:锚点链接可在阅读器内跳转(同名标题追加序号)
      const used = new Map<string, number>();
      tpl.content.querySelectorAll(BLOCK_TAGS).forEach((el) => {
        const base = headingSlug(el.textContent ?? '');
        const n = (used.get(base) ?? 0) + 1;
        used.set(base, n);
        el.id = n === 1 ? base : `${base}-${n}`;
      });

      // 链接劫持:去掉 href,统一写入 data-md-href;外链/本地文件由点击事件决定
      tpl.content.querySelectorAll('a[href]').forEach((a) => {
        const href = a.getAttribute('href') ?? '';
        a.removeAttribute('href');
        a.setAttribute('data-md-href', href);
        a.setAttribute('rel', 'noopener noreferrer');
      });

      // 本地图片延迟加载:避免相对路径被 WebView 当成站点 URL
      tpl.content.querySelectorAll('img[src]').forEach((img) => {
        const src = img.getAttribute('src') ?? '';
        if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) return;
        img.removeAttribute('src');
        img.setAttribute('data-md-src', src);
        img.setAttribute('alt', img.getAttribute('alt') ?? '图片');
      });

      const clean = DOMPurify.sanitize(tpl.innerHTML, {
        ADD_ATTR: ['data-md-href', 'data-md-src'],
      });
      this.article.innerHTML = clean;
      this.host.scrollTop = this.scrollByPath.get(path) ?? 0;
      this.loadLocalImages(seq);
    } catch (err) {
      this.article.innerHTML = '';
      const box = document.createElement('div');
      box.className = 'md-reader-error';
      box.textContent = `Markdown 渲染失败: ${String(err)}`;
      this.article.appendChild(box);
    }
  }

  hide(): void {
    if (this.currentPath) this.scrollByPath.set(this.currentPath, this.host.scrollTop);
    this.host.classList.add('hidden');
  }

  private loadLocalImages(seq: number): void {
    const base = this.currentPath;
    this.article.querySelectorAll<HTMLImageElement>('img[data-md-src]').forEach((img) => {
      const rel = img.getAttribute('data-md-src') ?? '';
      const abs = resolveMarkdownPath(base, rel);
      void backend
        .attachRead(abs)
        .then((data) => {
          if (seq !== this.renderSeq) return;
          img.src = data.dataUrl;
          img.removeAttribute('data-md-src');
        })
        .catch(() => {
          if (seq !== this.renderSeq) return;
          img.classList.add('md-image-missing');
          img.title = `无法读取图片: ${abs}`;
        });
    });
  }

  private onClick(ev: MouseEvent): void {
    const target = ev.target as HTMLElement | null;
    const a = target?.closest<HTMLAnchorElement>('a[data-md-href]');
    if (!a) return;
    const href = a.getAttribute('data-md-href') ?? '';
    if (!href) return;
    ev.preventDefault();
    if (href.startsWith('#')) {
      const id = href.slice(1);
      const el = id ? this.article.querySelector<HTMLElement>(`#${CSS.escape(id)}`) : null;
      el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      return;
    }
    if (/^(?:https?:|mailto:)/i.test(href)) {
      void openUrl(href).catch(() => undefined);
      return;
    }
    if (/^(?:javascript:|data:)/i.test(href)) return;
    const abs = resolveMarkdownPath(this.currentPath, href);
    this.opts.openFile(abs);
  }
}
