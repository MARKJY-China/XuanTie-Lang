<script setup>
// 玄铁铸造厂落地页（原 public/ide/index.html 的等价实现）
//
// 为什么搬进 VitePress：该页原先只是 public/ 下的静态文件，不在 VitePress 路由表里，
// 站内任何 <a href="/ide/"> 都会被 SPA 路由拦截 → 渲染 404（服务器其实是 200）。
// 变成真正的页面路由（ide/index.md + layout:false）后，站内跳转与硬刷新都走同一份产物。
//
// 内容由玄铁社区后台「官网」Tab 配置，运行时拉取覆盖；默认值**在构建期就渲进 HTML**
// （SSR），所以 API 失败或首屏未返回时，页面也是完整可读的。
import { ref, computed, onMounted } from 'vue'
import XtMark from './XtMark.vue'

const GITHUB_RELEASES = 'https://github.com/MARKJY-China/XuanTie-Lang/releases'
const API = 'https://bbs.xt.markjy.com/api/site/ide'

const DEFAULT_FEATS = [
  ['智器对话 AI', '内置官方 AI 通道，支持图片/视频多模态、联网搜索与玄铁文档学习，开箱即聊。'],
  ['Agent 能干活', 'DSH Agent 内核：读写工程文件、执行命令、联网检索，危险操作逐次审批。'],
  ['玄铁语言服务', '补全 / 悬停 / 跳转定义 / 大纲 / 诊断，Monaco 全中文界面。'],
  ['环境自检', '打开工程自动校验本地工具链与基础语义，缺什么、错哪里一目了然。'],
  ['一键编译运行', '编译当前文件或整个工程，产物直入 build/，输出进独立构建面板。'],
  ['工程与铁铺', '新建工程模板、铁铺包管理、会话与界面偏好全按工程记忆。'],
]

// 编辑器右侧 minimap 的色块（宽度 + 取色类）：纯装饰，模拟代码轮廓
const MINIMAP = [
  [30, 'k'], [26, 'v'], [8, ''], [18, 't'], [24, 'v'], [22, 'v'], [8, ''],
  [20, 'k'], [26, 'v'], [14, 'v'], [30, 'k'], [8, ''], [18, 'v'], [28, 'v'],
  [16, 'v'], [18, 'v'], [14, 'v'], [10, ''], [20, 'v'], [8, 'k'],
]

const version = ref('v0.3.1')
const tagline = ref('中文编程语言的第一方 IDE')
const note = ref('内置智器对话 AI 与 DSH Agent 内核——读代码、写文件、跑命令、查文档，开箱即用；玄铁语言服务、环境自检、一键编译运行完整就位。')
const date = ref('')
const files = ref([])
const feats = ref(DEFAULT_FEATS)

// 后端给了直链就指向对象存储（国内直连），否则退回 GitHub Releases
const mainHref = computed(() => (files.value.length ? files.value[0].url : GITHUB_RELEASES))
const mainText = computed(() => (files.value.length ? '下载 ' + (files.value[0].label || '安装包') : '下载 Windows 版'))
const mainTarget = computed(() => (files.value.length ? null : '_blank'))
const metaText = computed(() => {
  if (files.value.length) {
    const m = [date.value, files.value[0].size].filter(Boolean).join(' · ')
    return m || '安装即用 · 自动探测本地 xtc 工具链'
  }
  return '安装即用 · 自动探测本地 xtc 工具链'
})
const moreFiles = computed(() => files.value.slice(1))

function applyFeats(highlights) {
  if (!Array.isArray(highlights) || !highlights.length) return
  feats.value = highlights.map((s) => {
    const i = String(s).indexOf(':')
    return i > 0 ? [String(s).slice(0, i), String(s).slice(i + 1)] : [String(s), '']
  })
}

onMounted(async () => {
  try {
    const r = await fetch(API)
    const j = await r.json()
    const cfg = j && j.ok && j.data && j.data.json ? JSON.parse(j.data.json) : null
    if (!cfg) return
    if (cfg.version) version.value = cfg.version
    if (cfg.tagline) tagline.value = cfg.tagline
    if (cfg.note) note.value = cfg.note
    if (cfg.date) date.value = cfg.date
    files.value = Array.isArray(cfg.files) ? cfg.files.filter((f) => f && f.url) : []
    applyFeats(cfg.highlights)
  } catch (e) {
    /* 官网与社区域名不同源 / 网络异常：保留构建期默认值 */
  }
})
</script>

