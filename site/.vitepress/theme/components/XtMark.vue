<script setup>
// 玄·折 主标：内联 SVG，吃 currentColor —— 明暗两套底色不用换文件。
// 几何取自资产源文件 assets/玄铁logo-玄折-主标.svg（120×120 网格，笔画 8，全部直角）。
defineProps({
  size: { type: [Number, String], default: 22 }
})
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 120 120"
    fill="none"
    role="img"
    aria-label="玄铁"
  >
    <path d="M60 17 V29" stroke="currentColor" stroke-width="8" />
    <path d="M28 39 H92" stroke="currentColor" stroke-width="8" />
    <path d="M72 51 H48 V67 H72 V83 H48 V99 H70" stroke="currentColor" stroke-width="8" />
    <rect x="78" y="93" width="10" height="10" fill="currentColor" />
  </svg>
</template>
