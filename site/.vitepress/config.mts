import { defineConfig } from 'vitepress'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SITE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SITE, '..', '..')

// 玄铁语法高亮（TextMate 语法由仓库 extensions/xuantie-syntax 提供，sync-docs 复制过来）
let xuantieGrammar = null
try {
  xuantieGrammar = JSON.parse(readFileSync(join(SITE, '..', 'xuantie.tmLanguage.json'), 'utf8'))
} catch {
  console.warn('未找到 xuantie.tmLanguage.json，```xuantie 将回退为纯文本（先跑 npm run sync）')
}

// 关键字速查侧边栏：从仓库 GUIDE/关键字 动态生成（单一内容源，加文档免改配置）
const KW_ORDER = ('设 常 函 返 外 型 口 造 承 覆 弱 此 引 予 公 私 护 ' +
  '若 抑 否 当 循 遍历 于 断 续 异步 等待 并行 道 选 ' +
  '尝试 捕捉 匹配 终 真 假 空 且 或 非 是 ' +
  '整 小数 字 布尔 数组 字典 结果 字节 任务 ' +
  '示 化 解 执 输 求 听 连 位与 位或 异或 左移 右移 取反').split(' ')
function keywordSidebarItems() {
  let files = []
  try {
    files = readdirSync(join(ROOT, 'GUIDE', '关键字')).filter((f) => f.endsWith('.md'))
  } catch { return [] }
  const names = files.map((f) => f.slice(0, -3))
  const ops = names.filter((x) => x.startsWith('运算符-')).sort()
  const main = [
    ...KW_ORDER.filter((k) => names.includes(k)),
    ...names.filter((x) => !KW_ORDER.includes(x) && !x.startsWith('运算符-')).sort(),
  ]
  const toItem = (x) => ({ text: x, link: '/guide/关键字/' + x })
  const items = main.map(toItem)
  if (ops.length) items.push({ text: '运算符', collapsed: true, items: ops.map(toItem) })
  return items
}

// 手册章节：文件名带 01_ 02_ 序号前缀，字典序即章节序；显示名剥掉序号
function manualChapterItems() {
  let files = []
  try {
    files = readdirSync(join(ROOT, 'GUIDE', '手册')).filter((f) => f.endsWith('.md')).sort()
  } catch { return [] }
  return files.map((f) => {
    const name = f.slice(0, -3)
    return { text: name.replace(/^\d+_/, ''), link: '/guide/手册/' + name }
  })
}

// 例程：README 置顶当总览，其余按文件名排序
function exampleItems() {
  let files = []
  try {
    files = readdirSync(join(ROOT, 'GUIDE', '例程')).filter((f) => f.endsWith('.md'))
  } catch { return [] }
  const nameOf = (f) => f.slice(0, -3)
  const rest = files.map(nameOf).filter((x) => x !== 'README').sort()
  const items = [{ text: '例程总览', link: '/guide/例程/README' }]
  for (const x of rest) items.push({ text: x, link: '/guide/例程/' + x })
  return items
}

// API 参考：由仓库 GUIDE/API 动态生成（tools/gen-api.mjs 产出，sync 时一并更新）
function apiItems() {
  let files = []
  try {
    files = readdirSync(join(ROOT, 'GUIDE', 'API')).filter((f) => f.endsWith('.md'))
  } catch { return [] }
  const nameOf = (f) => f.slice(0, -3)
  const rest = files.map(nameOf).filter((x) => x !== 'README').sort((a, b) => a.localeCompare(b, 'zh'))
  const items = [{ text: 'API 总览', link: '/guide/API/README' }]
  for (const x of rest) items.push({ text: x, link: '/guide/API/' + x })
  return items
}

const GUIDE_TITLES = [
  ['01_结果类型与错误处理', '结果类型与错误处理'],
  ['02_类型系统哲学设计', '类型系统哲学设计'],
  ['03_泛型编程指南', '泛型编程指南'],
  ['04_弱引用编程指南', '弱引用编程指南'],
  ['05_模块系统', '模块系统'],
  ['06_数组编程指南', '数组编程指南'],
  ['07_铁铺使用指南', '铁铺使用指南'],
  ['08_网络与并发编程指南', '网络与并发编程指南'],
  ['09_渲染库编程指南', '渲染库编程指南'],
  ['10_运算符重载编程指南', '运算符重载编程指南'],
  ['11_多线程开发深度教程', '多线程开发深度教程'],
  ['12_UI库编程指南', 'UI 库编程指南'],
  ['13_文本库编程指南', '文本库编程指南'],
  ['14_路径库编程指南', '路径库编程指南'],
  ['15_数据结构库编程指南', '数据结构库编程指南'],
]

export default defineConfig({
  lang: 'zh-CN',
  title: '玄铁 XuanTie',
  description: '玄铁：中文系统级编程语言。中文关键字、原生机器码、自举编译器、确定性构建。',
  cleanUrls: true,
  // 源文档里存在历史死链（如 手册 里指向 GUIDE 根的同名文件）；站点先保证可构建，
  // 逐条修源是独立任务（sync-docs 会打印清单）。
  ignoreDeadLinks: true,
  sitemap: { hostname: 'https://xuantie.markjy.com' },
  markdown: {
    languages: xuantieGrammar ? [{ ...xuantieGrammar, name: 'xuantie' }] : [],
    theme: { light: 'vitesse-light', dark: 'vitesse-dark' },
  },
  themeConfig: {
    logo: '/mark-ink.svg',
    nav: [
      { text: '首页', link: '/' },
      { text: '下载', link: '/downloads' },
      { text: '铸造厂 IDE', link: '/ide/' },
      { text: '语言手册', link: '/guide/玄铁语言参考手册' },
      { text: 'API 参考', link: '/guide/API/README' },
      { text: '更新日志', link: '/versionLog' },
      { text: '铁铺包管理', link: '/guide/07_铁铺使用指南' },
      { text: '离线文档', link: '/guide/离线文档' },
    ],
    sidebar: [
      {
        text: '入门',
        items: [{ text: '玄铁语言参考手册', link: '/guide/玄铁语言参考手册' }],
      },
      { text: '手册章节', collapsed: false, items: manualChapterItems() },
      {
        text: '编程指南',
        collapsed: false,
        items: GUIDE_TITLES.map(([f, t]) => ({ text: t, link: '/guide/' + f })),
      },
      { text: '完整例程', collapsed: false, items: exampleItems() },
      { text: 'API 参考', collapsed: false, items: apiItems() },
      { text: '关键字速查', collapsed: true, items: keywordSidebarItems() },
      {
        text: '内部实现',
        collapsed: true,
        items: [
          { text: '种子编译器实现笔记', link: '/guide/种子编译器实现笔记' },
          { text: '自举编译器实现笔记', link: '/guide/自举编译器实现笔记' },
          { text: '铁铺设计笔记', link: '/guide/铁铺设计笔记' },
        ],
      },
      {
        text: '项目',
        items: [
          { text: '更新日志', link: '/versionLog' },
          { text: 'GitHub 仓库', link: 'https://github.com/MARKJY-China/XuanTie-Lang' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/MARKJY-China/XuanTie-Lang' }],
    outline: { level: [2, 3], label: '本页目录' },
    docFooter: { prev: '上一篇', next: '下一篇' },
    lastUpdated: { text: '最后更新' },
    search: { provider: 'local' },
    footer: {
      message: '基于 VitePress 静态构建 · 文档内容与仓库 GUIDE/ 同源',
      copyright: '玄铁 XuanTie By 问号盒',
    },
  },
})