<template>
  <div class="fd">
    <div class="fd-wrap">
      <nav class="fd-nav">
        <span class="fd-brand"><XtMark class="fd-brand-mark" :size="20" />玄铁铸造厂 <small>XUANTIE FOUNDRY</small></span>
        <span class="fd-sp"></span>
        <a class="fd-lnk" href="/">文档站</a>
        <a class="fd-lnk" href="https://bbs.xt.markjy.com">社区</a>
        <a class="fd-lnk" href="https://github.com/MARKJY-China/XuanTie-Lang" target="_blank" rel="noopener">GitHub</a>
      </nav>

      <header class="fd-hero">
        <span class="fd-pill"><i></i>预览版 · {{ version }}</span>
        <img class="fd-appblock" src="/app-block.svg" width="64" height="64" alt="玄铁铸造厂 · 玄范" />
        <h1>玄铁铸造厂<span class="en">XUANTIE FOUNDRY</span></h1>
        <p class="fd-tagline">{{ tagline }}</p>
        <p class="fd-sub">{{ note }}</p>
        <div class="fd-cta">
          <a class="fd-btn" :href="mainHref" :target="mainTarget" :rel="mainTarget ? 'noopener' : null">{{ mainText }}</a>
          <span class="fd-meta">{{ metaText }}</span>
          <div v-if="moreFiles.length" class="fd-more">
            <a v-for="f in moreFiles" :key="f.url" :href="f.url">{{ f.label || '其他下载' }}</a>
          </div>
        </div>
      </header>

      <!-- ══════════ 产品界面：当作一张「应用截图」贴在图版里 ══════════ -->
      <figure class="fd-figure">
        <div class="fd-window">
          <!-- 标题栏：应用名 + 菜单 + 运行/铁铺/设置 + 窗口按钮 -->
          <div class="fd-tbar">
            <span class="fd-appicon">玄</span>
            <span class="fd-appname">玄铁</span>
            <div class="fd-menu">
              <span>文件(F)</span><span>编辑(E)</span><span>查看(V)</span><span>编译(B)</span><span>终端(T)</span><span>帮助(H)</span>
            </div>
            <span class="fd-sp"></span>
            <div class="fd-acts">
              <span class="fd-act run">▶ 运行</span>
              <span class="fd-act stop">■ 停止</span>
              <span class="fd-act">铁铺</span>
              <span class="fd-act">设置</span>
              <span class="fd-user">问号盒</span>
            </div>
            <div class="fd-wctl" aria-hidden="true">
              <i class="min"></i><i class="max"></i><i class="close"></i>
            </div>
          </div>

          <!-- 编辑器标签页 -->
          <div class="fd-tabs">
            <span class="fd-tab root">XuanTie</span>
            <span class="fd-tab">主.xt</span>
            <span class="fd-tab on">贪吃蛇.xt <i>✕</i></span>
          </div>

          <!-- 三栏主体 -->
          <div class="fd-body">
            <aside class="fd-tree">
              <div class="fd-row head">我的工程</div>
              <div class="fd-row i1"><i class="fd-fx toml"></i>玄铁.配置.toml</div>
              <div class="fd-row i1 on"><i class="fd-fx xt"></i>贪吃蛇.xt</div>
              <div class="fd-row i1"><i class="fd-fx xt"></i>贪吃蛇-自检.xt</div>
              <div class="fd-row i1 folder"><i class="fd-caret">▾</i><i class="fd-fx dir"></i>lib</div>
              <div class="fd-row i2"><i class="fd-fx xt"></i>渲染.xt</div>
              <div class="fd-row i2"><i class="fd-fx xt"></i>输入.xt</div>
              <div class="fd-row i1 folder"><i class="fd-caret">▸</i><i class="fd-fx dir"></i>build</div>
              <div class="fd-row head">大纲</div>
              <div class="fd-row i1"><i class="fd-fx fn"></i>函 主()</div>
              <div class="fd-row i1"><i class="fd-fx fn"></i>型 蛇</div>
            </aside>

            <main class="fd-editor">
              <div class="fd-code">
                <pre class="fd-ln">1
2
3
4
5
6
7
8
9
10
11
12
13
14
15
16
17
18
19
20</pre>
                <pre class="fd-src"><span class="k">引</span> <span class="s">"lib/渲染/渲染.xt"</span> <span class="k">予</span> <span class="v">R</span>
<span class="k">引</span> <span class="s">"lib/输入/输入.xt"</span> <span class="k">予</span> <span class="v">输入</span>

