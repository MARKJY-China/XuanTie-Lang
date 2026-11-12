// 中文输入法自动切换
//
// 规则(默认开启,可在设置关闭):
//   1. 光标在字符串字面量内 → 切中文输入;光标在代码区 → 切英文输入;
//   2. 字符串内用英文模式敲了冒号 ":" → 立即切回中文(下一个字符按中文输入)。
//
// 实现要点:
//   - 用 Monaco 的 tokenize(整篇、带状态)判断光标是否在 string token 里,按文档版本缓存;
//   - 真正的模式切换在 Rust(Windows IMM32),第三方输入法可能不支持,失败静默降级;
//   - 只在状态变化时调用后端,避免每次光标移动都跨进程。

import * as monaco from 'monaco-editor'
import * as backend from './backend'
import { getSettings } from './settings'
import { XT_LANGUAGE_ID } from './lang/xt'

type Tok = { startIndex: number; type: string }

interface TokCache {
  version: number
  lines: Tok[][]
}

const tokenCache = new WeakMap<monaco.editor.ITextModel, TokCache>()

function tokensOf(model: monaco.editor.ITextModel): Tok[][] {
  const hit = tokenCache.get(model)
  if (hit && hit.version === model.getVersionId()) return hit.lines
  const lines = monaco.editor.tokenize(model.getValue(), XT_LANGUAGE_ID) as unknown as Tok[][]
  tokenCache.set(model, { version: model.getVersionId(), lines })
  return lines
}

/** 光标是否落在字符串字面量内(#{...} 插值按代码区处理,不切中文) */
export function inStringLiteral(
  model: monaco.editor.ITextModel,
  pos: monaco.IPosition,
): boolean {
  const lines = tokensOf(model)
  const tokens = lines[pos.lineNumber - 1]
  if (!tokens || tokens.length === 0) return false
  let type = ''
  const col = pos.column - 1
  for (const t of tokens) {
    if (t.startIndex <= col) type = t.type
    else break
  }
  if (!type.includes('string')) return false
  if (type.includes('interp')) return false
  return true
}

export function initImeAutoSwitch(editor: monaco.editor.IStandaloneCodeEditor): void {
  let last: boolean | null = null
  let timer = 0

  const enabled = (): boolean => getSettings().imeAutoSwitch !== false

  const apply = (want: boolean): void => {
    if (!enabled() || last === want) return
    last = want
    void backend.imeSetMode(want).catch(() => undefined)
  }

  const sync = (): void => {
    const model = editor.getModel()
    const pos = editor.getPosition()
    if (!model || !pos) return
    apply(inStringLiteral(model, pos))
  }

  const schedule = (): void => {
    window.clearTimeout(timer)
    timer = window.setTimeout(sync, 40)
  }

  editor.onDidChangeCursorPosition(() => sync())
  editor.onDidChangeModelContent((e) => {
    // 字符串内敲冒号(英文模式才是 ASCII ':'):回中文
    for (const c of e.changes) {
      if (c.text === ':') {
        const model = editor.getModel()
        const pos = editor.getPosition()
        if (model && pos && enabled() && inStringLiteral(model, pos)) apply(true)
        break
      }
    }
    schedule()
  })
  editor.onDidChangeModel(() => {
    last = null
    schedule()
  })
  editor.onDidFocusEditorText(() => {
    last = null
    sync()
  })
}
