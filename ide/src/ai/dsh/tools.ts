/**
 * IDE 工具桥 v1:操作当前工程目录的 4 个 DSH 工具。
 * defineTool 由调用方(agent-mode)从懒加载的 @dsh-core 注入,
 * 本文件只做类型级引用,保证面板静态链路不会把 665KB 内核拖进主 chunk。
 *
 * 安全边界:
 * - read_file / list_files:只读,自动放行(不进审批门)。
 * - write_file / run_command:进审批门(逐次弹窗,见 agent-mode.ts 的 approval 配置)。
 * - 一切路径解析后必须落在工程根内(拒绝 ../ 逃逸与根外绝对路径)。
 */
import * as backend from '../../backend'
import type { FileNode } from '../../types'
import type { ToolDefinition } from '@dsh-core'

type DefineTool = typeof import('@dsh-core')['defineTool']

export interface IdeToolsOptions {
  /** 当前工程根(绝对路径) */
  workspace: string
  /** 玄铁语言文档库根(app 数据目录下 docs/;read_file/list_files 对该目录同样放行) */
  docsDir?: string
  /** 官方库根(xtc 邻近 lib/;只读放行,供 AI 直接读库源码查证 API) */
  libDir?: string
  /** write_file 成功落盘后回调(绝对路径,已过 resolveInside 守卫);用于 IDE 刷新文件树/编辑器 */
  onFileWritten?(absPath: string): void
  /** write_file 的行级 diff 结果(执行时算好);面板据此渲染「写入 <路径> +N -M」标题 */
  onWriteDiff?(info: { callId: string; path: string; added: number; removed: number; isNew: boolean }): void
  /** 工程外访问策略:deny=直接拒绝(默认)/ask=逐次审批/allow=自由访问(高风险) */
  fsAccess?(): 'deny' | 'ask' | 'allow'
  /** ask 策略下越界访问的审批回调(返回 true 放行);op 如 "读取"/"写入"/"列目录" */
  requestOutOfScope?(path: string, op: string): Promise<boolean>
  /** xtc 路径(校验工具用;未配置返回 null) */
  getXtcPath?(): Promise<string | null>
}

/** 行级 diff 计数(LCS;任一侧超 5000 行只对前 5000 行算并标注 truncated)。 */
export function lineDiff(
  oldText: string,
  newText: string,
): { added: number; removed: number; truncated: boolean } {
  const MAX = 5000
  // 空串 = 0 行;末尾换行不额外算一行(否则空文件→新文件会误报 -1)
  const toLines = (t: string): string[] => {
    if (t === '') return []
    const s = t.endsWith('\n') ? t.slice(0, -1) : t
    return s === '' ? [] : s.split('\n')
  }
  let oldLines = toLines(oldText)
  let newLines = toLines(newText)
  const truncated = oldLines.length > MAX || newLines.length > MAX
  if (truncated) {
    oldLines = oldLines.slice(0, MAX)
    newLines = newLines.slice(0, MAX)
  }
  const n = oldLines.length
  const m = newLines.length
  // LCS 长度:added = m - L,removed = n - L
  let prev = new Array<number>(m + 1).fill(0)
  let curr = new Array<number>(m + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      curr[j] =
        oldLines[i - 1] === newLines[j - 1]
          ? (prev[j - 1] as number) + 1
          : Math.max(prev[j] as number, curr[j - 1] as number)
    }
    ;[prev, curr] = [curr, prev]
  }
  const lcs = prev[m] as number
  return { added: m - lcs, removed: n - lcs, truncated }
}

/** 需要逐次人工批准的工具名(审批门按名匹配)。 */
export const APPROVAL_GATED_TOOLS: ReadonlySet<string> = new Set(['write_file', 'run_command'])

const READ_TRUNCATE_CHARS = 64 * 1024
const OUTPUT_TRUNCATE_CHARS = 24 * 1024
const LIST_MAX_ENTRIES = 2000