<span class="t">函</span> <span class="f">主</span>() {
    <span class="t">设</span> <span class="v">蛇</span> = <span class="t">造</span> <span class="f">蛇</span>(<span class="n">3</span>, <span class="n">3</span>)
    <span class="t">设</span> <span class="v">钟</span> = <span class="v">R</span>.<span class="f">创建时钟</span>(<span class="n">60</span>)

    <span class="k">当</span> <span class="k">非</span> <span class="v">R</span>.<span class="f">窗口应关闭?</span>() {
        <span class="v">蛇</span>.<span class="f">按输入转向</span>(<span class="v">输入</span>)
        <span class="v">蛇</span>.<span class="f">前进</span>()
        <span class="k">若</span> <span class="v">蛇</span>.<span class="f">撞墙?</span>(<span class="n">800</span>, <span class="n">600</span>) { <span class="v">蛇</span>.<span class="f">重置</span>() }

        <span class="v">R</span>.<span class="f">开始绘图</span>()
        <span class="v">R</span>.<span class="f">清背景</span>(<span class="n">24</span>, <span class="n">26</span>, <span class="n">34</span>, <span class="n">255</span>)
        <span class="v">蛇</span>.<span class="f">绘制</span>(<span class="v">R</span>)
        <span class="v">R</span>.<span class="f">结束绘图</span>()
        <span class="v">钟</span>.<span class="f">等待</span>()
    }
    <span class="v">R</span>.<span class="f">关闭窗口</span>()
}</pre>
              </div>
              <!-- Monaco 默认开启的 minimap：纯装饰，压住编辑器右侧的空白 -->
              <div class="fd-mini" aria-hidden="true">
                <i v-for="(m, i) in MINIMAP" :key="i" :class="m[1]" :style="{ width: m[0] + 'px' }"></i>
              </div>
            </main>

            <aside class="fd-ai">
              <div class="fd-ai-head">
                <span class="fd-ai-title">智器对话</span>
                <span class="fd-sp"></span>
                <span class="fd-ai-ico">＋</span>
                <span class="fd-ai-ico">⇅</span>
                <span class="fd-ai-ico">⋯</span>
                <span class="fd-ai-ico">✕</span>
              </div>

              <div class="fd-ai-body">
                <div class="fd-msg u">用渲染库写个 60 帧小游戏</div>
                <div class="fd-think">▾ 思考过程 · 2.1s</div>

                <div class="fd-tool">
                  <div class="fd-tool-row">
                    <span class="fd-tool-cmd">▸ 运行 xtc tie 贪吃蛇.xt</span>
                    <span class="fd-badge">已完成 · 3.4s</span>
                  </div>
                  <pre class="fd-tool-out">INFO: FILEIO: [build/贪吃蛇.exe] File saved successfully</pre>
                </div>

                <div class="fd-msg a">
                  <p class="fd-ai-p">写好了，已编译并实测跑通。</p>
                  <p class="fd-ai-h">实现要点</p>
                  <ul class="fd-ai-ul">
                    <li>固定步长 1/60s 推进，逻辑与帧率解耦</li>
                    <li>撞墙 / 自撞判定后整局重置</li>
                    <li>绘制分帧提交，输入不被渲染阻塞</li>
                  </ul>
                </div>
              </div>

              <div class="fd-ai-input">
                <div class="fd-ai-ph">询问玄铁或任何编程问题…<span class="fd-ai-hint">Enter 发送 · Shift+Enter 换行</span></div>
                <div class="fd-ai-bar">
                  <span class="fd-chip">＋</span>
                  <span class="fd-chip">DeepSeek · 最高</span>
                  <span class="fd-chip">完全控制</span>
                  <span class="fd-sp"></span>
                  <span class="fd-send">↑</span>
                </div>
              </div>
            </aside>
          </div>

          <!-- 底部面板 + 状态栏 -->
          <div class="fd-panel">
            <div class="fd-ptabs">
              <span class="fd-ptab on">终端</span>
              <span class="fd-ptab">构建</span>
              <span class="fd-ptab">问题 <b>3</b></span>
            </div>
            <pre class="fd-term"><span class="ps">PS G:\FUsed_Folders\Temp\XuanTie2\我的工程&gt;</span> <span class="cmd">xtc tie 贪吃蛇.xt</span>
