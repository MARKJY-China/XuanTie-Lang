/**
 * 引用徽章后处理(纯函数,Node 可测;DOM 无关)。
 * md() 渲染出的 HTML 里,模型按提示词标注的 〔N〕 替换为小徽章 span;
 * pre/code 块内不替换;N 无对应 source 时保持原文本。
 */

/** 联网搜索引用源(服务端 sources 事件同构)。 */
export interface CiteSource {
  i: number
  title: string
  url: string
  snippet: string
}

export function citeBadgesHtml(html: string, sources: CiteSource[] | undefined): string {
  if (!sources || sources.length === 0 || !html.includes('〔')) return html
  const set = new Set(sources.map((x) => x.i))
  // 按 pre/code 块切分(奇数段为受保护块),只处理块外
  const parts = html.split(/(<pre[\s\S]*?<\/pre>|<code[\s\S]*?<\/code>)/g)
  return parts
    .map((part, idx) => {
      if (idx % 2 === 1) return part
      return part.replace(/〔(\d+)〕/g, (m, g: string) =>
        set.has(Number(g)) ? `<span class="ai-cite" data-i="${g}">${g}</span>` : m,
      )
    })
    .join('')
}
