import DefaultTheme from 'vitepress/theme'
import Layout from './Layout.vue'
import './custom.css'

// 视觉系统见 custom.css 顶部说明；标识别名与源文件在仓库 assets/玄铁logo-*.svg
export default {
  extends: DefaultTheme,
  Layout
}
