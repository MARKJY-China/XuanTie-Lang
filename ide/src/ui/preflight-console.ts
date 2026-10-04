/**
 * 玄铁环境校验控制台(浮层):CI 式实时日志——stage 分隔行 + [编译]/[探针] 输出行。
 * 双击状态栏「本地玄铁环境…」项开合;校验进行中实时追加,结束后保留供查看。
 * 数据源:Rust preflight_run 的 preflight-progress 事件(见 main.ts 接线)。
 */

const MAX_LINES = 5000

export class PreflightConsole {
  private root: HTMLElement
  private logEl: HTMLElement
  private statusEl: HTMLElement
  private open = false

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'pf-mask hidden'
    const card = document.createElement('div')
    card.className = 'pf-card'
    const head = document.createElement('div')
    head.className = 'pf-head'
    const ico = document.createElement('i')
    ico.className = 'codicon codicon-beaker'
    const title = document.createElement('span')
    title.className = 'pf-title'
    title.textContent = '玄铁环境校验'
    this.statusEl = document.createElement('span')
    this.statusEl.className = 'pf-status'
    this.statusEl.textContent = '待命'
    const close = document.createElement('button')
    close.className = 'pf-close'
    close.innerHTML = '<i class="codicon codicon-close"></i>'
    close.title = '关闭(不影响后台校验)'
    close.addEventListener('click', () => this.hide())
    head.append(ico, title, this.statusEl, close)
    this.logEl = document.createElement('div')
    this.logEl.className = 'pf-log'
    card.append(head, this.logEl)
    this.root.appendChild(card)
    document.body.appendChild(this.root)
  }

  /** 开始一轮校验:清空日志,状态置"校验中…"。 */
  begin(): void {
    this.logEl.innerHTML = ''
    this.statusEl.textContent = '校验中…'
    this.statusEl.classList.remove('ok', 'bad')
    this.stage('开始校验本地玄铁环境')
  }

  stage(text: string): void {
    const el = document.createElement('div')
    el.className = 'pf-stage'
    el.textContent = `── ${text} ──`
    this.append(el)
  }

  line(tag: string, text: string): void {
    const el = document.createElement('div')
    el.className = 'pf-line'
    const t = document.createElement('span')
    t.className = 'pf-tag'
    t.textContent = tag
    t.dataset.tag = tag
    const txt = document.createElement('span')
    txt.textContent = text
    el.append(t, txt)
    this.append(el)
  }

  finish(ok: boolean, ms: number): void {
    this.statusEl.textContent = ok ? `通过 · ${ms} ms` : `未通过 · ${ms} ms`
    this.statusEl.classList.add(ok ? 'ok' : 'bad')
    this.stage(ok ? '校验完成:全部通过' : '校验完成:存在未通过项(详见上方日志)')
  }

  toggle(): void {
    if (this.open) this.hide()
    else this.show()
  }

  show(): void {
    this.open = true
    this.root.classList.remove('hidden')
    this.logEl.scrollTop = this.logEl.scrollHeight
  }

  hide(): void {
    this.open = false
    this.root.classList.add('hidden')
  }

  private append(el: HTMLElement): void {
    this.logEl.appendChild(el)
    while (this.logEl.childElementCount > MAX_LINES) {
      this.logEl.firstElementChild?.remove()
    }
    this.logEl.scrollTop = this.logEl.scrollHeight
  }
}