/** 解析模型给出的路径为允许根(工程根 / 玄铁文档库根)内的绝对路径;越界即抛错(宁可报错不静默)。 */
function resolveInside(roots: readonly string[], input: string): string {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/[\\]+$/, '').toLowerCase()
  const raw = input.trim()
  if (!raw) throw new Error('路径不能为空')
  const isAbs = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/')
  const tryJoin = (root: string): string => {
    const joined = isAbs ? raw : `${root}\\${raw}`
    // 手工归一化:统一分隔符、消解 . 与 ..(不触文件系统,纯字符串)
    const parts = joined.replace(/\//g, '\\').split('\\')
    const out: string[] = []
    for (const part of parts) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (out.length <= 1) return ''
        out.pop()
        continue
      }
      out.push(part)
    }
    return out.join('\\')
  }
  for (const root of roots) {
    if (!root) continue
    const resolved = tryJoin(root)
    if (!resolved) continue
    const nr = norm(root)
    const rl = resolved.toLowerCase()
    if (rl === nr || rl.startsWith(nr + '\\')) return resolved
  }
  const rootsShown = roots.filter((r) => r).join('  |  ')
  throw new Error(`路径不在允许范围内: ${input}
允许的根: ${rootsShown || '(无)'}`)
}

function truncate(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text
  return `${text.slice(0, limit)}\n…[${what}过长已截断:共 ${text.length} 字符,只显示前 ${limit}]`
}

function renderTree(nodes: FileNode[], depth: number, prefix: string, budget: { left: number }): string {
  if (depth < 0 || budget.left <= 0) return ''
  let out = ''
  for (const node of nodes) {
    if (budget.left <= 0) break
    budget.left -= 1
    out += `${prefix}${node.name}${node.isDir ? '/' : ''}\n`
    if (node.isDir && node.children.length > 0 && depth > 0) {
      out += renderTree(node.children, depth - 1, `${prefix}  `, budget)
    }
  }
  return out
}

