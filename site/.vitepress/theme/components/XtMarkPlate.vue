<script setup>
// 首页图版：主标 + 工程图方格 + 图注。
// 语气对标标识规范里的「FIG. 1 构造图」—— 与其把它当成一张插画，
// 不如把它当成一页图纸：方格、细线、等宽注记。
import XtMark from './XtMark.vue'
</script>

<template>
  <figure class="xt-plate">
    <div class="xt-plate-inner">
      <XtMark class="xt-plate-mark" :size="176" />
    </div>
    <figcaption class="xt-plate-cap">
      <b>FIG. 1 — 玄·折 / PRIMARY</b>
      <span>120×120 GRID · 笔画 8（1/15）· 横 64 · 折距 16 · 全部直角</span>
    </figcaption>
  </figure>
</template>
