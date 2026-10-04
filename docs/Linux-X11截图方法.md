# Linux X11 下玄铁渲染库的截图方法（窗口内容 vs 桌面）

> 适用：玄铁渲染库在 Linux X11（KDE Plasma）下的截图与缩放验证。
> 实测环境：ThinkPad E490 / Arch x86_64 / KDE Plasma X11 / Xorg。

## 两种截图：抓什么、用什么

| 方式 | 抓取内容 | 工具 | 输出尺寸 |
|---|---|---|---|
| 窗口内容截图 | 渲染 framebuffer（无窗口框架、无标题栏） | 玄铁内置 `R.截图(路径)` | framebuffer 物理像素（HiDPI 下 = 逻辑画布 × 缩放比，如 150% 时 800×600 → 1200×900） |
| 桌面截图 | 合成后的真实屏幕（窗口框架、标题栏、阴影、壁纸、任务栏全含） | spectacle（KWin 截图 API） | 屏幕物理分辨率（如 1920×1080） |

## 窗口内容截图：玄铁内置 R.截图

```xt
引 "渲染" 予 R
R.初始化窗口(800, 600, "测试")
R.开始绘图()
' ... 绘制内容 ...
R.结束绘图()
R.截图("/tmp/shot.png")   ' 须在一帧 结束绘图 之后调用
```

- 语义：渲染桥走 raylib 屏幕截图，从 OpenGL 默认 framebuffer 读像素（glReadPixels 风格）——**只含窗口客户区渲染内容**，不含窗口框架/标题栏/桌面。
- HiDPI 行为：输出 **framebuffer 物理尺寸**——逻辑画布 800×600 在 150% 下输出 1200×900。
- 用途：验证「逻辑画布 vs 物理像素」分层、@2x 资源选择、渲染精度（圆边缘锯齿）。

## 桌面截图（带窗口框架）：spectacle（推荐）

KDE 自带截图工具，走 KWin 截图 API，抓**合成后的真实画面**。

```bash
# 安装（Arch）
sudo pacman -S spectacle

# 命令行全屏截图（SSH 会话需带 X 授权）
DISPLAY=:0 XAUTHORITY="$XAUTHORITY" \
  spectacle --fullscreen --background --output /tmp/screen.png
```

- `--fullscreen` 全屏 / `--background` 无交互 / `--output` 输出路径。
- Xauthority 位置因显示管理器而异：在图形会话里执行 `echo $XAUTHORITY` 取当前值，或用 `xauth list` 查看（具体路径/会话信息勿外发）。
- 用途：证明窗口真实显示在屏幕（框架/标题栏/阴影/壁纸/任务栏齐全），观察窗口在桌面缩放下的表现。

## 桌面截图：xwd（不推荐——抓不到合成层）

```bash
DISPLAY=:0 XAUTHORITY="$XAUTHORITY" xwd -root -out /tmp/frame.xwd
ffmpeg -y -i /tmp/frame.xwd /tmp/frame.png   # 转 PNG（PIL 不读 XWD）
```

局限：xwd 只读 **X 根窗口 pixmap**，KWin 合成层（窗口装饰、阴影、壁纸）**全部丢失**——截图里窗口变成无框架纯内容、壁纸区域变黑。仅适用于无合成器（裸 Xorg）场景。

## 附：X11 下 KDE 缩放如何被玄铁感知

- KDE 系统设置「全局缩放（Global scale）」在 X11 层写入 X resources：`Xft.dpi`（实测 125% → `Xft.dpi: 120`；100% 时无缩放）。
- GLFW/raylib 读到 Xft.dpi 后放大 framebuffer → `取渲染宽/高` 反映缩放：
  - 100% → 屏幕 800×600 / 渲染 800×600（缩放比 1.0）
  - 125% → 屏幕 800×600 / 渲染 1000×750（缩放比 1.25）
  - 150% → 屏幕 800×600 / 渲染 1200×900（缩放比 1.5）
- 缩放比 = 取渲染宽 ÷ 取屏幕宽（玄铁现有 API 可算，无需新接口）。
- 注销重新登录后 Global scale 才完全生效（改值后即时观察可能无变化）。