/** 构建 v1 工具集;defineTool 注入自懒加载的 @dsh-core。 */
export function createIdeTools(defineTool: DefineTool, options: IdeToolsOptions): ToolDefinition[] {
  const { workspace, docsDir, libDir, onFileWritten, onWriteDiff } = options
  // 只读白名单:工程根 + 文档库 + 官方库(write_file 不受影响,仍只限工程根)
  const allowedRoots: readonly string[] = [
    workspace,
    ...(docsDir ? [docsDir] : []),
    ...(libDir ? [libDir] : []),
  ]

  const isAbsPath = (p: string): boolean =>
    /^[A-Za-z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')
  /** 越界路径的绝对化(相对路径按工程根解释;'.' 特判工程根) */
  const absolutize = (input: string): string => {
    const raw = input.trim()
    if (isAbsPath(raw)) return raw
    if (raw === '.' || raw === '') return workspace
    return `${workspace}\\${raw}`
  }
  /** 路径解析(异步):根内直通;越界按 fsAccess 策略——禁止=原报错 / 允许=放行 / 询问=弹审批后放行 */
  const resolvePath = async (roots: readonly string[], input: string, op: string): Promise<string> => {
    try {
      return resolveInside(roots, input)
    } catch (err) {
      const mode = options.fsAccess?.() ?? 'deny'
      if (mode === 'deny') throw err
      const abs = absolutize(input)
      if (mode === 'allow') return abs
      if (!options.requestOutOfScope) throw err
      const ok = await options.requestOutOfScope(abs, op)
      if (!ok) throw new Error(`用户拒绝访问工作区外路径(${op}): ${input}`)
      return abs
    }
  }

  /** 目录尾斜杠剥离(校验内核拼临时文件名用) */
  const trimDir = (p: string): string => p.replace(/[\\/]+$/, '')

  /**
   * xtc 快速校验内核:代码写入工程 .foundry/ 临时文件 → `xtc tie -jc`(仅检查,约 0.5s)
   * 或 `xtc pao`(编译并运行,产物落缓存自动清理) → 返回输出 → 删除临时文件。
   * 绝不污染工程根(AI 实测教训:残留 _captest.xt 于工程根)。
   */
  const runXtcOnCode = async (code: string, run: boolean): Promise<string> => {
    const xtc = (await options.getXtcPath?.()) ?? null
    if (!xtc) return '未找到 xtc 编译器(设置 → 工具链路径),无法校验'
    const sc = `${trimDir(workspace)}/.foundry`
    const file = `${sc}/校验_${Date.now()}.xt`
    try {
      if (!(await backend.fsExists(sc))) await backend.fsCreateDir(sc)
      await backend.fsWriteFile(file, code)
      const args = run ? ['pao', file] : ['tie', file, '-jc']
      const res = await backend.execCapture(xtc, args, trimDir(workspace), 90)
      const out = [res.stdout, res.stderr].map((x) => x.trim()).filter(Boolean).join('\n')
      const okNote = res.status === 0 ? (run ? '编译并运行成功' : '检查通过(词法/语法/语义)') : `未通过(退出码 ${res.status})`
      const timeoutNote = res.timedOut ? ' [超时强制终止]' : ''
      return `${run ? '编译并运行(xtc pao)' : '编译检查(xtc -jc)'}:${okNote}${timeoutNote}\n${out || '(无输出)'}`
    } catch (e) {
      return `校验失败(工具层): ${e instanceof Error ? e.message : String(e)}`
    } finally {
      try {
        await backend.fsDelete(file)
      } catch {
        // 临时文件删除失败不影响结论(文件在 .foundry/ 内,不污染工程根)
      }
    }
  }

  const readFile = defineTool({
    name: 'read_file',
    description: '读取工程内一个文件的内容(相对工程根的路径;超长会截断并注明)',
    parameters: { path: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { path: string }) {
      const abs = await resolvePath(allowedRoots, args.path, '读取')
      const { text } = await backend.fsReadFile(abs)
      return truncate(text, READ_TRUNCATE_CHARS, '文件')
    },
  })

  const listFiles = defineTool({
    name: 'list_files',
    description: '列出工程内一个目录的文件树(默认工程根,depth 默认 2 层)',
    parameters: {
      path: { type: 'string' },
      depth: { type: 'integer' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { path?: string; depth?: number }) {
      const abs = await resolvePath(allowedRoots, args.path ?? '.', '列目录')
      const depth = Math.max(0, Math.min(args.depth ?? 2, 6))
      const tree = await backend.fsListTree(abs)
      const budget = { left: LIST_MAX_ENTRIES }
      const body = renderTree(tree, depth, '', budget)
      const suffix = budget.left <= 0 ? '\n…[条目过多已截断]' : ''
      return body.length > 0 ? body + suffix : '(空目录)'
    },
  })

  const writeFile = defineTool({
    name: 'write_file',
    description: '把完整内容写入工程内一个文件(不存在则创建;覆盖写,需用户逐次批准)',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { path: string; content: string }, exec: { callId?: string }) {
      // write_file 默认只允许工程根(文档库只读);fsAccess=allow/ask 时按同一策略放行工程外
      const abs = await resolvePath([workspace], args.path, '写入')
      // 写前读旧内容算行级 diff(读不到 = 新文件)
      let diff: { added: number; removed: number; isNew: boolean } | undefined
      try {
        const old = await backend.fsReadFile(abs)
        const d = lineDiff(old.text, args.content)
        diff = { added: d.added, removed: d.removed, isNew: false }
      } catch {
        diff = { added: args.content.split('\n').length, removed: 0, isNew: true }
      }
      await backend.fsWriteFile(abs, args.content)
      // 守卫通过且落盘成功才通知(工程外路径在 resolveInside 已抛错,到不了这里)
      onFileWritten?.(abs)
      if (onWriteDiff && exec.callId) {
        onWriteDiff({ callId: exec.callId, path: args.path, ...diff })
      }
      // .xt 文件写后即编译校验(约 0.5s):把错误从"下一轮编译"提前到"写下即知"
      let checkNote = ''
      if (abs.toLowerCase().endsWith('.xt')) {
        const xtc = (await options.getXtcPath?.()) ?? null
        if (xtc) {
          try {
            const res = await backend.execCapture(xtc, ['tie', abs, '-jc'], trimDir(workspace), 60)
            if (res.status === 0) {
              checkNote = '\n编译器检查(xtc -jc):未发现问题'
            } else {
              const out = [res.stdout, res.stderr].map((x) => x.trim()).filter(Boolean).join('\n')
              checkNote = `\n编译器检查(xtc -jc)发现问题(退出码 ${res.status}):\n${out}`
            }
          } catch {
            // 校验失败不掩盖写入结果本身
          }
        }
      }
      return `已写入 ${args.path}(${args.content.length} 字符)${checkNote}`
    },
  })

  const exampleSearch = defineTool({
    name: 'example_search',
    description:
      '检索可直接抄改的完整玄铁代码示例(本地官方文档的代码块,按关键词命中数排序返回完整片段,' +
      '标明来源文件与行号)。需要"某个功能怎么写"的完整模板时优先用它(比 docs_search 更直接);' +
      '不熟悉某个库/语法时先抄示例改,而不是凭记忆推演。',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { query: string }) {
      const q = args.query.trim()
      if (!q) throw new Error('query 不能为空')
      return await backend.docsExamples(q)
    },
  })

  const checkCode = defineTool({
    name: 'check_code',
    description:
      '编译校验一段玄铁代码(约 0.5 秒):代码写入工程 .foundry/ 下临时文件,校验后即删除,' +
      '绝不污染工程根。不确定语法/库用法时先验证再写正式文件;run=true 时编译并运行(xtc pao)' +
      '返回真实运行输出,用于验证运行行为。禁止用 run_command 在工程根手写探针测试文件。',
    parameters: {
      code: { type: 'string', required: true },
      run: { type: 'boolean' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { code: string; run?: boolean }) {
      const code = args.code
      if (!code.trim()) throw new Error('code 不能为空')
      return await runXtcOnCode(code, args.run === true)
    },
  })

  const runCommand = defineTool({
    name: 'run_command',
    description: '在工程根目录执行一条 shell 命令(cmd /c,捕获输出,默认 120 秒超时,需用户逐次批准)',
    parameters: {
      command: { type: 'string', required: true },
      timeout_secs: { type: 'integer' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args: { command: string; timeout_secs?: number }) {
      const r = await backend.execCapture('cmd', ['/c', args.command], workspace, args.timeout_secs ?? 120)
      const parts: string[] = []
      if (r.stdout) parts.push(`stdout:\n${truncate(r.stdout, OUTPUT_TRUNCATE_CHARS, 'stdout')}`)
      if (r.stderr) parts.push(`stderr:\n${truncate(r.stderr, OUTPUT_TRUNCATE_CHARS, 'stderr')}`)
      if (r.timedOut) parts.push('[超时被强制终止]')
      parts.push(`exit code: ${r.status}`)
      return parts.join('\n')
    },
  })

  const webFetch = defineTool({
    name: 'web_fetch',
    description:
      '打开一个 URL 并返回网页正文文本(HTML 剥标签/实体反转义/压缩空白,截断 12000 字符)。' +
      '支持普通网页与 JavaScript 渲染的 SPA 站点(自动用内嵌浏览器渲染,输出会标注 [静态抓取] 或 [浏览器渲染])。' +
      '当用户给出链接、要求"看一下/访问/打开/查看"某网页、或需要阅读搜索结果全文时,直接调用本工具——' +
      '不要以"我无法浏览网页"为由拒绝。只读网络 GET,仅支持 https。',
    parameters: {
      url: { type: 'string', required: true },
      render: {
        type: 'string',
        description: '渲染模式:auto(默认,静态抓取不足时自动用浏览器渲染)/always(强制浏览器渲染)/never(仅静态抓取)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { url: string; render?: string }) {
      const url = args.url.trim()
      if (!url) throw new Error('url 不能为空')
      const mode = args.render === 'always' || args.render === 'never' ? args.render : undefined
      return await backend.webFetch(url, mode)
    },
  })

  const docsSearch = defineTool({
    name: 'docs_search',
    description:
      '在本地玄铁语言文档库中按关键词精确检索(全文逐行匹配,返回 文档:行号 与命中行片段)。' +
      '查询玄铁语法/关键字/标准库用法/编译选项时先用它定位(比通读索引更精确),' +
      '再对命中的文档用 read_file 精读。只读操作,无需审批。',
    parameters: {
      query: { type: 'string', required: true },
      max_results: { type: 'number', description: '返回条数上限(默认 20,最大 50)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { query: string; max_results?: number }) {
      const q = args.query.trim()
      if (!q) throw new Error('query 不能为空')
      return await backend.docsSearch(q, args.max_results)
    },
  })

  const webSearch = defineTool({
    name: 'web_search',
    description:
      '联网搜索(必应)。返回结果列表(标题 / URL / 摘要)。当需要最新信息、事实核查、找官网或资料时先调用本工具,' +
      '再对结果中的链接调用 web_fetch 打开全文阅读。只读网络请求,无需审批。',
    parameters: { query: { type: 'string', required: true } },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    isConcurrencySafe: () => true,
    async execute(args: { query: string }) {
      const q = args.query.trim()
      if (!q) throw new Error('query 不能为空')
      return await backend.webSearch(q)
    },
  })

  return [readFile, listFiles, writeFile, runCommand, webFetch, webSearch, docsSearch, exampleSearch, checkCode]
}

/** run_command 白名单匹配键:命令行首个 token(程序名)。 */
export function commandToken(command: string): string {
  return command.trim().split(/\s+/)[0] ?? ''
}

/**
 * 工具卡片参数区的展示格式化(与 approvalPreview 同源参数,不搞两套):
 * run_command → 命令行文本;read_file → 路径;write_file → 路径(内容 N 字符);
 * list_files → 路径(深度 N);未知工具回落原始 JSON。
 * ToolRecord.args 仍存原始 JSON,本函数只用于展示层。
 */
export function formatToolArgs(toolName: string, argsJson: string): string {
  let args: Record<string, unknown>
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>
  } catch {
    return argsJson
  }
  switch (toolName) {
    case 'run_command':
      return String(args.command ?? argsJson)
    case 'read_file':
      return String(args.path ?? argsJson)
    case 'write_file': {
      const path = String(args.path ?? '')
      const chars = String(args.content ?? '').length
      return `${path}(内容 ${chars} 字符)`
    }
    case 'list_files':
      return `${String(args.path ?? '.')}(深度 ${String(args.depth ?? 2)})`
    case 'web_fetch':
      return String(args.url ?? argsJson)
    case 'web_search':
      return String(args.query ?? argsJson)
    case 'docs_search':
      return String(args.query ?? argsJson)
    default:
      return argsJson
  }
}

/** 审批门用的弹窗内容:按工具生成摘要与详情预览。 */
export function approvalPreview(toolName: string, args: unknown): { summary: string; detail: string } {  const a = (args ?? {}) as Record<string, unknown>
  if (toolName === 'write_file') {
    const path = String(a.path ?? '')
    const content = String(a.content ?? '')
    return {
      summary: `Agent 请求写入文件: ${path}`,
      detail: `路径: ${path}\n\n内容(前 500 字):\n${content.slice(0, 500)}${content.length > 500 ? '\n…' : ''}`,
    }
  }
  if (toolName === 'run_command') {
    return {
      summary: 'Agent 请求执行 shell 命令',
      detail: String(a.command ?? ''),
    }
  }
  return { summary: `Agent 请求调用工具: ${toolName}`, detail: JSON.stringify(args, null, 2) }
}