<span class="ok">✓</span> 编译完成 · build/贪吃蛇.exe (2.4 MB)</pre>
          </div>

          <div class="fd-status">
            <span>玄铁</span>
            <span class="fd-lsp"><i></i>LSP 已连接</span>
            <span class="fd-sp"></span>
            <span>UTF-8</span>
            <span>Ln 1, Col 1</span>
            <span>玄铁</span>
          </div>
        </div>
        <figcaption class="fd-figcap">
          <b>FIG. 2 — 铸造厂 IDE / WINDOWS 11</b>
          <span>智器对话 · DSH Agent · 玄铁语言服务 · 环境自检 · 一键编译运行</span>
        </figcaption>
      </figure>

      <section class="fd-feats">
        <div class="fd-sechead"><span class="fd-secnum">壹</span><h2>不止是编辑器</h2></div>
        <p class="lead">为「用中文写程序」这件事做到工程上不妥协</p>
        <div class="fd-grid">
          <div v-for="(f, fi) in feats" :key="f[0]" class="fd-card">
            <span class="fd-card-i">{{ String(fi + 1).padStart(2, '0') }}</span>
            <h3>{{ f[0] }}</h3>
            <p>{{ f[1] }}</p>
          </div>
        </div>
      </section>

      <section class="fd-quick">
        <div class="fd-sechead"><span class="fd-secnum">贰</span><h2>三步跑起来</h2></div>
        <div class="fd-quickbox">
          <div class="fd-quickbar"><span class="fd-qtab on">终端</span></div>
          <pre><span class="cmt"># 1. 安装（下载安装包，装完终端即有 xtc 与 tiepm）</span>
<span class="cmd">xtc tie hello.xt</span>   <span class="cmt"># 2. 编译为原生机器码</span>
<span class="cmd">./hello.exe</span>        <span class="cmt"># 3. 运行</span></pre>
        </div>
      </section>

      <footer class="fd-foot">
        <div class="fd-footrow">
          <span>© 2026 MARKJY · 玄铁铸造厂</span>
          <span>MIT 开源</span>
          <span class="fd-sp"></span>
          <a href="https://bbs.xt.markjy.com">社区</a>
          <a href="/">文档站</a>
          <a href="/downloads">下载玄铁</a>
          <a href="https://github.com/MARKJY-China/XuanTie-Lang" target="_blank" rel="noopener">GitHub</a>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.fd {
  /* 页面本体走全站品牌令牌（宣纸/玄/朱砂/铁灰，见 theme/custom.css）。
     下面 --fd-* 只服务于中间那个「应用截图」——它是深色应用，不跟着站点换肤。 */
  --fd-ink: #eef1f7;
  --fd-ink-2: #a7b0c0;
  --fd-ink-3: #6b7484;
  --fd-line: rgba(255, 255, 255, .09);
  --fd-line-2: rgba(255, 255, 255, .16);
  --fd-card: rgba(255, 255, 255, .035);
  --fd-accent: #4da3ff;
  --fd-win: #0e111a;
  --fd-win-2: #12151f;
  --fd-mono: ui-monospace, "Cascadia Mono", Consolas, "Courier New", monospace;
  min-height: 100vh;
  color: var(--xt-fg);
  line-height: 1.75;
  overflow-x: hidden;
}
.fd * { box-sizing: border-box; }
.fd a { color: inherit; text-decoration: none; }
.fd-sp { flex: 1; }

.fd-wrap { position: relative; z-index: 1; max-width: 1080px; margin: 0 auto; padding: 0 24px; }

/* ---- 页面顶栏：细线 + 等宽微标签 ---- */
.fd-nav {
  display: flex; align-items: center; gap: 20px;
  padding: 20px 0 14px;
  border-bottom: 1px solid var(--xt-rule);
}
.fd-brand { display: flex; align-items: center; gap: 9px; font-weight: 800; font-size: 16px; color: var(--xt-fg); }
.fd-brand-mark { flex: none; color: var(--xt-fg); }
.fd-brand small {
  margin-left: 4px; font-family: var(--xt-mono); font-size: 10.5px;
  font-weight: 600; letter-spacing: .22em; color: var(--xt-fg-3);
}
.fd-lnk { font-family: var(--xt-mono); font-size: 11.5px; letter-spacing: .08em; color: var(--xt-fg-2); }
.fd-lnk:hover { color: var(--xt-fg); }

