#!/usr/bin/env node
// 从 GUIDE 文档生成铸造厂内置「API 文档书」数据。
// 输出:ide/src/docs/api-docs.generated.ts
// 覆盖:GUIDE/API/*.md(库 API)、GUIDE/关键字/*.md(语言内建)、手册/06_标准库与RuntimeAPI.md。
// 方法索引从 Markdown 表格与正文里的 `接收者.方法(...)` 代码片段提取,
// 供悬停与 Ctrl+点击跳文档使用。
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'ide', 'src', 'docs', 'api-docs.generated.ts');

const SOURCES = [
  { dir: join(ROOT, 'GUIDE', 'API'), group: '库 API', idPrefix: 'API' },
  { dir: join(ROOT, 'GUIDE', '关键字'), group: '语言内建', idPrefix: '关键字' },
  {
    file: join(ROOT, 'GUIDE', '手册', '06_标准库与RuntimeAPI.md'),
    group: '手册',
    id: '手册/06_标准库与RuntimeAPI',
  },
];

const PAGE_TYPE = {
  '关键字/字节': '字节',
  '关键字/数组': '数组',
  '关键字/字符串': '字符串',
  '关键字/字': '字符串',
  '关键字/字典': '字典',
  '关键字/结果': '结果',
  '关键字/文件': '文件',
  '关键字/系统': '系统',
  '关键字/时': '时',
  '关键字/数学': '数学',
  '关键字/进程': '进程',
};

const KIND_PRIORITY = { override: 0, table: 1, prose: 2 };

