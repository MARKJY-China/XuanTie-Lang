---
title: 下载
---

<script setup>
import { ref, onMounted } from 'vue'

// 下载列表由玄铁社区后台「官网」Tab 配置,运行时经公开 API 拉取
// (安装包直链指向对象存储,国内直连高速;API 不可用时降级到 GitHub Releases)
const API = 'https://bbs.xt.markjy.com/api/site/downloads'
const loading = ref(true)
const versions = ref([])

// 「支持系统」后台填的是一行文本(顿号/逗号/分号/换行分隔),这里拆成条目渲染成气泡列表。
// 注意只按分隔符拆,不按 "/" 拆 —— "Ubuntu 22.04/24.04" 这类写法里的斜杠属于条目本身。
function osList(raw) {
  return String(raw || '')
    .split(/[、,，;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

// 气泡默认在按钮上方(约 170px 高)。按钮贴着视口顶部时上方放不下,就翻到下方,
// 免得气泡被视口切掉一半。纯 CSS 做不到这个判断,所以只加这一处极小的交互。
const flipKey = ref('')
function placeTip(e, key) {
  const r = e.currentTarget.getBoundingClientRect()
  const above = r.top
  const below = window.innerHeight - r.bottom
  flipKey.value = above < 190 && below > above ? key : ''
}

onMounted(async () => {
  try {
    const r = await fetch(API)
    const j = await r.json()
    const data = j && j.ok && j.data && j.data.json ? JSON.parse(j.data.json) : null
    versions.value = data && Array.isArray(data.versions) ? data.versions : []
  } catch (e) {
    // 官网与社区域名不同源/网络异常:静默降级到 GitHub 提示
  }
  loading.value = false
})
</script>

# 下载玄铁

<p class="dl-lead">玄铁是自举编译、LLVM 原生机器码的中文编程语言。安装包由对象存储直链分发，国内高速；装完终端即有 <code>xtc</code> 与 <code>tiepm</code>。</p>

<div class="dl-wrap">
  <div v-if="loading" class="dl-muted">正在获取版本列表…</div>
  <template v-else-if="versions.length">
    <div v-for="(v, i) in versions" :key="i" class="dl-card">
      <div class="dl-head">
        <span class="dl-ver">{{ v.version }}</span>
        <span v-if="i === 0" class="dl-latest">最新</span>
        <span class="dl-date">{{ v.date }}</span>
        <a
          v-if="v.releaseUrl"
          class="dl-release"
          :href="v.releaseUrl"
          target="_blank"
          rel="noopener"
          :title="`查看 ${v.version} 的 Release 详情`"
        >
          <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
          <span>Release</span>
        </a>
      </div>
      <p v-if="v.note" class="dl-note">{{ v.note }}</p>
      <div class="dl-files">
        <div
          v-for="(f, fi) in v.files"
          :key="fi"
          class="dl-file-wrap"
          :class="{ 'tip-below': flipKey === i + '-' + fi }"
          @mouseenter="placeTip($event, i + '-' + fi)"
        >
          <a
            class="dl-file"
            :href="f.url"
            target="_blank"
            rel="noopener"
          >
            <span class="dl-file-label">{{ f.label || '下载' }}</span>
            <span v-if="f.size" class="dl-file-size">{{ f.size }}</span>
          </a>
          <!-- 悬浮气泡:该包支持哪些系统(后台「支持系统」一栏;留空则整块不渲染) -->
          <div v-if="osList(f.platforms).length" class="dl-tip" role="tooltip">
            <div class="dl-tip-title">支持的系统</div>
            <ul class="dl-tip-list">
              <li v-for="(o, oi) in osList(f.platforms)" :key="oi">{{ o }}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </template>
  <div v-else class="dl-muted">
    暂时无法获取在线下载列表。可前往
    <a href="https://github.com/MARKJY-China/XuanTie-Lang/releases" target="_blank" rel="noopener">GitHub Releases</a>
    下载，或稍后刷新重试。
  </div>
</div>

<p class="dl-foot">
  安装遇到问题？到 <a href="https://bbs.xt.markjy.com" target="_blank" rel="noopener">玄铁社区</a>
  发帖求助。历史版本说明见 <a href="/versionLog">更新日志</a>。
</p>

<style scoped>
.dl-lead { color: var(--vp-c-text-2); margin: 8px 0 24px; line-height: 1.8; }
.dl-muted { color: var(--vp-c-text-2); padding: 24px 0; }
.dl-card {
  border: 1px solid var(--vp-c-divider);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  background: var(--vp-c-bg-soft);
}
.dl-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dl-ver { font-size: 19px; font-weight: 700; font-family: var(--vp-font-family-mono); }
.dl-latest {
  font-size: 12px; padding: 1px 8px; border-radius: 999px;
  background: var(--vp-c-brand-1); color: #fff;
}
.dl-date { color: var(--vp-c-text-3); font-size: 13px; margin-left: auto; }
.dl-release {
  display: inline-flex; align-items: center; gap: 6px; flex: none;
  padding: 3px 11px; border-radius: 999px;
  border: 1px solid var(--vp-c-divider);
  color: var(--vp-c-text-2); font-size: 12.5px; font-weight: 600;
  text-decoration: none;
  transition: color .15s, border-color .15s, background .15s;
}
.dl-release:hover { color: var(--vp-c-text-1); border-color: var(--vp-c-brand-1); background: var(--vp-c-bg); }
.dl-release svg { display: block; }
.dl-note { color: var(--vp-c-text-2); font-size: 13.5px; margin: 10px 0 4px; line-height: 1.7; white-space: pre-line; }
.dl-files { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
.dl-file-wrap { position: relative; display: inline-flex; }
.dl-file {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 9px 16px; border-radius: 8px;
  border: 1px solid var(--vp-c-divider);
  background: var(--vp-c-bg); color: var(--vp-c-text-1);
  font-size: 13.5px; font-weight: 600; text-decoration: none;
  transition: border-color .15s, background .15s;
}
.dl-file:hover { border-color: var(--vp-c-brand-1); background: var(--vp-c-bg-soft); }
.dl-file-size { color: var(--vp-c-text-3); font-weight: 400; font-family: var(--vp-font-family-mono); font-size: 12px; }

/* ---- 悬浮气泡(纯 CSS,不引 JS):hover 与键盘聚焦都能唤出 ---- */
.dl-tip {
  position: absolute; bottom: calc(100% + 10px); left: 50%;
  z-index: 20; width: max-content; max-width: 260px;
  padding: 9px 12px 10px; border-radius: 10px;
  background: var(--vp-c-bg-elv); border: 1px solid var(--vp-c-divider);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .18);
  opacity: 0; visibility: hidden; pointer-events: none;
  transform: translate(-50%, 4px);
  transition: opacity .16s ease, transform .16s ease, visibility .16s;
}
.dl-tip::after {
  content: ""; position: absolute; left: 50%; bottom: -5px;
  width: 9px; height: 9px; transform: translateX(-50%) rotate(45deg);
  background: var(--vp-c-bg-elv);
  border-right: 1px solid var(--vp-c-divider);
  border-bottom: 1px solid var(--vp-c-divider);
}
.dl-file-wrap:hover .dl-tip,
.dl-file-wrap:focus-within .dl-tip {
  opacity: 1; visibility: visible; transform: translate(-50%, 0);
}
.dl-tip-title {
  margin-bottom: 5px; font-family: var(--vp-font-family-mono);
  font-size: 11px; letter-spacing: .06em; color: var(--vp-c-text-3);
}
.dl-tip-list { margin: 0; padding: 0; list-style: none; }
.dl-tip-list li {
  display: flex; align-items: baseline; gap: 6px;
  font-size: 12.5px; line-height: 1.7; color: var(--vp-c-text-2);
}
.dl-tip-list li::before { content: "·"; color: var(--vp-c-brand-1); }

/* 上方放不下时翻到按钮下方(尖角随之朝上) */
.dl-file-wrap.tip-below .dl-tip { top: calc(100% + 10px); bottom: auto; transform: translate(-50%, -4px); }
.dl-file-wrap.tip-below:hover .dl-tip,
.dl-file-wrap.tip-below:focus-within .dl-tip { transform: translate(-50%, 0); }
.dl-file-wrap.tip-below .dl-tip::after {
  top: -5px; bottom: auto;
  border-right: none; border-bottom: none;
  border-left: 1px solid var(--vp-c-divider);
  border-top: 1px solid var(--vp-c-divider);
}

/* 上方放不下时翻到按钮下方(尖角随之朝上) */
.dl-file-wrap.tip-below .dl-tip { top: calc(100% + 10px); bottom: auto; transform: translate(-50%, -4px); }
.dl-file-wrap.tip-below:hover .dl-tip,
.dl-file-wrap.tip-below:focus-within .dl-tip { transform: translate(-50%, 0); }
.dl-file-wrap.tip-below .dl-tip::after {
  top: -5px; bottom: auto;
  border-right: none; border-bottom: none;
  border-left: 1px solid var(--vp-c-divider);
  border-top: 1px solid var(--vp-c-divider);
}

.dl-foot { color: var(--vp-c-text-2); font-size: 13.5px; margin-top: 20px; }

@media (max-width: 640px) {
  .dl-date { margin-left: 0; }
  .dl-release { margin-left: auto; }
  /* 窄屏改用左对齐,避免居中的气泡顶出视口 */
  .dl-tip { left: 0; transform: translate(0, 4px); max-width: min(260px, 78vw); }
  .dl-tip::after { left: 22px; }
  .dl-file-wrap:hover .dl-tip,
  .dl-file-wrap:focus-within .dl-tip { transform: translate(0, 0); }
  .dl-file-wrap.tip-below .dl-tip { transform: translate(0, -4px); }
  .dl-file-wrap.tip-below:hover .dl-tip,
  .dl-file-wrap.tip-below:focus-within .dl-tip { transform: translate(0, 0); }
  .dl-file-wrap.tip-below .dl-tip { transform: translate(0, -4px); }
  .dl-file-wrap.tip-below:hover .dl-tip,
  .dl-file-wrap.tip-below:focus-within .dl-tip { transform: translate(0, 0); }
}
</style>