/* ---- Hero ---- */
.fd-hero { text-align: center; padding: 52px 0 20px; }
.fd-pill {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid var(--xt-rule); padding: 4px 12px;
  font-family: var(--xt-mono); font-size: 11px; letter-spacing: .08em; color: var(--xt-fg-2);
}
.fd-pill i { width: 6px; height: 6px; background: var(--xt-fg); flex: none; }
/* 应用图标走标识的「玄·范」形态（圆角铁块由 SVG 自带） */
.fd-appblock { display: block; width: 64px; height: 64px; margin: 30px auto 0; }
.fd-hero h1 { margin: 20px 0 0; font-size: 46px; line-height: 1.15; font-weight: 800; letter-spacing: .01em; color: var(--xt-fg); }
.fd-hero h1 .en {
  display: block; margin-top: 10px;
  font-family: var(--xt-mono); font-size: 12px; font-weight: 600;
  letter-spacing: .34em; color: var(--xt-fg-3);
}
.fd-tagline { margin: 18px 0 0; font-size: 17px; font-weight: 600; color: var(--xt-fg); }
.fd-sub { margin: 8px auto 0; max-width: 620px; font-size: 14px; line-height: 1.85; color: var(--xt-fg-2); }
.fd-cta { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 26px; }
/* .fd a{color:inherit} 特异性高于 .fd-btn，故这里用 .fd .fd-btn 压过它 */
.fd .fd-btn {
  display: inline-flex; align-items: center; gap: 10px;
  background: var(--xt-invert-glass); color: var(--xt-invert-fg);
  border: 1px solid var(--xt-invert-glass);
  font-weight: 700; font-size: 14px; line-height: 44px; padding: 0 26px;
  -webkit-backdrop-filter: blur(var(--xt-blur)) saturate(125%);
  backdrop-filter: blur(var(--xt-blur)) saturate(125%);
  transition: background-color .18s ease, border-color .18s ease;
}
.fd .fd-btn:hover { background: var(--xt-invert-hover); border-color: var(--xt-invert-hover); }
.fd-meta { font-family: var(--xt-mono); font-size: 11px; letter-spacing: .06em; color: var(--xt-fg-3); }
.fd-more { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; }
.fd-more a {
  font-family: var(--xt-mono); font-size: 11.5px; letter-spacing: .06em;
  color: var(--xt-fg-2); border-bottom: 1px solid var(--xt-rule-strong);
}
.fd-more a:hover { color: var(--xt-fg); border-bottom-color: var(--xt-fg); }

/* ══════ 产品界面模拟窗（Windows 11 版真实 IDE 的结构） ══════ */
.fd-window {
  border: 1px solid var(--fd-line-2); border-radius: 10px; overflow: hidden;
  background: var(--fd-win); font-size: 12.5px;
  box-shadow: 0 36px 100px rgba(0, 0, 0, .62), 0 0 0 1px rgba(255, 255, 255, .03) inset;
}