function cleanInline(s) {
  return s
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleOf(md, fallback) {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? cleanInline(m[1]) : fallback;
}

function slugify(s) {
  return cleanInline(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
}

/** 解析代码片段里的 `接收者.方法(参数)` 或 `接收者.属性`;不是成员形态返回 null。 */
function parseMemberCode(code) {
  const s = code.trim();
  const m = /^([\p{L}_][\p{L}\p{N}_]*)\s*\.\s*([\p{L}_][\p{L}\p{N}_]*[?？]?)\s*(?:\(([^)]*)\))?$/u.exec(s);
  if (!m) return null;
  return {
    receiver: m[1],
    name: m[2].replace('？', '?'),
    signature: s,
    args: m[3] ?? null,
  };
}

const METHOD_OVERRIDES = [
  {
    name: '追加',
    pageId: '关键字/数组',
    displayReceiver: '数组',
    signature: '列表.追加(元素)',
    summary: '在数组末尾追加一个元素；容量不足自动扩容。',
    heading: '数组',
  },
  {
    name: '追加',
    pageId: '关键字/字节',
    displayReceiver: '字节',
    signature: 'b.追加(字节值)',
    summary: '向字节集末尾追加一个字节值 0-255；容量不足自动扩容。',
    heading: '字节集方法',
  },
  {
    name: '截取',
    pageId: '关键字/字节',
    displayReceiver: '字节',
    signature: 'b.截取(起, 止?)',
    summary: '按字节下标截取，左闭右开；止缺省到尾。',
    heading: '字节集方法',
  },
  {
    name: '取字节',
    pageId: '关键字/字节',
    displayReceiver: '字节',
    signature: 'b.取字节(位置)',
    summary: '取指定字节位置的值 0-255；越界返回 -1。',
    heading: '字节集方法',
  },
  {
    name: '写字节',
    pageId: '关键字/字节',
    displayReceiver: '字节',
    signature: 'b.写字节(位置, 值)',
    summary: '就地写指定字节；越界或值域外返回 假。',
    heading: '字节集方法',
  },
];

function collectMethods(page) {
  const lines = page.markdown.split(/\r?\n/);
  const byPageName = new Map();
  let heading = '';
  let headingAnchor = '';
  let inFence = false;

  const displayReceiver = (receiver) => PAGE_TYPE[page.id] ?? receiver;
  const push = (code, summary, kind) => {
    const parsed = parseMemberCode(code);
    if (!parsed) return;
    if (!summary || /方法缺失/.test(summary)) return;
    const key = `${page.id}|${parsed.name}`;
    const entry = {
      name: parsed.name,
      receiver: displayReceiver(parsed.receiver),
      signature: parsed.signature,
      summary,
      pageId: page.id,
      pageTitle: page.title,
      group: page.group,
      heading,
      anchor: headingAnchor,
      kind,
    };
    const prev = byPageName.get(key);
    if (prev && KIND_PRIORITY[prev.kind] <= KIND_PRIORITY[kind]) return;
    byPageName.set(key, entry);
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const hm = /^(#{1,6})\s+(.+)$/.exec(line);
    if (hm) {
      heading = cleanInline(hm[2]);
      headingAnchor = slugify(heading);
      continue;
    }
    if (/^\|/.test(line)) {
      const cells = line
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) continue;
      const codes = [];
      for (const cell of cells) {
        for (const cm of cell.matchAll(/`([^`]+)`/g)) codes.push(cm[1]);
      }
      if (codes.length === 0) continue;
      const signature = codes.find((c) => parseMemberCode(c));
      if (!signature) continue;
      const parsed = parseMemberCode(signature);
      const summary = cells
        .map(cleanInline)
        .filter((c) => c && c !== parsed.signature)
        .join(' · ');
      push(signature, summary, 'table');
      continue;
    }
    if (line === '') continue;
    // 正文里的内联代码:表格没有的方法做兜底索引(摘要用整行)
    for (const cm of raw.matchAll(/`([^`]+)`/g)) {
      push(cm[1], cleanInline(raw), 'prose');
    }
  }
  return [...byPageName.values()];
}

const pages = [];
const methods = [];
for (const src of SOURCES) {
  if (src.file) {
    if (!existsSync(src.file)) continue;
    const md = readFileSync(src.file, 'utf8');
    const page = { id: src.id, title: titleOf(md, '标准库与 Runtime API'), group: src.group, markdown: md };
    pages.push(page);
    methods.push(...collectMethods(page));
    continue;
  }
  if (!existsSync(src.dir)) continue;
  for (const name of readdirSync(src.dir)) {
    if (!name.endsWith('.md')) continue;
    const full = join(src.dir, name);
    if (!statSync(full).isFile()) continue;
    const md = readFileSync(full, 'utf8');
    const id = `${src.idPrefix}/${name.replace(/\.md$/, '')}`;
    const page = { id, title: titleOf(md, name.replace(/\.md$/, '')), group: src.group, markdown: md };
    pages.push(page);
    methods.push(...collectMethods(page));
  }
}

// 手工补齐正文里描述、表格里没有独立行的核心方法
for (const o of METHOD_OVERRIDES) {
  const page = pages.find((p) => p.id === o.pageId);
  if (!page) continue;
  const i = methods.findIndex((m) => m.pageId === o.pageId && m.name === o.name);
  const entry = {
    name: o.name,
    receiver: o.displayReceiver,
    signature: o.signature,
    summary: o.summary,
    pageId: page.id,
    pageTitle: page.title,
    group: page.group,
    heading: o.heading,
    anchor: slugify(o.heading),
    kind: 'override',
  };
  if (i >= 0) methods[i] = entry;
  else methods.push(entry);
}

const groupOrder = { 语言内建: 0, '库 API': 1, 手册: 2 };
pages.sort(
  (a, b) => (groupOrder[a.group] ?? 9) - (groupOrder[b.group] ?? 9) || a.id.localeCompare(b.id, 'zh-CN'),
);
const pageIndex = new Map(pages.map((p, i) => [p.id, i]));
methods.sort(
  (a, b) =>
    (pageIndex.get(a.pageId) ?? 999) - (pageIndex.get(b.pageId) ?? 999) ||
    a.name.localeCompare(b.name, 'zh-CN') ||
    a.receiver.localeCompare(b.receiver, 'zh-CN'),
);

mkdirSync(dirname(OUT), { recursive: true });
const header =
  '// 由 tools/gen-ide-api-docs.mjs 从 GUIDE/API、GUIDE/关键字、GUIDE/手册 生成,请勿手改。\n' +
  '// 重新生成:node tools/gen-ide-api-docs.mjs\n';
const body =
  'export interface DocPage { id: string; title: string; group: string; markdown: string }\n' +
  'export interface MethodDoc { name: string; receiver: string; signature: string; summary: string; pageId: string; pageTitle: string; group: string; heading: string; anchor: string; kind: string }\n' +
  `export const DOC_PAGES: DocPage[] = ${JSON.stringify(pages)};\n` +
  `export const METHOD_DOCS: MethodDoc[] = ${JSON.stringify(methods)};\n`;
writeFileSync(OUT, header + body, 'utf8');
console.log(`[ide-api-docs] ${pages.length} 页, ${methods.length} 条方法索引 → ${OUT}`);
console.log(
  `[ide-api-docs] 示例: ${['追加', '截取', '取字节', '写字节']
    .flatMap((name) => methods.filter((m) => m.name === name).map((m) => `${m.receiver}.${m.name}`))
    .join(', ')}`,
);
