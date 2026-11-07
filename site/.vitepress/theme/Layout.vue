<script setup>
// 主题外壳：默认主题不动，只往里塞两处品牌件 ——
//   导航标识（内联 SVG，明暗通吃）、页脚尾花（玄·印钤记）。
// 首页 hero 不放图版：用户 2026-10-17 要求右侧留白，不展示标识的构造过程。
import DefaultTheme from 'vitepress/theme'
import XtMark from './components/XtMark.vue'
</script>

<template>
  <DefaultTheme.Layout>
    <template #nav-bar-title-before>
      <XtMark class="xt-nav-mark" :size="22" />
    </template>

    <!-- 尾花：印章是全站唯一允许出现圆角与红色的地方 -->
    <template #layout-bottom>
      <div class="xt-colophon">
        <img src="/seal.svg" alt="玄铁" width="20" height="20" />
        <span>玄铁 XUANTIE · 中文系统级编程语言</span>
        <span class="sp" />
        <span>MARK 玄·折 120×120 · STROKE 8 · NO CURVES</span>
      </div>
    </template>
  </DefaultTheme.Layout>
</template>