/* 标题栏 */
.fd-tbar { display: flex; align-items: center; gap: 10px; height: 36px; padding-left: 12px; background: #0b0e16; border-bottom: 1px solid var(--fd-line); }
.fd-appicon {
  width: 17px; height: 17px; border-radius: 4px; flex: none;
  display: grid; place-items: center; font-size: 10px; color: #fff;
  background: linear-gradient(140deg, #7b86d8, #414c88);
}
.fd-appname { color: var(--fd-ink-2); }
.fd-menu { display: flex; gap: 1px; margin-left: 6px; }
.fd-menu span { padding: 3px 8px; border-radius: 4px; color: var(--fd-ink-2); }
.fd-menu span:hover { background: rgba(255, 255, 255, .07); }
.fd-acts { display: flex; align-items: center; gap: 4px; }
.fd-act { padding: 3px 9px; border-radius: 5px; color: var(--fd-ink-2); white-space: nowrap; }
.fd-act.run { color: #7ee0a1; border: 1px solid rgba(126, 224, 161, .28); background: rgba(126, 224, 161, .07); }
.fd-act.stop { color: var(--fd-ink-3); border: 1px solid transparent; }
.fd-user { padding: 3px 9px; color: var(--fd-ink-2); }
.fd-wctl { display: flex; align-self: stretch; margin-left: 6px; }
.fd-wctl i { width: 44px; display: grid; place-items: center; }
.fd-wctl .min::before { content: ""; width: 10px; height: 1px; background: var(--fd-ink-2); }
.fd-wctl .max::before { content: ""; width: 9px; height: 9px; border: 1px solid var(--fd-ink-2); border-radius: 1px; }
.fd-wctl .close::before {
  content: ""; width: 11px; height: 11px;
  background:
    linear-gradient(45deg, transparent 45%, var(--fd-ink-2) 45%, var(--fd-ink-2) 55%, transparent 55%),
    linear-gradient(-45deg, transparent 45%, var(--fd-ink-2) 45%, var(--fd-ink-2) 55%, transparent 55%);
}

/* 标签页 */
.fd-tabs { display: flex; align-items: stretch; gap: 1px; padding: 0 8px; background: #0b0e16; border-bottom: 1px solid var(--fd-line); }
.fd-tab { display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; color: var(--fd-ink-3); border-bottom: 1.5px solid transparent; }
.fd-tab.root { color: var(--fd-ink-2); }
.fd-tab.on { color: var(--fd-ink); background: rgba(255, 255, 255, .025); border-bottom-color: var(--fd-accent); }
.fd-tab i { font-style: normal; opacity: .45; }

/* 三栏 */
.fd-body { display: grid; grid-template-columns: 186px minmax(0, 1fr) 316px; min-height: 330px; }

.fd-tree { padding: 10px 8px; background: var(--fd-win-2); border-right: 1px solid var(--fd-line); }
.fd-row { display: flex; align-items: center; gap: 7px; padding: 3px 8px; border-radius: 5px; color: var(--fd-ink-2); white-space: nowrap; }
.fd-row.on { background: rgba(77, 163, 255, .14); color: var(--fd-ink); }
.fd-row.head { margin: 6px 0 2px; color: var(--fd-ink-3); font-size: 11px; letter-spacing: .08em; }
.fd-row.i1 { padding-left: 18px; }
.fd-row.i2 { padding-left: 34px; }
.fd-caret { font-style: normal; font-size: 10px; color: var(--fd-ink-3); }
.fd-fx { width: 8px; height: 8px; border-radius: 2px; flex: none; background: var(--fd-ink-3); }
.fd-fx.xt { background: #8b7fd4; }
.fd-fx.toml { background: #6b7484; }
.fd-fx.dir { background: #e0a35c; }
.fd-fx.fn { background: #7cc4ff; border-radius: 50%; }

.fd-editor { display: flex; align-items: stretch; gap: 2px; background: var(--fd-win); padding: 12px 0; overflow: hidden; }
.fd-code { flex: 1; min-width: 0; display: grid; grid-template-columns: 42px minmax(0, 1fr); font-family: var(--fd-mono); font-size: 12px; line-height: 1.75; }
.fd-mini { flex: none; width: 52px; padding: 2px 10px 0 0; border-left: 1px solid rgba(255, 255, 255, .04); }
.fd-mini i { display: block; height: 2px; margin-bottom: 2px; border-radius: 1px; background: #464e60; }
.fd-mini i.k { background: #7a5b84; }
.fd-mini i.t { background: #3d6892; }
.fd-mini i.v { background: #6a5a49; }
.fd-ln, .fd-src { margin: 0; padding: 0; white-space: pre; }
.fd-ln { text-align: right; padding-right: 10px; color: #3d4453; user-select: none; }
.fd-src { color: #c8d3e8; overflow-x: auto; padding-right: 14px; }
.fd-src .k { color: #c586c0; }
.fd-src .t { color: #569cd6; }
.fd-src .s { color: #98c379; }
.fd-src .n { color: #d19a66; }
.fd-src .f { color: #7cc4ff; }
.fd-src .v { color: #bd976a; }

.fd-ai { display: flex; flex-direction: column; background: var(--fd-win-2); border-left: 1px solid var(--fd-line); }
.fd-ai-head { display: flex; align-items: center; gap: 4px; padding: 8px 10px; border-bottom: 1px solid var(--fd-line); }
.fd-ai-title { font-weight: 600; color: var(--fd-ink); }
.fd-ai-ico { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 4px; color: var(--fd-ink-3); font-size: 12px; }
.fd-ai-body { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.fd-msg.u { align-self: flex-end; max-width: 92%; padding: 6px 10px; border-radius: 8px; background: rgba(77, 163, 255, .18); color: var(--fd-ink); }
.fd-think { color: var(--fd-ink-3); font-size: 11.5px; }
.fd-tool { border: 1px solid var(--fd-line); border-radius: 7px; overflow: hidden; }
.fd-tool-row { display: flex; align-items: center; gap: 6px; padding: 6px 9px; background: rgba(255, 255, 255, .02); }
.fd-tool-cmd { font-family: var(--fd-mono); font-size: 11.5px; color: #9fd0ff; }
.fd-badge { margin-left: auto; font-size: 10.5px; color: #7ee0a1; white-space: nowrap; }
.fd-tool-out {
  margin: 0; padding: 7px 9px; border-top: 1px solid var(--fd-line); border-left: 2px solid #e0a35c;
  background: rgba(224, 163, 92, .06); color: #e0b070;
  font-family: var(--fd-mono); font-size: 10.5px; white-space: pre-wrap; overflow-wrap: break-word;
}
.fd-msg.a { color: var(--fd-ink-2); }
.fd-ai-p { margin: 0 0 8px; color: var(--fd-ink); }
.fd-ai-h { margin: 0 0 4px; color: var(--fd-ink); font-weight: 700; font-size: 12px; }
.fd-ai-ul { margin: 0; padding-left: 16px; }
.fd-ai-ul li { margin-bottom: 3px; }
.fd-ai-input { margin-top: auto; padding: 8px 10px 10px; border-top: 1px solid var(--fd-line); }
.fd-ai-ph { padding: 8px 10px; border: 1px solid var(--fd-line); border-bottom: none; border-radius: 7px 7px 0 0; background: rgba(255, 255, 255, .02); color: var(--fd-ink-3); font-size: 12px; }
.fd-ai-hint { display: block; font-size: 10.5px; opacity: .75; }
.fd-ai-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid var(--fd-line); border-radius: 0 0 7px 7px; background: rgba(255, 255, 255, .02); }
.fd-chip { padding: 1px 7px; border: 1px solid var(--fd-line); border-radius: 999px; color: var(--fd-ink-3); font-size: 10.5px; white-space: nowrap; }
.fd-send { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: rgba(77, 163, 255, .28); color: #d8e8ff; font-size: 11px; }

/* 底部面板 + 状态栏 */
.fd-panel { background: var(--fd-win-2); border-top: 1px solid var(--fd-line); }
.fd-ptabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--fd-line); }
.fd-ptab { display: inline-flex; align-items: center; gap: 5px; padding: 5px 10px; color: var(--fd-ink-3); font-size: 11.5px; border-bottom: 1.5px solid transparent; }
.fd-ptab.on { color: var(--fd-ink); border-bottom-color: var(--fd-ink-3); }
.fd-ptab b { padding: 0 5px; border-radius: 999px; background: rgba(224, 128, 95, .18); color: #e0805f; font-size: 10px; font-weight: 600; }
.fd-term { margin: 0; padding: 8px 12px 10px; font-family: var(--fd-mono); font-size: 11.5px; line-height: 1.9; color: var(--fd-ink-2); white-space: pre-wrap; }
.fd-term .ps { color: #7cc4ff; }
.fd-term .cmd { color: var(--fd-ink); }
.fd-term .ok { color: #7ee0a1; }
.fd-status { display: flex; align-items: center; gap: 14px; padding: 3px 12px; background: #0b0e16; border-top: 1px solid var(--fd-line); color: var(--fd-ink-3); font-size: 11px; }
.fd-lsp { display: inline-flex; align-items: center; gap: 5px; }
.fd-lsp i { width: 6px; height: 6px; border-radius: 50%; background: #28c840; }

/* 图版：应用截图 + 等宽图注（语气对齐标识规范的 FIG. 版式） */
.fd-figure { margin: 42px 0 0; }
.fd-figcap {
  display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
  margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--xt-rule);
  font-family: var(--xt-mono); font-size: 10.5px; letter-spacing: .06em; color: var(--xt-fg-3);
}
.fd-figcap b { color: var(--xt-fg-2); font-weight: 600; }

/* ---- 分节标题：朱砂序号 + 标题 + 细线（全站唯一的彩色出处） ---- */
.fd-sechead { display: flex; align-items: baseline; gap: 12px; }
.fd-secnum { font-family: var(--xt-mono); font-size: 12px; color: var(--xt-cinnabar); }
.fd-sechead h2 { margin: 0; font-size: 24px; font-weight: 700; color: var(--xt-fg); }

/* ---- 特性 / 快速开始 / 页脚 ---- */
.fd-feats { padding: 60px 0 0; }
.fd-feats .lead {
  margin: 12px 0 26px; padding-top: 12px; border-top: 1px solid var(--xt-rule);
  color: var(--xt-fg-2); font-size: 13.5px;
}
.fd-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
.fd-card {
  padding: 18px;
  border: 1px solid var(--xt-glass-line);
  background: var(--xt-glass);
  -webkit-backdrop-filter: blur(var(--xt-blur)) saturate(125%);
  backdrop-filter: blur(var(--xt-blur)) saturate(125%);
  transition: border-color .18s ease, background-color .18s ease;
}
.fd-card:hover { border-color: var(--xt-fg); background: var(--xt-glass-strong); }
.fd-card-i {
  display: block; margin-bottom: 10px;
  font-family: var(--xt-mono); font-size: 10.5px; letter-spacing: var(--xt-track); color: var(--xt-fg-3);
}
.fd-card h3 { margin: 0 0 6px; font-size: 15.5px; font-weight: 700; color: var(--xt-fg); }
.fd-card p { margin: 0; color: var(--xt-fg-2); font-size: 13.5px; line-height: 1.8; }

.fd-quick { padding: 56px 0 0; }
.fd-quickbox {
  margin-top: 20px;
  border: 1px solid var(--xt-glass-line);
  background: var(--xt-glass);
  -webkit-backdrop-filter: blur(var(--xt-blur)) saturate(120%);
  backdrop-filter: blur(var(--xt-blur)) saturate(120%);
}
.fd-quickbar { display: flex; border-bottom: 1px solid var(--xt-rule); }
.fd-qtab {
  padding: 8px 16px; border-right: 1px solid var(--xt-rule);
  font-family: var(--xt-mono); font-size: 11px; letter-spacing: .08em; color: var(--xt-fg-3);
}
.fd-qtab.on { color: var(--xt-fg); background: var(--xt-wash); }
.fd-quickbox pre {
  margin: 0; padding: 18px 20px; overflow: auto;
  font-family: var(--xt-mono); font-size: 13px; line-height: 2; color: var(--xt-fg);
}
.fd-quickbox .cmd { color: var(--xt-fg); font-weight: 600; }
.fd-quickbox .cmt { color: var(--xt-fg-3); }

.fd-foot { margin-top: 56px; padding: 20px 0 48px; border-top: 1px solid var(--xt-rule); }
.fd-footrow {
  display: flex; flex-wrap: wrap; gap: 16px;
  font-family: var(--xt-mono); font-size: 11px; letter-spacing: .06em; color: var(--xt-fg-3);
}
.fd-footrow a { color: var(--xt-fg-2); }
.fd-footrow a:hover { color: var(--xt-fg); }

/* ══════ 模拟窗是「应用截图」，不受全站直角规则约束 ══════
   全站 custom.css 用 * { border-radius: 0 !important } 拉平圆角；
   这里是深色应用界面，恢复它自身的圆角（同权重下靠后 + 组件级更高特异性生效）。 */
.fd-window { border-radius: 8px !important; }
.fd-window .fd-appicon,
.fd-window .fd-menu span,
.fd-window .fd-act,
.fd-window .fd-ai-ico,
.fd-window .fd-row { border-radius: 4px !important; }
.fd-window .fd-fx { border-radius: 2px !important; }
.fd-window .fd-fx.fn,
.fd-window .fd-lsp i,
.fd-window .fd-send { border-radius: 50% !important; }
.fd-window .fd-msg.u { border-radius: 8px !important; }
.fd-window .fd-tool,
.fd-window .fd-tool-out { border-radius: 7px !important; }
.fd-window .fd-chip { border-radius: 999px !important; }
.fd-window .fd-ai-ph { border-radius: 7px 7px 0 0 !important; }
.fd-window .fd-ai-bar { border-radius: 0 0 7px 7px !important; }
.fd-window .fd-ptab b { border-radius: 999px !important; }

@media (max-width: 1040px) {
  .fd-body { grid-template-columns: 172px minmax(0, 1fr) 286px; }
}
@media (max-width: 940px) {
  .fd-hero h1 { font-size: 42px; }
  .fd-body { grid-template-columns: 170px minmax(0, 1fr); }
  .fd-ai { display: none; }
  .fd-grid { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 720px) {
  .fd-menu, .fd-act:not(.run), .fd-user { display: none; }
  .fd-tree, .fd-mini { display: none; }
  .fd-body { grid-template-columns: minmax(0, 1fr); }
  .fd-hero { padding-top: 40px; }
  .fd-hero h1 { font-size: 34px; }
  .fd-hero h1 .en { font-size: 11px; letter-spacing: .26em; }
  .fd-tagline { font-size: 16.5px; }
  .fd-code { font-size: 11px; }
  .fd-grid { grid-template-columns: 1fr; }
  .fd-wctl i { width: 34px; }
  .fd-figcap { flex-direction: column; gap: 3px; }
}
</style>
