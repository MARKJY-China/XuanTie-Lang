// 渲染桥.c — 玄铁渲染库 C 桥接层 v1.0
// 将 XuanTie 的 i64 标记指针转换为 raylib 原生 C 类型并调用
// 编译时与 xt_runtime.c + libraylib.a 一起链接
//
// 标记方案 (from xt_runtime.h):
//   整数: tagged = (raw << 1) | 1   →  untag: raw = (int64_t)(tagged >> 1)
//   布尔: true = 0x4, false = 0x2   →  untag: tagged == 0x4
//   浮点: 存储在 XTFloat 对象中
//   字符串: XTString 对象指针
//   对象: 原始指针 (低位为 0，因为对齐)

#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// === XuanTie 运行时类型（精简版，避免依赖完整 xt_runtime.h） ===
// 标记值操作
#define XT_TAG_INT     0x1ULL
#define XT_FROM_INT(i) (((uintptr_t)(i) << 1) | XT_TAG_INT)
#define XT_TO_INT(v)   ((int64_t)((intptr_t)(v) >> 1))

#define XT_TRUE         ((uintptr_t)0x4ULL)
#define XT_FALSE        ((uintptr_t)0x2ULL)
#define XT_FROM_BOOL(b) ((b) ? XT_TRUE : XT_FALSE)
#define XT_TO_BOOL(v)   ((v) == XT_TRUE)

// XTString 结构 (与 xt_runtime.h/c 对齐)
// 运行时 XTString: { XTObject(12字节) + 填充(4) + char* data(8) + size_t length(8) + size_t capacity(8) + uint8_t(1) }
typedef struct {
    uint32_t magic;
    uint32_t ref_count;
    uint32_t type_id;
    char*    data;
    size_t   length;
    size_t   capacity;   // 堆缓冲分配容量(原地追加用;arena 串为 0)
    uint8_t  data_in_arena;
} XTString;

// XTFloat 结构 (与 xt_runtime.h/c 对齐)
// 运行时: { XTObject(12字节) + 填充(4) + double value(8) } = 24字节
typedef struct {
    uint32_t magic;
    uint32_t ref_count;
    uint32_t type_id;
    double   value;
} XTFloat;

// === 类型转换辅助宏 ===

// 从 XTValue (uintptr_t/i64) 判断类型
// 排除 XT_FALSE(0x2)/XT_TRUE(0x4)/XT_NULL(0x0) 等小常量——合法堆地址 > 4096
#define IS_PTR(v)       (((uintptr_t)(v) & 0x1) == 0 && (v) > 4096)
#define IS_INT(v)       (((uintptr_t)(v) & 0x1) == 1)

// 提取字符串: 如果是对象指针则返回 data，否则返回空串
static const char* xt_get_cstr(uintptr_t v) {
    if (IS_PTR(v) && v != 0) {
        XTString* s = (XTString*)v;
        if (s->type_id == 3) return s->data;
    }
    return "";
}

// runtime 字符串构造(剪贴板读取等需返回玄铁字符串对象的桥函数用)
extern void* xt_string_new(const char*);

// 提取浮点数: 如果是 XTFloat 对象则返回 value
static double xt_get_float(uintptr_t v) {
    if (IS_PTR(v) && v != 0) {
        XTFloat* f = (XTFloat*)v;
        if (f->type_id == 2) return f->value;
    }
    return 0.0;
}

// 创建浮点数 XTValue，ref_count=1 纳入正常 ARC 管理
static uintptr_t xt_make_float(double v) {
    XTFloat* f = (XTFloat*)malloc(sizeof(XTFloat));
    if (!f) return 0;
    f->magic = 0x58544F42;
    f->ref_count = 1;
    f->type_id = 2;
    f->value = v;
    return (uintptr_t)f;
}

// === raylib 头 ===
#include "raylib.h"
#include <stdio.h>   // FILE/fread(宽字符读文件用)
#include <wchar.h>   // _wfopen(Windows)
#include <math.h>    // sqrtf/fabsf(渐变圆角 SDF 用)

// === nanosvg(SVG 光栅化,单头库;输入栏图标等用) ===
#define NANOSVG_IMPLEMENTATION
#include "nanosvg.h"
#define NANOSVGRAST_IMPLEMENTATION
#include "nanosvgrast.h"

// Win32 Unicode API 前向声明（避免包含 <windows.h> 与 raylib 冲突）
#ifndef WINAPI
#define WINAPI __stdcall
#endif
typedef void* HANDLE;
typedef HANDLE HWND;
typedef unsigned short wchar_t;
extern __declspec(dllimport) int WINAPI MultiByteToWideChar(
    unsigned int CodePage, unsigned long dwFlags, const char* lpMultiByteStr,
    int cbMultiByte, wchar_t* lpWideCharStr, int cchWideChar);
extern __declspec(dllimport) int WINAPI SetWindowTextW(HWND hWnd, const wchar_t* lpString);
// 窗口样式运行时改写(raylib SetWindowState 对本后端运行时不生效,故直走 Win32)
extern __declspec(dllimport) intptr_t WINAPI GetWindowLongPtrW(HWND hWnd, int nIndex);
extern __declspec(dllimport) intptr_t WINAPI SetWindowLongPtrW(HWND hWnd, int nIndex, intptr_t dwNewLong);
extern __declspec(dllimport) int WINAPI SetWindowPos(HWND hWnd, HWND hWndInsertAfter,
    int X, int Y, int cx, int cy, unsigned int uFlags);
#define XT_GWL_STYLE        (-16)
#define XT_WS_THICKFRAME    0x00040000L
#define XT_WS_MAXIMIZEBOX   0x00010000L
#define XT_WS_CAPTION       0x00C00000L
#define XT_WS_SYSMENU       0x00080000L
#define XT_SWP_NOSIZE       0x0001
#define XT_SWP_NOMOVE       0x0002
#define XT_SWP_NOZORDER     0x0004
#define XT_SWP_FRAMECHANGED 0x0020
// 自管可调整状态(无边框还原时按它决定是否恢复厚边框)
static int g_xt_resizable = 0;
static void xt_apply_style(HWND hwnd) {
    SetWindowPos(hwnd, 0, 0, 0, 0, 0,
        XT_SWP_NOMOVE | XT_SWP_NOSIZE | XT_SWP_NOZORDER | XT_SWP_FRAMECHANGED);
}

// 读取文件全部字节(宽字符路径,支持中文路径——raylib 的 LoadFontEx/LoadTexture
// 内部走 ANSI fopen,中文路径必失败,实测 已安装 目录下字体加载 Failed to open)
static unsigned char* xt_read_file_bytes(const char* u8path, int* outSize) {
    FILE* f = NULL;
#ifdef _WIN32
    wchar_t wpath[1024];
    int wn = MultiByteToWideChar(65001 /*CP_UTF8*/, 0, u8path, -1, wpath, 1024);
    if (wn <= 0) return NULL;
    f = _wfopen(wpath, L"rb");
#else
    f = fopen(u8path, "rb");
#endif
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0) { fclose(f); return NULL; }
    unsigned char* buf = (unsigned char*)malloc((size_t)sz);
    if (!buf) { fclose(f); return NULL; }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { free(buf); fclose(f); return NULL; }
    fclose(f);
    *outSize = (int)sz;
    return buf;
}

// ============================================================
// 窗口管理
// ============================================================

void XT_InitWindow(uintptr_t w, uintptr_t h, uintptr_t title) {
    // MSAA 4x:圆角矩形/斜边的 GPU 级抗锯齿(raylib 的 DrawRectangleRounded 是三角形扇
    // 拼合,不开多重采样时边缘台阶感严重)。须在 InitWindow 前设置;取不到多样本
    // 帧缓冲时 GLFW 自动降级,不影响功能。
    SetConfigFlags(0x00000020); // FLAG_MSAA_4X_HINT
    InitWindow((int)XT_TO_INT(w), (int)XT_TO_INT(h), xt_get_cstr(title));
}

uintptr_t XT_WindowShouldClose(void) {
    return WindowShouldClose() ? 1 : 0;
}

void XT_CloseWindow(void) {
    CloseWindow();
}

uintptr_t XT_IsWindowReady(void) {
    return IsWindowReady() ? 1 : 0;
}

void XT_SetTargetFPS(uintptr_t fps) {
    SetTargetFPS((int)XT_TO_INT(fps));
}

uintptr_t XT_GetFPS(void) {
    return XT_FROM_INT(GetFPS());
}

uintptr_t XT_GetFrameTime(void) {
    return xt_make_float(GetFrameTime());
}

uintptr_t XT_GetScreenWidth(void) {
    return XT_FROM_INT(GetScreenWidth());
}

uintptr_t XT_GetScreenHeight(void) {
    return XT_FROM_INT(GetScreenHeight());
}

void XT_SetWindowTitle(uintptr_t title) {
    const char* utf8 = xt_get_cstr(title);
    // 通过 Win32 宽字符 API 正确设置 Unicode 窗口标题
    int wideLen = MultiByteToWideChar(65001 /*CP_UTF8*/, 0, utf8, -1, NULL, 0);
    if (wideLen > 0) {
        wchar_t* wideTitle = (wchar_t*)malloc((size_t)wideLen * sizeof(wchar_t));
        if (wideTitle) {
            MultiByteToWideChar(65001, 0, utf8, -1, wideTitle, wideLen);
            HWND hwnd = (HWND)GetWindowHandle();
            if (hwnd) SetWindowTextW(hwnd, wideTitle);
            free(wideTitle);
        }
    }
}

// ============================================================
// 窗口模式(运行时动态切换:可调整大小/无边框/全屏/尺寸)
// ============================================================

void XT_SetWindowResizable(uintptr_t on) {
    HWND hwnd = (HWND)GetWindowHandle();
    if (!hwnd) return;
    g_xt_resizable = XT_TO_INT(on) ? 1 : 0;
    intptr_t style = GetWindowLongPtrW(hwnd, XT_GWL_STYLE);
    if (g_xt_resizable) style |= (XT_WS_THICKFRAME | XT_WS_MAXIMIZEBOX);
    else style &= ~(XT_WS_THICKFRAME | XT_WS_MAXIMIZEBOX);
    SetWindowLongPtrW(hwnd, XT_GWL_STYLE, style);
    xt_apply_style(hwnd);
}

void XT_SetWindowUndecorated(uintptr_t on) {
    HWND hwnd = (HWND)GetWindowHandle();
    if (!hwnd) return;
    intptr_t style = GetWindowLongPtrW(hwnd, XT_GWL_STYLE);
    if (XT_TO_INT(on)) {
        style &= ~(XT_WS_CAPTION | XT_WS_SYSMENU | XT_WS_THICKFRAME | XT_WS_MAXIMIZEBOX);
    } else {
        style |= (XT_WS_CAPTION | XT_WS_SYSMENU);
        if (g_xt_resizable) style |= (XT_WS_THICKFRAME | XT_WS_MAXIMIZEBOX);
    }
    SetWindowLongPtrW(hwnd, XT_GWL_STYLE, style);
    xt_apply_style(hwnd);
}

void XT_SetWindowFullscreen(uintptr_t on) {
    // 显式语义:目标状态与当前一致时不动作(ToggleFullscreen 只有翻转语义)
    int want = (int)XT_TO_INT(on);
    if ((IsWindowFullscreen() ? 1 : 0) != want) ToggleFullscreen();
}

uintptr_t XT_IsWindowFullscreen(void) {
    return IsWindowFullscreen() ? 1 : 0;
}

void XT_SetWindowSize(uintptr_t w, uintptr_t h) {
    SetWindowSize((int)XT_TO_INT(w), (int)XT_TO_INT(h));
}

// ESC 关闭开关:开=按 ESC 请求关窗(raylib 默认),关=ESC 不再退程序
void XT_SetEscExit(uintptr_t on) {
    SetExitKey(XT_TO_INT(on) ? 256 /*KEY_ESCAPE*/ : 0);
}

void XT_BeginDrawing(void) {
    BeginDrawing();
}

void XT_EndDrawing(void) {
    EndDrawing();
}

/* 泵输入事件(不交换缓冲):正常渲染帧由 EndDrawing 内部自动调用;
   按需重绘的空闲轮询周期不画帧,靠它保持事件泵活着 */
void XT_PollInputEvents(void) {
    PollInputEvents();
}

/* 设置鼠标样式(raylib 标准光标枚举:0默认 1箭头 2I形 3十字 4手型 …);
   桥侧记忆当前值,同值重复调用直接返回,避免每帧 glfw 无谓重建/切换 */
void XT_SetMouseCursor(uintptr_t c) {
    static int last = -1;
    int v = (int)XT_TO_INT(c);
    if (v == last) return;
    last = v;
    SetMouseCursor(v);
}

/* ---- 窗口控制三件套(无边框自绘标题栏用) ---- */
#ifdef _WIN32
extern __declspec(dllimport) int WINAPI PostMessageW(void*, unsigned int, uintptr_t, intptr_t);
extern __declspec(dllimport) int WINAPI ShowWindow(void*, int);
typedef struct { long left, top, right, bottom; } XT_RECT2;
extern __declspec(dllimport) int WINAPI SetWindowPos(void*, void*, int, int, int, int, unsigned int);
extern __declspec(dllimport) int WINAPI GetWindowRect(void*, XT_RECT2*);
extern __declspec(dllimport) int WINAPI SystemParametersInfoW(unsigned int, unsigned int, void*, unsigned int);
extern __declspec(dllimport) void WINAPI Sleep(unsigned long);
#endif

uintptr_t XT_WindowMinimize(void) {
    MinimizeWindow();
    return XT_FROM_INT(1);
}

/* 工作区最大化(留出任务栏):无边框窗是 WS_POPUP,SW_MAXIMIZE 对它按 Windows 规则
   盖满全屏含任务栏(实测与用户预期"最大化≠全屏"冲突);改为 SPI_GETWORKAREA 取工作区
   矩形 + SetWindowPos。最大化前存原始矩形供还原;状态桥内跟踪(raylib IsWindowMaximized
   只认 SW_MAXIMIZE,手动 SetWindowPos 它不认) */
static XT_RECT2 xt_maxsave = {0, 0, 0, 0};
static int xt_maxed = 0;

uintptr_t XT_WindowMaximize(void) {
#ifdef _WIN32
    void* hwnd = GetWindowHandle();
    if (!hwnd) return XT_FROM_INT(0);
    if (!xt_maxed) { GetWindowRect(hwnd, &xt_maxsave); xt_maxed = 1; }
    XT_RECT2 wa;
    SystemParametersInfoW(0x0030 /* SPI_GETWORKAREA */, 0, &wa, 0);
    SetWindowPos(hwnd, 0, wa.left, wa.top, wa.right - wa.left, wa.bottom - wa.top, 0x0010 /* SWP_NOACTIVATE */);
    return XT_FROM_INT(1);
#else
    MaximizeWindow();
    return XT_FROM_INT(1);
#endif
}

uintptr_t XT_WindowRestore(void) {
#ifdef _WIN32
    void* hwnd = GetWindowHandle();
    if (!hwnd) return XT_FROM_INT(0);
    if (xt_maxed) {
        SetWindowPos(hwnd, 0, xt_maxsave.left, xt_maxsave.top,
                     xt_maxsave.right - xt_maxsave.left, xt_maxsave.bottom - xt_maxsave.top, 0x0010);
        xt_maxed = 0;
    }
    return XT_FROM_INT(1);
#else
    RestoreWindow();
    return XT_FROM_INT(1);
#endif
}

uintptr_t XT_WindowIsMaximized(void) {
#ifdef _WIN32
    return XT_FROM_INT(xt_maxed);
#else
    return XT_FROM_INT(IsWindowMaximized() ? 1 : 0);
#endif
}

/* 优雅关闭:不直接 CloseWindow(帧中销毁上下文,后续绘制即崩),
   Windows 下投递 WM_CLOSE,GLFW 转成 shouldClose,主循环下一轮按正常路径退出;
   非 Windows 平台退回 CloseWindow(帧末调用方为界) */
void XT_WindowClose(void) {
#ifdef _WIN32
    void* hwnd = GetWindowHandle();
    if (hwnd) PostMessageW(hwnd, 0x0010 /* WM_CLOSE */, 0, 0);
#else
    CloseWindow();
#endif
}

/* 标题栏拖拽移动(无边框自绘标题栏用):按下沿调用,桥内跟踪循环,松手才返回。
   移动器用 raylib SetWindowPosition(实测无残影——Win32 SetWindowPos 绕开 GLFW
   的呈现路径会留下满屏残影);光标增量与按住判定走 Win32 原生(GetCursorPos 实时、
   GetAsyncKeyState),不读 raylib 输入态(其鼠标态比事件泵滞后一拍,初版拖拽起点
   跳变十余像素即此所致);首步 SetWindowPosition(原位) 恒等,零跳变 */
typedef struct { long x, y; } XT_POINT;
extern __declspec(dllimport) int WINAPI GetCursorPos(XT_POINT*);
extern __declspec(dllimport) short WINAPI GetAsyncKeyState(int);

void XT_WindowDrag(void) {
#ifdef _WIN32
    void* hwnd = GetWindowHandle();
    if (!hwnd) return;
    Vector2 wp0 = GetWindowPosition();
    XT_POINT cur;
    GetCursorPos(&cur);
    int sx0 = cur.x;
    int sy0 = cur.y;
    while (GetAsyncKeyState(0x01 /* VK_LBUTTON */) & 0x8000) {
        GetCursorPos(&cur);
        SetWindowPosition((int)wp0.x + (cur.x - sx0), (int)wp0.y + (cur.y - sy0));
        Sleep(8);
    }
#endif
}

void XT_ClearBackground(uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {
        (unsigned char)XT_TO_INT(r),
        (unsigned char)XT_TO_INT(g),
        (unsigned char)XT_TO_INT(b),
        (unsigned char)XT_TO_INT(a)
    };
    ClearBackground(c);
}

// ============================================================
// 形状绘制
// ============================================================

void XT_DrawPixel(uintptr_t x, uintptr_t y, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawPixel((int)XT_TO_INT(x), (int)XT_TO_INT(y), c);
}

void XT_DrawLine(uintptr_t x1, uintptr_t y1, uintptr_t x2, uintptr_t y2,
                 uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawLine((int)XT_TO_INT(x1), (int)XT_TO_INT(y1),
             (int)XT_TO_INT(x2), (int)XT_TO_INT(y2), c);
}

void XT_DrawRectangle(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                      uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawRectangle((int)XT_TO_INT(x), (int)XT_TO_INT(y),
                  (int)XT_TO_INT(w), (int)XT_TO_INT(h), c);
}

void XT_DrawRectangleRec(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                         uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {(float)XT_TO_INT(x), (float)XT_TO_INT(y),
                     (float)XT_TO_INT(w), (float)XT_TO_INT(h)};
    DrawRectangleRec(rec, c);
}

void XT_DrawRectangleLines(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                           uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawRectangleLines((int)XT_TO_INT(x), (int)XT_TO_INT(y),
                       (int)XT_TO_INT(w), (int)XT_TO_INT(h), c);
}

// 圆角矩形:roundPct 为圆角百分比(0-100,对应 raylib roundness 0.0-1.0),segments 固定 12
void XT_DrawRectangleRounded(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                             uintptr_t roundPct,
                             uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {(float)XT_TO_INT(x), (float)XT_TO_INT(y),
                     (float)XT_TO_INT(w), (float)XT_TO_INT(h)};
    float roundness = (float)XT_TO_INT(roundPct) / 100.0f;
    if (roundness < 0.0f) roundness = 0.0f;
    if (roundness > 1.0f) roundness = 1.0f;
    DrawRectangleRounded(rec, roundness, 12, c);
}

// 圆角矩形描边:lineThick 线宽(像素)
void XT_DrawRectangleRoundedLines(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                                  uintptr_t roundPct, uintptr_t lineThick,
                                  uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {(float)XT_TO_INT(x), (float)XT_TO_INT(y),
                     (float)XT_TO_INT(w), (float)XT_TO_INT(h)};
    float roundness = (float)XT_TO_INT(roundPct) / 100.0f;
    if (roundness < 0.0f) roundness = 0.0f;
    if (roundness > 1.0f) roundness = 1.0f;
    float thick = (float)XT_TO_INT(lineThick);
    if (thick < 1.0f) thick = 1.0f;
    DrawRectangleRoundedLinesEx(rec, roundness, 12, thick, c);
}

// ---- 千分定点坐标(×1000 → float):亚像素平滑绘制,微交互/动画专用 ----
// 整数坐标在 2~3px 行程的动画里只剩两三档台阶;小数坐标交给 GPU(MSAA/双线性)逐帧平滑插值。
static float xt_kf(uintptr_t v) { return (float)XT_TO_INT(v) / 1000.0f; }

void XT_DrawRectFP(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                   uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {xt_kf(x), xt_kf(y), xt_kf(w), xt_kf(h)};
    DrawRectangleRec(rec, c);
}

void XT_DrawRectLinesFP(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h, uintptr_t lineThick,
                        uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {xt_kf(x), xt_kf(y), xt_kf(w), xt_kf(h)};
    float thick = (float)XT_TO_INT(lineThick);
    if (thick < 1.0f) thick = 1.0f;
    DrawRectangleLinesEx(rec, thick, c);
}

void XT_DrawRoundedRectFP(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h, uintptr_t roundPct,
                          uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {xt_kf(x), xt_kf(y), xt_kf(w), xt_kf(h)};
    float roundness = (float)XT_TO_INT(roundPct) / 100.0f;
    if (roundness < 0.0f) roundness = 0.0f;
    if (roundness > 1.0f) roundness = 1.0f;
    DrawRectangleRounded(rec, roundness, 12, c);
}

void XT_DrawRoundedRectLinesFP(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                               uintptr_t roundPct, uintptr_t lineThick,
                               uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Rectangle rec = {xt_kf(x), xt_kf(y), xt_kf(w), xt_kf(h)};
    float roundness = (float)XT_TO_INT(roundPct) / 100.0f;
    if (roundness < 0.0f) roundness = 0.0f;
    if (roundness > 1.0f) roundness = 1.0f;
    float thick = (float)XT_TO_INT(lineThick);
    if (thick < 1.0f) thick = 1.0f;
    DrawRectangleRoundedLinesEx(rec, roundness, 12, thick, c);
}

// ---- 千分定点坐标(×1000 → float):亚像素平滑绘制,微交互/动画专用 ----

void XT_DrawCircle(uintptr_t cx, uintptr_t cy, uintptr_t radius,
                   uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawCircle((int)XT_TO_INT(cx), (int)XT_TO_INT(cy), (float)XT_TO_INT(radius), c);
}

void XT_DrawCircleLines(uintptr_t cx, uintptr_t cy, uintptr_t radius,
                        uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawCircleLines((int)XT_TO_INT(cx), (int)XT_TO_INT(cy), (float)XT_TO_INT(radius), c);
}

void XT_DrawEllipse(uintptr_t cx, uintptr_t cy, uintptr_t rh, uintptr_t rv,
                    uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawEllipse((int)XT_TO_INT(cx), (int)XT_TO_INT(cy),
                (float)XT_TO_INT(rh), (float)XT_TO_INT(rv), c);
}

void XT_DrawTriangle(uintptr_t x1, uintptr_t y1, uintptr_t x2, uintptr_t y2, uintptr_t x3, uintptr_t y3,
                     uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Vector2 v1 = {(float)XT_TO_INT(x1), (float)XT_TO_INT(y1)};
    Vector2 v2 = {(float)XT_TO_INT(x2), (float)XT_TO_INT(y2)};
    Vector2 v3 = {(float)XT_TO_INT(x3), (float)XT_TO_INT(y3)};
    DrawTriangle(v1, v2, v3, c);
}

void XT_DrawPoly(uintptr_t cx, uintptr_t cy, uintptr_t sides, uintptr_t radius, uintptr_t rotation,
                 uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    Vector2 center = {(float)XT_TO_INT(cx), (float)XT_TO_INT(cy)};
    DrawPoly(center, (int)XT_TO_INT(sides), (float)XT_TO_INT(radius), (float)XT_TO_INT(rotation), c);
}

// ============================================================
// 文字绘制
// ============================================================

void XT_DrawText(uintptr_t text, uintptr_t x, uintptr_t y, uintptr_t fontSize,
                 uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
    Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
               (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    DrawText(xt_get_cstr(text), (int)XT_TO_INT(x), (int)XT_TO_INT(y),
             (int)XT_TO_INT(fontSize), c);
}

uintptr_t XT_MeasureText(uintptr_t text, uintptr_t fontSize) {
    return XT_FROM_INT(MeasureText(xt_get_cstr(text), (int)XT_TO_INT(fontSize)));
}

void XT_DrawFPS(uintptr_t x, uintptr_t y) {
    DrawFPS((int)XT_TO_INT(x), (int)XT_TO_INT(y));
}

// ============================================================
// 纹理与图像
// ============================================================

// 纹理句柄池:返回 1-based 标记整数索引(与字体句柄同方案)。
// 历史教训:此前直接返回裸 Texture2D* 指针,玄铁 ARC 会把该值当 XTObject 做
// retain/release/析构,读取 Texture2D 字段当 magic → 报堆损坏甚至错误释放 C 内存。
// v1.2.0 起 16→32:UI 图标缓存 + 渐变纹理缓存 + 用户纹理共存,16 槽不够。
static Texture2D xt_tex_pool[32];
static int xt_tex_used[32];

static int xt_tex_alloc(void) {
    for (int i = 0; i < 32; i++) {
        if (!xt_tex_used[i]) return i;
    }
    return -1;
}

static Texture2D* xt_get_tex(uintptr_t v) {
    if (!IS_INT(v)) return NULL;
    int64_t idx = XT_TO_INT(v);
    if (idx < 1 || idx > 32) return NULL;
    if (!xt_tex_used[idx - 1]) return NULL;
    return &xt_tex_pool[idx - 1];
}

// 返回纹理句柄(1-32 的标记整数),失败或满池返回 0
uintptr_t XT_LoadTexture(uintptr_t filename) {
    int slot = xt_tex_alloc();
    if (slot < 0) return XT_FROM_INT(0);
    // 宽字符读文件+内存加载(支持中文路径),扩展名决定解码格式
    const char* path = xt_get_cstr(filename);
    const char* ext = strrchr(path, '.');
    if (!ext) ext = ".png";
    int dataSize = 0;
    unsigned char* data = xt_read_file_bytes(path, &dataSize);
    Texture2D tex;
    memset(&tex, 0, sizeof(tex));
    if (data) {
        Image img = LoadImageFromMemory(ext, data, dataSize);
        free(data);
        if (img.data) {
            tex = LoadTextureFromImage(img);
            UnloadImage(img);
        }
    }
    xt_tex_pool[slot] = tex;
    xt_tex_used[slot] = 1;
    return XT_FROM_INT(slot + 1);
}

void XT_UnloadTexture(uintptr_t texPtr) {
    if (!IS_INT(texPtr)) return;
    int64_t idx = XT_TO_INT(texPtr);
    if (idx < 1 || idx > 32 || !xt_tex_used[idx - 1]) return;
    Texture2D* p = &xt_tex_pool[idx - 1];
    UnloadTexture(*p);
    xt_tex_used[idx - 1] = 0;
}

void XT_DrawTexture(uintptr_t texPtr, uintptr_t x, uintptr_t y, uintptr_t tint_r, uintptr_t tint_g, uintptr_t tint_b, uintptr_t tint_a) {
    Texture2D* p = xt_get_tex(texPtr);
    if (p) {
        Color tint = {(unsigned char)XT_TO_INT(tint_r), (unsigned char)XT_TO_INT(tint_g),
                      (unsigned char)XT_TO_INT(tint_b), (unsigned char)XT_TO_INT(tint_a)};
        DrawTexture(*p, (int)XT_TO_INT(x), (int)XT_TO_INT(y), tint);
    }
}

void XT_DrawTextureEx(uintptr_t texPtr, uintptr_t x, uintptr_t y, uintptr_t rotation, uintptr_t scale,
                      uintptr_t tint_r, uintptr_t tint_g, uintptr_t tint_b, uintptr_t tint_a) {
    Texture2D* p = xt_get_tex(texPtr);
    if (p) {
        Color tint = {(unsigned char)XT_TO_INT(tint_r), (unsigned char)XT_TO_INT(tint_g),
                      (unsigned char)XT_TO_INT(tint_b), (unsigned char)XT_TO_INT(tint_a)};
        Rectangle src = {0, 0, (float)p->width, (float)p->height};
        Vector2 pos = {(float)XT_TO_INT(x), (float)XT_TO_INT(y)};
        Vector2 origin = {0, 0};
        DrawTexturePro(*p, src, (Rectangle){pos.x, pos.y, (float)p->width * XT_TO_INT(scale), (float)p->height * XT_TO_INT(scale)},
                       origin, (float)XT_TO_INT(rotation), tint);
    }
}

// ---- v1.2.0:UI 图标/渐变/羽化支撑 ----

uintptr_t XT_TextureW(uintptr_t texPtr) {
    Texture2D* p = xt_get_tex(texPtr);
    return XT_FROM_INT(p ? p->width : 0);
}
uintptr_t XT_TextureH(uintptr_t texPtr) {
    Texture2D* p = xt_get_tex(texPtr);
    return XT_FROM_INT(p ? p->height : 0);
}

// 整图缩放到指定矩形绘制(图标适配栏高用;绘纹理Ex 的整数倍缩放不够用)
void XT_DrawTextureQuad(uintptr_t texPtr, uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                        uintptr_t tint_r, uintptr_t tint_g, uintptr_t tint_b, uintptr_t tint_a) {
    Texture2D* p = xt_get_tex(texPtr);
    if (!p) return;
    Color tint = {(unsigned char)XT_TO_INT(tint_r), (unsigned char)XT_TO_INT(tint_g),
                  (unsigned char)XT_TO_INT(tint_b), (unsigned char)XT_TO_INT(tint_a)};
    DrawTexturePro(*p, (Rectangle){0, 0, (float)p->width, (float)p->height},
                   (Rectangle){(float)XT_TO_INT(x), (float)XT_TO_INT(y), (float)XT_TO_INT(w), (float)XT_TO_INT(h)},
                   (Vector2){0, 0}, 0.0f, tint);
}

// 纹理目标矩形千分定点版(UI 渐变背景随微交互几何移动用)
void XT_DrawTextureQuadFP(uintptr_t texPtr, uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h,
                          uintptr_t tint_r, uintptr_t tint_g, uintptr_t tint_b, uintptr_t tint_a) {
    Texture2D* p = xt_get_tex(texPtr);
    if (!p) return;
    Color tint = {(unsigned char)XT_TO_INT(tint_r), (unsigned char)XT_TO_INT(tint_g),
                  (unsigned char)XT_TO_INT(tint_b), (unsigned char)XT_TO_INT(tint_a)};
    DrawTexturePro(*p, (Rectangle){0, 0, (float)p->width, (float)p->height},
                   (Rectangle){xt_kf(x), xt_kf(y), xt_kf(w), xt_kf(h)},
                   (Vector2){0, 0}, 0.0f, tint);
}

// SVG 纹理:nanosvg 解析+光栅化为 RGBA 位图后上 GPU。宽/高传 0 则取 SVG 固有尺寸,
// 否则等比缩放到恰好放入 w×h(居中左上对齐)。宽字符读文件,中文路径安全。
uintptr_t XT_LoadTextureSVG(uintptr_t filename, uintptr_t w, uintptr_t h) {
    int slot = xt_tex_alloc();
    if (slot < 0) return XT_FROM_INT(0);
    Texture2D tex;
    memset(&tex, 0, sizeof(tex));
    int dataSize = 0;
    unsigned char* data = xt_read_file_bytes(xt_get_cstr(filename), &dataSize);
    if (data) {
        // nsvgParse 会原地修改缓冲,且要求 NUL 结尾
        char* buf = (char*)malloc((size_t)dataSize + 1);
        memcpy(buf, data, dataSize);
        buf[dataSize] = 0;
        free(data);
        NSVGimage* svg = nsvgParse(buf, "px", 96.0f);
        free(buf);
        if (svg) {
            int W = (int)XT_TO_INT(w), H = (int)XT_TO_INT(h);
            if (W <= 0) W = (int)svg->width;
            if (H <= 0) H = (int)svg->height;
            if (W > 0 && H > 0 && svg->width > 0 && svg->height > 0) {
                float sc = (float)W / svg->width;
                float sc2 = (float)H / svg->height;
                if (sc2 < sc) sc = sc2;
                unsigned char* rgba = (unsigned char*)calloc((size_t)W * H * 4, 1);
                NSVGrasterizer* rast = nsvgCreateRasterizer();
                nsvgRasterize(rast, svg, 0, 0, sc, rgba, W, H, W * 4);
                nsvgDeleteRasterizer(rast);
                Image img;
                img.data = rgba;
                img.width = W;
                img.height = H;
                img.mipmaps = 1;
                img.format = PIXELFORMAT_UNCOMPRESSED_R8G8B8A8;
                tex = LoadTextureFromImage(img);
                free(rgba);
            }
            nsvgDelete(svg);
        }
    }
    xt_tex_pool[slot] = tex;
    xt_tex_used[slot] = 1;
    return XT_FROM_INT(slot + 1);
}

// 圆角渐变纹理生成器:逐像素双色线性插值 + 圆角矩形 SDF 覆盖度。
// 一份代码同时解决:背景渐变(横/竖)、渐变色的圆角抗锯齿、边缘羽化(羽化>1)。
// 方向: 0=横向 1=竖向;羽化: 边缘过渡像素数(1=仅抗锯齿);圆角: 像素(0=直角)。
// 带 8 槽参数缓存:UI 每帧用同参调用直接命中,不重复生成;缓存满轮转淘汰并释放旧纹理。
typedef struct {
    int w, h, dir, radius, feather;
    unsigned char c1[4], c2[4];
    int slot;   // 纹理池槽位(0-based);-1=空项
} XT_GradEntry;
static XT_GradEntry xt_grad_cache[8];
static int xt_grad_init = 0;

uintptr_t XT_GenGradientTexture(uintptr_t w, uintptr_t h,
                                uintptr_t r1, uintptr_t g1, uintptr_t b1, uintptr_t a1,
                                uintptr_t r2, uintptr_t g2, uintptr_t b2, uintptr_t a2,
                                uintptr_t dir, uintptr_t radius, uintptr_t feather) {
    int W = (int)XT_TO_INT(w), H = (int)XT_TO_INT(h);
    int D = (int)XT_TO_INT(dir), R = (int)XT_TO_INT(radius), F = (int)XT_TO_INT(feather);
    if (W <= 0 || H <= 0) return XT_FROM_INT(0);
    if (R < 0) R = 0;
    if (F < 1) F = 1;
    unsigned char c1[4] = {(unsigned char)XT_TO_INT(r1), (unsigned char)XT_TO_INT(g1),
                           (unsigned char)XT_TO_INT(b1), (unsigned char)XT_TO_INT(a1)};
    unsigned char c2[4] = {(unsigned char)XT_TO_INT(r2), (unsigned char)XT_TO_INT(g2),
                           (unsigned char)XT_TO_INT(b2), (unsigned char)XT_TO_INT(a2)};
    if (!xt_grad_init) {
        for (int i = 0; i < 8; i++) xt_grad_cache[i].slot = -1;
        xt_grad_init = 1;
    }
    for (int i = 0; i < 8; i++) {
        XT_GradEntry* e = &xt_grad_cache[i];
        if (e->slot >= 0 && e->w == W && e->h == H && e->dir == D && e->radius == R && e->feather == F
            && memcmp(e->c1, c1, 4) == 0 && memcmp(e->c2, c2, 4) == 0) {
            return XT_FROM_INT(e->slot + 1);
        }
    }
    int slot = xt_tex_alloc();
    if (slot < 0) {
        // 池满:淘汰最老缓存项腾槽(淘汰项若正被绘制会在下一帧重建,可接受)
        int victim = -1;
        for (int i = 0; i < 8; i++) {
            if (xt_grad_cache[i].slot >= 0) { victim = i; break; }
        }
        if (victim < 0) return XT_FROM_INT(0);
        slot = xt_grad_cache[victim].slot;
        UnloadTexture(xt_tex_pool[slot]);
        xt_tex_used[slot] = 0;
        xt_grad_cache[victim].slot = -1;
        slot = xt_tex_alloc();
        if (slot < 0) return XT_FROM_INT(0);
    }
    unsigned char* px = (unsigned char*)malloc((size_t)W * H * 4);
    if (!px) return XT_FROM_INT(0);
    float halfW = W * 0.5f, halfH = H * 0.5f;
    float inW = halfW - R, inH = halfH - R;
    if (inW < 0) inW = 0;
    if (inH < 0) inH = 0;
    for (int py = 0; py < H; py++) {
        for (int pxx = 0; pxx < W; pxx++) {
            float t = (D == 0) ? ((W > 1) ? (float)pxx / (float)(W - 1) : 0.0f)
                               : ((H > 1) ? (float)py / (float)(H - 1) : 0.0f);
            // 圆角矩形 SDF(负值在形内)
            float qx = fabsf(pxx + 0.5f - halfW) - inW;
            float qy = fabsf(py + 0.5f - halfH) - inH;
            float ax = qx > 0 ? qx : 0.0f, ay = qy > 0 ? qy : 0.0f;
            float mx = qx > qy ? qx : qy;
            float d = sqrtf(ax * ax + ay * ay) + (mx < 0 ? mx : 0.0f) - R;
            float cov = 0.5f - d / (float)F;
            if (cov < 0) cov = 0;
            if (cov > 1) cov = 1;
            unsigned char* o = px + ((size_t)py * W + pxx) * 4;
            o[0] = (unsigned char)(c1[0] + (int)((c2[0] - c1[0]) * t));
            o[1] = (unsigned char)(c1[1] + (int)((c2[1] - c1[1]) * t));
            o[2] = (unsigned char)(c1[2] + (int)((c2[2] - c1[2]) * t));
            o[3] = (unsigned char)((c1[3] + (int)((c2[3] - c1[3]) * t)) * cov);
        }
    }
    Image img;
    img.data = px;
    img.width = W;
    img.height = H;
    img.mipmaps = 1;
    img.format = PIXELFORMAT_UNCOMPRESSED_R8G8B8A8;
    Texture2D tex = LoadTextureFromImage(img);
    free(px);
    xt_tex_pool[slot] = tex;
    xt_tex_used[slot] = 1;
    // 登记缓存(优先空项,无空项轮转淘汰最老的)
    int ci = -1;
    for (int i = 0; i < 8; i++) {
        if (xt_grad_cache[i].slot < 0) { ci = i; break; }
    }
    if (ci < 0) {
        ci = 0;
        UnloadTexture(xt_tex_pool[xt_grad_cache[0].slot]);
        xt_tex_used[xt_grad_cache[0].slot] = 0;
    }
    xt_grad_cache[ci].w = W;
    xt_grad_cache[ci].h = H;
    xt_grad_cache[ci].dir = D;
    xt_grad_cache[ci].radius = R;
    xt_grad_cache[ci].feather = F;
    memcpy(xt_grad_cache[ci].c1, c1, 4);
    memcpy(xt_grad_cache[ci].c2, c2, 4);
    xt_grad_cache[ci].slot = slot;
    return XT_FROM_INT(slot + 1);
}

// ============================================================
// 输入
// ============================================================

uintptr_t XT_IsKeyDown(uintptr_t key) {
    return IsKeyDown((int)XT_TO_INT(key)) ? 1 : 0;
}

uintptr_t XT_IsKeyPressed(uintptr_t key) {
    return IsKeyPressed((int)XT_TO_INT(key)) ? 1 : 0;
}

uintptr_t XT_GetKeyPressed(void) {
    return XT_FROM_INT(GetKeyPressed());
}

// Unicode 码点输入(文本输入框地基):中文 IME 上屏字符经 WM_CHAR 可收到,
// 无候选框跟随;返回 0 表示队列空(调用方循环取到 0 为止)
uintptr_t XT_GetCharPressed(void) {
    return XT_FROM_INT(GetCharPressed());
}

uintptr_t XT_IsMouseButtonDown(uintptr_t button) {
    return IsMouseButtonDown((int)XT_TO_INT(button)) ? 1 : 0;
}

uintptr_t XT_IsMouseButtonPressed(uintptr_t button) {
    return IsMouseButtonPressed((int)XT_TO_INT(button)) ? 1 : 0;
}

uintptr_t XT_GetMouseX(void) {
    return XT_FROM_INT(GetMouseX());
}

uintptr_t XT_GetMouseY(void) {
    return XT_FROM_INT(GetMouseY());
}

uintptr_t XT_GetMouseWheelMove(void) {
    return XT_FROM_INT((int)GetMouseWheelMove());
}

// ============================================================
// 随机
// ============================================================

uintptr_t XT_GetRandomValue(uintptr_t min, uintptr_t max) {
    return XT_FROM_INT(GetRandomValue((int)XT_TO_INT(min), (int)XT_TO_INT(max)));
}

// ============================================================
// 计时
// ============================================================

uintptr_t XT_GetTime(void) {
    return xt_make_float(GetTime());
}

void XT_WaitTime(uintptr_t seconds) {
    WaitTime(xt_get_float(seconds));
}

// ============================================================
// 音频 (简化版)
// ============================================================

void XT_InitAudioDevice(void) {
    InitAudioDevice();
}

void XT_CloseAudioDevice(void) {
    CloseAudioDevice();
}

uintptr_t XT_LoadSound(uintptr_t filename) {
    Sound s = LoadSound(xt_get_cstr(filename));
    Sound* p = (Sound*)calloc(1, sizeof(Sound));
    *p = s;
    return (uintptr_t)p;
}

void XT_UnloadSound(uintptr_t sndPtr) {
    if (IS_PTR(sndPtr) && sndPtr != 0) {
        Sound* p = (Sound*)sndPtr;
        UnloadSound(*p);
        free((void*)p);
    }
}

void XT_PlaySound(uintptr_t sndPtr) {
    if (IS_PTR(sndPtr) && sndPtr != 0) {
        PlaySound(*(Sound*)sndPtr);
    }
}

uintptr_t XT_LoadMusicStream(uintptr_t filename) {
    Music m = LoadMusicStream(xt_get_cstr(filename));
    Music* p = (Music*)calloc(1, sizeof(Music));
    *p = m;
    return (uintptr_t)p;
}

void XT_PlayMusicStream(uintptr_t musicPtr) {
    if (IS_PTR(musicPtr) && musicPtr != 0) {
        PlayMusicStream(*(Music*)musicPtr);
    }
}

void XT_UpdateMusicStream(uintptr_t musicPtr) {
    if (IS_PTR(musicPtr) && musicPtr != 0) {
        UpdateMusicStream(*(Music*)musicPtr);
    }
}

void XT_StopMusicStream(uintptr_t musicPtr) {
    if (IS_PTR(musicPtr) && musicPtr != 0) {
        StopMusicStream(*(Music*)musicPtr);
    }
}

void XT_UnloadMusicStream(uintptr_t musicPtr) {
    if (IS_PTR(musicPtr) && musicPtr != 0) {
        UnloadMusicStream(*(Music*)musicPtr);
        free((void*)musicPtr);
    }
}

// ============================================================
// 字体 —— 支持自定义 TTF/OTC 字形
// 使用静态数组存储，返回整数索引（标记为 XT 整数）避免被 GC 误判
// ============================================================

static Font xt_font_pool[8];
static int  xt_font_count = 0;

// 辅助：从 XT 值提取 Font 指针
static Font* xt_get_font(uintptr_t fontVal) {
    if (!IS_INT(fontVal)) return NULL;
    int64_t idx = XT_TO_INT(fontVal);
    if (idx < 1 || idx > xt_font_count) return NULL;
    return &xt_font_pool[idx - 1];
}

// 返回整数句柄（1-8），失败返回 0
uintptr_t XT_LoadFont(uintptr_t filename, uintptr_t fontSize) {
    if (xt_font_count >= 8) return XT_FROM_INT(0);

    // ASCII (32-126) + CJK 统一汉字基本区 (U+4E00–U+9FFF, ~21K)
    // + 拉丁补充(U+00A0–U+00FF,含间隔号「·」) + 通用标点(U+2018–U+2026,引号/破折号/省略号)
    // + CJK 标点(U+3000–U+303F,全角标点)。否则常用符号显示为「?」(实测 U+00B7 缺失)
    int asciiCount = 95;
    int cjkCount = 0x9FFF - 0x4E00 + 1;  // 20992 个汉字
    int latinCount = 0x00FF - 0x00A0 + 1;
    int punctCount = 0x2026 - 0x2018 + 1;
    int cjkPunctCount = 0x303F - 0x3000 + 1;
    int cpCount = asciiCount + cjkCount + latinCount + punctCount + cjkPunctCount;
    int* codepoints = (int*)malloc((size_t)cpCount * sizeof(int));
    if (!codepoints) return XT_FROM_INT(0);
    int idx = 0;
    for (int c = 32; c <= 126; c++) codepoints[idx++] = c;
    for (int c = 0x4E00; c <= 0x9FFF; c++) codepoints[idx++] = c;
    for (int c = 0x00A0; c <= 0x00FF; c++) codepoints[idx++] = c;
    for (int c = 0x2018; c <= 0x2026; c++) codepoints[idx++] = c;
    for (int c = 0x3000; c <= 0x303F; c++) codepoints[idx++] = c;

    // 宽字符读文件+内存加载(支持中文路径)
    int dataSize = 0;
    unsigned char* data = xt_read_file_bytes(xt_get_cstr(filename), &dataSize);
    if (!data) { free(codepoints); return XT_FROM_INT(0); }
    Font f = LoadFontFromMemory(".ttf", data, dataSize, (int)XT_TO_INT(fontSize), codepoints, cpCount);
    free(data);
    free(codepoints);
    if (f.glyphCount == 0) f = GetFontDefault();

    xt_font_pool[xt_font_count] = f;
    xt_font_count++;
    return XT_FROM_INT(xt_font_count);  // 返回 1-based 整数索引
}

// 加载字体 + 从参考文本提取码点（精准模式，纹理更小，100% 覆盖所需字符）
uintptr_t XT_LoadFontEx(uintptr_t filename, uintptr_t fontSize, uintptr_t refText) {
    if (xt_font_count >= 8) return XT_FROM_INT(0);

    const char* ref = xt_get_cstr(refText);
    int refLen = (int)strlen(ref);

    // 最多 95 ASCII + refLen 个额外码点
    int* codepoints = (int*)malloc((size_t)(95 + refLen) * sizeof(int));
    if (!codepoints) return XT_FROM_INT(0);
    int idx = 0;
    for (int c = 32; c <= 126; c++) codepoints[idx++] = c;

    // UTF-8 解码参考文本，收集非 ASCII 码点（去重）
    int bp = 0;
    while (bp < refLen) {
        int cp = 0;
        unsigned char b0 = (unsigned char)ref[bp];
        if (b0 < 0x80)      { cp = b0; bp += 1; }
        else if (b0 < 0xE0) { cp = ((b0 & 0x1F) << 6)  | (ref[bp+1] & 0x3F); bp += 2; }
        else if (b0 < 0xF0) { cp = ((b0 & 0x0F) << 12) | ((ref[bp+1] & 0x3F) << 6) | (ref[bp+2] & 0x3F); bp += 3; }
        else                { cp = ((b0 & 0x07) << 18) | ((ref[bp+1] & 0x3F) << 12) | ((ref[bp+2] & 0x3F) << 6) | (ref[bp+3] & 0x3F); bp += 4; }
        if (cp < 32 || cp > 126) {  // 非 ASCII
            int dup = 0;
            for (int j = 95; j < idx; j++) { if (codepoints[j] == cp) { dup = 1; break; } }
            if (!dup) codepoints[idx++] = cp;
        }
    }

    // 宽字符读文件+内存加载(支持中文路径)
    int dataSizeEx = 0;
    unsigned char* dataEx = xt_read_file_bytes(xt_get_cstr(filename), &dataSizeEx);
    if (!dataEx) { free(codepoints); return XT_FROM_INT(0); }
    Font f = LoadFontFromMemory(".ttf", dataEx, dataSizeEx, (int)XT_TO_INT(fontSize), codepoints, idx);
    free(dataEx);
    free(codepoints);
    if (f.glyphCount == 0) f = GetFontDefault();

    xt_font_pool[xt_font_count] = f;
    xt_font_count++;
    return XT_FROM_INT(xt_font_count);
}

#ifdef _WIN32
/* GDI 字体(系统级光栅化)前向声明——实现在文件尾 GDI 段 */
uintptr_t XT_FontGDI_Create(uintptr_t faceVal, uintptr_t sizeVal);
void XT_FontGDI_DrawText(uintptr_t handle, uintptr_t text, uintptr_t x, uintptr_t y,
                         uintptr_t fontSize, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a,
                         uintptr_t spacing);
void XT_FontGDI_DrawTextFP(uintptr_t handle, uintptr_t text, uintptr_t x1000, uintptr_t y1000,
                           uintptr_t scale1000,
                           uintptr_t fontSize, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a,
                           uintptr_t spacing);
uintptr_t XT_FontGDI_Measure(uintptr_t handle, uintptr_t text, uintptr_t fontSize, uintptr_t spacing);
void XT_FontGDI_Unload(uintptr_t handle);
#endif

void XT_UnloadFont(uintptr_t fontHandle) {
#ifdef _WIN32
    if (XT_TO_INT(fontHandle) >= 100) { XT_FontGDI_Unload(fontHandle); return; }
#endif
    Font* p = xt_get_font(fontHandle);
    if (p) {
        // 避免卸载 raylib 默认字体（baseSize 为默认字体的标记）
        if (p->glyphCount > 0 && p->texture.id != GetFontDefault().texture.id) {
            UnloadFont(*p);
        }
    }
}

void XT_DrawTextEx(uintptr_t fontHandle, uintptr_t text, uintptr_t x, uintptr_t y,
                   uintptr_t fontSize, uintptr_t spacing,
                   uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
#ifdef _WIN32
    if (XT_TO_INT(fontHandle) >= 100) {   // GDI 字体(系统级光栅化)
        XT_FontGDI_DrawText(fontHandle, text, x, y, fontSize, r, g, b, a, spacing);
        return;
    }
#endif
    Font* p = xt_get_font(fontHandle);
    if (p) {
        Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
                   (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
        Vector2 pos = {(float)XT_TO_INT(x), (float)XT_TO_INT(y)};
        DrawTextEx(*p, xt_get_cstr(text), pos, (float)XT_TO_INT(fontSize),
                   (float)XT_TO_INT(spacing), c);
    }
}

// 千分定点坐标版文字绘制(亚像素;UI 微交互动画用。scale1000: 1000=原倍,GDI 走图集 GPU 缩放)
void XT_DrawTextExFP(uintptr_t fontHandle, uintptr_t text, uintptr_t x1000, uintptr_t y1000,
                     uintptr_t scale1000,
                     uintptr_t fontSize, uintptr_t spacing,
                     uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a) {
#ifdef _WIN32
    if (XT_TO_INT(fontHandle) >= 100) {   // GDI 字体(系统级光栅化)
        XT_FontGDI_DrawTextFP(fontHandle, text, x1000, y1000, scale1000, fontSize, r, g, b, a, spacing);
        return;
    }
#endif
    Font* p = xt_get_font(fontHandle);
    if (p) {
        Color c = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
                   (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
        Vector2 pos = {(float)XT_TO_INT(x1000) / 1000.0f, (float)XT_TO_INT(y1000) / 1000.0f};
        float fsz = (float)XT_TO_INT(fontSize) * ((float)XT_TO_INT(scale1000) / 1000.0f);
        DrawTextEx(*p, xt_get_cstr(text), pos, fsz,
                   (float)XT_TO_INT(spacing), c);
    }
}

// 用指定字体测量文字宽度（UI 布局需要精确宽度做控件尺寸与居中）
uintptr_t XT_MeasureTextEx(uintptr_t fontHandle, uintptr_t text, uintptr_t fontSize, uintptr_t spacing) {
#ifdef _WIN32
    if (XT_TO_INT(fontHandle) >= 100) {   // GDI 精确度量
        return XT_FontGDI_Measure(fontHandle, text, fontSize, spacing);
    }
#endif
    Font* p = xt_get_font(fontHandle);
    if (!p) return XT_FROM_INT(0);
    Vector2 v = MeasureTextEx(*p, xt_get_cstr(text), (float)XT_TO_INT(fontSize), (float)XT_TO_INT(spacing));
    return XT_FROM_INT((int64_t)(v.x + 0.5));
}

#ifdef _WIN32
// ============================================================
// GDI 字体(Windows 系统级光栅化:按需栅格化 + 动态图集缓存)
// 视觉效果 = 系统灰阶抗锯齿(GetGlyphOutlineW XT_GGO_GRAY8,与系统应用同级);
// 无需 ttf 文件(直接用系统字体名,如 微软雅黑);生僻字由系统字体引擎自动回落。
// 句柄规则:>= 100 为 GDI 字体;XT_DrawTextEx/XT_MeasureTextEx/XT_UnloadFont 自动分派。
// 延续桥内风格:不包 <windows.h>(与 raylib 符号冲突),GDI 声明手写,
// 布局以 _Static_assert 编译期自检(若 SDK 布局漂移,编译即炸,不静默错)。
// ============================================================
typedef void* XT_HDC;
typedef void* XT_HFONT;
typedef void* XT_HGDIOBJ;
typedef unsigned short XT_WCHAR;
typedef unsigned char XT_BYTE;
typedef struct { short fract; short value; } XT_FIXED;
typedef struct { XT_FIXED eM11, eM12, eM21, eM22; } XT_MAT2;
typedef struct {
    unsigned int gmBlackBoxX, gmBlackBoxY;
    XT_POINT gmptGlyphOrigin;
    short gmCellIncX, gmCellIncY;
} XT_GLYPHMETRICS;
typedef struct { long cx, cy; } XT_SIZE;
typedef struct {
    long tmHeight, tmAscent, tmDescent, tmInternalLeading, tmExternalLeading;
    long tmAveCharWidth, tmMaxCharWidth, tmWeight, tmOverhang, tmDigitizedAspectX, tmDigitizedAspectY;
    XT_WCHAR tmFirstChar, tmLastChar, tmDefaultChar, tmBreakChar;
    XT_BYTE tmItalic, tmUnderlined, tmStruckOut, tmPitchAndFamily, tmCharSet;
} XT_TEXTMETRICW;
_Static_assert(sizeof(XT_MAT2) == 16, "XT_MAT2 布局漂移");
_Static_assert(sizeof(XT_GLYPHMETRICS) == 20, "XT_GLYPHMETRICS 布局漂移");
_Static_assert(sizeof(XT_TEXTMETRICW) == 60, "XT_TEXTMETRICW 布局漂移");

extern __declspec(dllimport) XT_HFONT WINAPI CreateFontW(
    int, int, int, int, int, unsigned long, unsigned long, unsigned long,
    unsigned long, unsigned long, unsigned long, unsigned long, unsigned long, const wchar_t*);
extern __declspec(dllimport) unsigned long WINAPI GetGlyphOutlineW(
    XT_HDC, unsigned int, unsigned int, XT_GLYPHMETRICS*, unsigned long, void*, const XT_MAT2*);
extern __declspec(dllimport) XT_HDC WINAPI CreateCompatibleDC(XT_HDC);
extern __declspec(dllimport) XT_HGDIOBJ WINAPI SelectObject(XT_HDC, XT_HGDIOBJ);
extern __declspec(dllimport) int WINAPI DeleteObject(XT_HGDIOBJ);
extern __declspec(dllimport) int WINAPI DeleteDC(XT_HDC);
extern __declspec(dllimport) int WINAPI GetTextMetricsW(XT_HDC, XT_TEXTMETRICW*);
extern __declspec(dllimport) int WINAPI GetTextExtentPoint32W(XT_HDC, const wchar_t*, int, XT_SIZE*);

#define XT_GGO_GRAY8   6   /* GGO_GRAY8_BITMAP(65 级灰阶 0..64);5 是 GRAY4(17 级),曾误用致字形粗大 */
#define XT_FW_NORMAL   400
#define XT_DEFAULT_CHARSET 1

#define XT_GDI_MAX_FONTS 4
#define XT_GDI_ATLAS 2048          /* 图集边长(GRAY_ALPHA 2B/px,8MB) */
#define XT_GDI_HASH_CAP 8192       /* 字形缓存槽数(开放寻址) */

typedef struct {
    int cp;              /* 0 = 空槽 */
    int sizeIdx;
    int w, h;            /* 位图尺寸(0 = 空白字形,如空格) */
    int ox, oy;          /* gmptGlyphOrigin(相对基线) */
    int adv;             /* 前进宽 gmCellIncX */
    int ax, ay;          /* 图集内位置 */
} XTGdiGlyph;

typedef struct {
    int used;
    wchar_t face[64];
    XT_HDC hdc;
    int sizes[8];
    XT_HFONT hfonts[8];
    int ascents[8];      /* 每字号 tmAscent(基线换算用) */
    int sizeCount;
    XTGdiGlyph* hash;    /* XT_GDI_HASH_CAP 开放寻址 */
    Image atlasImg;
    Texture2D atlasTex;
    int atlasReady;
    int curX, curY, rowH;
    int dirty;           /* 本帧有新字形入图集(需 UpdateTexture) */
} XTGdiFont;

static XTGdiFont xt_gdi_fonts[XT_GDI_MAX_FONTS];

/* UTF-8 → 码点(单字符);返回 cp,*adv = 消耗字节数(与 XT_LoadFontEx 的解码同款) */
static int xt_gdi_next_cp(const char* s, int* adv) {
    unsigned char b0 = (unsigned char)s[0];
    if (b0 < 0x80) { *adv = 1; return b0; }
    if (b0 < 0xE0) { *adv = 2; return ((b0 & 0x1F) << 6) | (s[1] & 0x3F); }
    if (b0 < 0xF0) { *adv = 3; return ((b0 & 0x0F) << 12) | ((s[1] & 0x3F) << 6) | (s[2] & 0x3F); }
    *adv = 4;
    return ((b0 & 0x07) << 18) | ((s[1] & 0x3F) << 12) | ((s[2] & 0x3F) << 6) | (s[3] & 0x3F);
}

/* 字号槽:按字号建/取 XT_HFONT 与 ascent */
static int xt_gdi_size_slot(XTGdiFont* f, int size) {
    if (size <= 0) size = 32;
    for (int i = 0; i < f->sizeCount; i++) if (f->sizes[i] == size) return i;
    if (f->sizeCount >= 8) return 0;   /* 槽满回退首字号(罕见:UI 字号有限) */
    int i = f->sizeCount++;
    XT_HFONT hf = CreateFontW(-size, 0, 0, 0, XT_FW_NORMAL, 0, 0, 0, XT_DEFAULT_CHARSET,
                           0, 0, 6,
                           0, f->face);
    if (!hf) return 0;
    f->sizes[i] = size;
    f->hfonts[i] = hf;
    SelectObject(f->hdc, hf);
    XT_TEXTMETRICW tm;
    GetTextMetricsW(f->hdc, &tm);
    f->ascents[i] = tm.tmAscent;
    return i;
}

/* 取字形(未缓存则 GDI 栅格化并入图集);返回 NULL = 无法栅格化 */
static XTGdiGlyph* xt_gdi_glyph_get(XTGdiFont* f, int cp, int sizeIdx) {
    uint32_t h = ((uint32_t)cp * 31u + (uint32_t)sizeIdx) & (XT_GDI_HASH_CAP - 1);
    for (int probe = 0; probe < XT_GDI_HASH_CAP; probe++) {
        int idx = (int)((h + probe) & (XT_GDI_HASH_CAP - 1));
        XTGdiGlyph* g = &f->hash[idx];
        if (g->cp == 0) {
            /* 空槽 → 栅格化 */
            XT_HFONT hf = f->hfonts[sizeIdx];
            SelectObject(f->hdc, hf);
            XT_MAT2 m2 = {{0,1},{0,0},{0,0},{0,1}};
            XT_GLYPHMETRICS gm;
            unsigned long need = GetGlyphOutlineW(f->hdc, (unsigned int)cp, XT_GGO_GRAY8, &gm, 0, NULL, &m2);
            if (need == 0xFFFFFFFFUL) return NULL;   /* GDI_ERROR */
            g->cp = cp;
            g->sizeIdx = sizeIdx;
            g->ox = gm.gmptGlyphOrigin.x;
            g->oy = gm.gmptGlyphOrigin.y;
            g->adv = (int)gm.gmCellIncX;
            g->w = (int)gm.gmBlackBoxX;
            g->h = (int)gm.gmBlackBoxY;
            if (g->adv <= 0) g->adv = f->sizes[sizeIdx] / 2;
            if (need == 0 || g->w <= 0 || g->h <= 0) { g->w = 0; g->h = 0; return g; }   /* 空白字形 */
            /* 图集行架分配 */
            if (f->curX + g->w > XT_GDI_ATLAS) {
                f->curX = 0;
                f->curY += f->rowH + 4;   /* 4px 间隔防双线性渗色 */
                f->rowH = 0;
            }
            if (f->curY + g->h > XT_GDI_ATLAS) return NULL;   /* 图集满(>4000 汉字 UI 用不到) */
            g->ax = f->curX;
            g->ay = f->curY;
            f->curX += g->w + 4;
            if (g->h > f->rowH) f->rowH = g->h;
            /* 取位图(GGO_GRAY8:0..64 灰阶,行 4 字节对齐) */
            unsigned char* bmp = (unsigned char*)malloc(need);
            if (!bmp) return NULL;
            GetGlyphOutlineW(f->hdc, (unsigned int)cp, XT_GGO_GRAY8, &gm, need, bmp, &m2);
            int stride = (g->w + 3) & ~3;
            unsigned char* pix = (unsigned char*)f->atlasImg.data;   /* GRAY_ALPHA: lum,alpha */
            for (int row = 0; row < g->h; row++) {
                for (int col = 0; col < g->w; col++) {
                    int gray = bmp[row * stride + col];              /* 0..64 */
                    int alpha = gray * 4; if (alpha > 255) alpha = 255;
                    size_t off = ((size_t)(g->ay + row) * XT_GDI_ATLAS + (size_t)(g->ax + col)) * 2;
                    pix[off] = 255;                                   /* luminance(白,tint 上色) */
                    pix[off + 1] = (unsigned char)alpha;
                }
            }
            free(bmp);
            f->dirty = 1;
            return g;
        }
        if (g->cp == cp && g->sizeIdx == sizeIdx) return g;   /* 命中 */
    }
    return NULL;
}

/* 创建 GDI 字体上下文;返回 100+索引 句柄,失败返 0 */
uintptr_t XT_FontGDI_Create(uintptr_t faceVal, uintptr_t sizeVal) {
    if (!IS_PTR(faceVal)) return XT_FROM_INT(0);
    const char* faceU8 = xt_get_cstr(faceVal);
    int idx = -1;
    for (int i = 0; i < XT_GDI_MAX_FONTS; i++) if (!xt_gdi_fonts[i].used) { idx = i; break; }
    if (idx < 0) return XT_FROM_INT(0);
    XTGdiFont* f = &xt_gdi_fonts[idx];
    memset(f, 0, sizeof(*f));
    MultiByteToWideChar(65001, 0, faceU8, -1, f->face, 64);
    f->hdc = CreateCompatibleDC(NULL);
    if (!f->hdc) return XT_FROM_INT(0);
    f->hash = (XTGdiGlyph*)calloc(XT_GDI_HASH_CAP, sizeof(XTGdiGlyph));
    if (!f->hash) { DeleteDC(f->hdc); return XT_FROM_INT(0); }
    /* 图集惰性首绘建(GL 上下文须已存在——调用方时序在窗口初始化后) */
    f->atlasImg = GenImageColor(XT_GDI_ATLAS, XT_GDI_ATLAS, (Color){0, 0, 0, 0});
    ImageFormat(&f->atlasImg, PIXELFORMAT_UNCOMPRESSED_GRAY_ALPHA);
    /* 首字号预热(失败 = 字体名无效,整体失败) */
    int baseSize = (int)XT_TO_INT(sizeVal);
    if (xt_gdi_size_slot(f, baseSize) < 0 || f->sizeCount == 0) {
        UnloadImage(f->atlasImg);
        free(f->hash);
        DeleteDC(f->hdc);
        return XT_FROM_INT(0);
    }
    /* 校验字体名真实有效(GDI 会静默回落默认字体——检测 CreateFont 总能成,故仅记录) */
    f->used = 1;
    return XT_FROM_INT(100 + idx);
}

/* GDI 文本绘制实现(float 坐标 + 整体缩放;亚像素平滑支撑微交互动画。
   缩放走图集字形 GPU 拉伸(双线性),不换字号重光栅化——重光栅化 hinting 变化会"变形") */
static void xt_gdi_draw_impl(uintptr_t handle, uintptr_t text, float fx, float fy, float scale,
                             uintptr_t fontSize, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a,
                             uintptr_t spacing) {
    int64_t h64 = XT_TO_INT(handle);
    int idx = (int)(h64 - 100);
    if (idx < 0 || idx >= XT_GDI_MAX_FONTS) return;
    XTGdiFont* f = &xt_gdi_fonts[idx];
    if (!f->used) return;
    int sp = (int)XT_TO_INT(spacing);   // 字距:相邻字符之间(首字符前不加)
    const char* s = xt_get_cstr(text);
    int sizeIdx = xt_gdi_size_slot(f, (int)XT_TO_INT(fontSize));
    /* 第一遍:确保全部码点已栅格化(新字形置 dirty) */
    {
        const char* p = s;
        while (*p) {
            int adv; int cp = xt_gdi_next_cp(p, &adv);
            if (cp < 32) { p += adv; continue; }
            xt_gdi_glyph_get(f, cp, sizeIdx);
            p += adv;
        }
    }
    /* 图集纹理首建,或仅在有新字形时更新(避免每帧全量上传 8MB) */
    if (!f->atlasReady) {
        f->atlasTex = LoadTextureFromImage(f->atlasImg);
        SetTextureFilter(f->atlasTex, TEXTURE_FILTER_BILINEAR);
        f->atlasReady = 1;
        f->dirty = 0;
    } else if (f->dirty) {
        UpdateTexture(f->atlasTex, (const unsigned char*)f->atlasImg.data);
        f->dirty = 0;
    }
    /* 第二遍:绘制(浮点笔位 × 整体缩放,亚像素) */
    Color tint = {(unsigned char)XT_TO_INT(r), (unsigned char)XT_TO_INT(g),
                  (unsigned char)XT_TO_INT(b), (unsigned char)XT_TO_INT(a)};
    float penX = fx;
    float baseTop = fy;
    float spf = (float)sp * scale;
    int ascent = f->ascents[sizeIdx];
    int first = 1;
    const char* p = s;
    while (*p) {
        int adv; int cp = xt_gdi_next_cp(p, &adv);
        p += adv;
        /* 字距加在相邻字符之间(首字符前不加),
           与 Measure 的"每字符一个后置间距槽"严格对齐——选区/光标据此计算才不偏 */
        if (!first) penX += spf;
        first = 0;
        if (cp < 32) { if (cp == ' ') penX += (float)(f->sizes[sizeIdx] / 3 + 1) * scale; continue; }
        XTGdiGlyph* gl = xt_gdi_glyph_get(f, cp, sizeIdx);
        if (!gl) { penX += (float)(f->sizes[sizeIdx] / 2) * scale; continue; }
        if (gl->w > 0 && gl->h > 0) {
            Rectangle src = {(float)gl->ax, (float)gl->ay, (float)gl->w, (float)gl->h};
            if (scale == 1.0f) {
                /* 基线换算:字形顶 = 行顶 + ascent - origin.y */
                Vector2 dst = {penX + (float)gl->ox, baseTop + (float)(ascent - gl->oy)};
                DrawTextureRec(f->atlasTex, src, dst, tint);
            } else {
                Rectangle dstR = {penX + (float)gl->ox * scale,
                                  baseTop + (float)(ascent - gl->oy) * scale,
                                  (float)gl->w * scale, (float)gl->h * scale};
                DrawTexturePro(f->atlasTex, src, dstR, (Vector2){0, 0}, 0.0f, tint);
            }
        }
        penX += (float)(gl->adv > 0 ? gl->adv : adv * f->sizes[sizeIdx] / 3) * scale;
    }
}

/* 绘制文本(GDI 路径):逐码点缓存查询,缺失批量入图集后一次上传,再逐字绘 */
void XT_FontGDI_DrawText(uintptr_t handle, uintptr_t text, uintptr_t x, uintptr_t y,
                         uintptr_t fontSize, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a,
                         uintptr_t spacing) {
    xt_gdi_draw_impl(handle, text, (float)XT_TO_INT(x), (float)XT_TO_INT(y), 1.0f, fontSize, r, g, b, a, spacing);
}

/* 千分定点坐标版(亚像素;微交互动画用;scale1000: 1000=原倍,字形图集 GPU 缩放不重光栅化) */
void XT_FontGDI_DrawTextFP(uintptr_t handle, uintptr_t text, uintptr_t x1000, uintptr_t y1000,
                           uintptr_t scale1000,
                           uintptr_t fontSize, uintptr_t r, uintptr_t g, uintptr_t b, uintptr_t a,
                           uintptr_t spacing) {
    xt_gdi_draw_impl(handle, text, (float)XT_TO_INT(x1000) / 1000.0f, (float)XT_TO_INT(y1000) / 1000.0f,
                     (float)XT_TO_INT(scale1000) / 1000.0f, fontSize, r, g, b, a, spacing);
}

/* 测量文本宽度(GDI 精确度量,GetTextExtentPoint32W;字距按"每字符一个后置间距槽"计 = spacing×字符数,
   使 测量(前缀) 恰为下一字形的左缘,选区/光标/IME 定位全部对齐绘制侧) */
uintptr_t XT_FontGDI_Measure(uintptr_t handle, uintptr_t text, uintptr_t fontSize, uintptr_t spacing) {
    int64_t h64 = XT_TO_INT(handle);
    int idx = (int)(h64 - 100);
    if (idx < 0 || idx >= XT_GDI_MAX_FONTS) return XT_FROM_INT(0);
    XTGdiFont* f = &xt_gdi_fonts[idx];
    if (!f->used) return XT_FROM_INT(0);
    int sp = (int)XT_TO_INT(spacing);
    int sizeIdx = xt_gdi_size_slot(f, (int)XT_TO_INT(fontSize));
    SelectObject(f->hdc, f->hfonts[sizeIdx]);
    const char* s = xt_get_cstr(text);
    int wlen = MultiByteToWideChar(65001, 0, s, -1, NULL, 0);
    if (wlen <= 0) return XT_FROM_INT(0);
    wchar_t* ws = (wchar_t*)malloc((size_t)wlen * sizeof(wchar_t));
    if (!ws) return XT_FROM_INT(0);
    MultiByteToWideChar(65001, 0, s, -1, ws, wlen);
    XT_SIZE ext = {0, 0};
    GetTextExtentPoint32W(f->hdc, ws, wlen - 1, &ext);
    free(ws);
    if (sp > 0) {
        int cps = 0;
        const char* p = s;
        while (*p) { int adv; xt_gdi_next_cp(p, &adv); p += adv; cps++; }
        /* 每字符带一个后置间距槽(sp×cps):前缀测量值即下一字形的左缘,
           选区矩形 [测量(起点前缀), 测量(终点前缀)) 两条边都与绘制侧精确对齐 */
        ext.cx += (int64_t)sp * cps;
    }
    return XT_FROM_INT((int64_t)ext.cx);
}

/* 释放 GDI 字体 */
void XT_FontGDI_Unload(uintptr_t handle) {
    int64_t h64 = XT_TO_INT(handle);
    int idx = (int)(h64 - 100);
    if (idx < 0 || idx >= XT_GDI_MAX_FONTS) return;
    XTGdiFont* f = &xt_gdi_fonts[idx];
    if (!f->used) return;
    for (int i = 0; i < f->sizeCount; i++) DeleteObject(f->hfonts[i]);
    if (f->atlasReady) UnloadTexture(f->atlasTex);
    UnloadImage(f->atlasImg);
    free(f->hash);
    DeleteDC(f->hdc);
    f->used = 0;
}
#endif /* _WIN32 */

/* 截图导出 PNG(当前帧缓冲;渲染调试/自动化验收用——须在 结束绘图 之后调用) */
void XT_SaveScreenshot(uintptr_t pathVal) {
    if (!IS_PTR(pathVal)) return;
    // 不用 raylib TakeScreenshot:它会把 "G:/..." 正斜杠绝对路径也拼上工作目录。
    // ExportImage 底层 fopen:相对路径天然按 CWD 解析,绝对路径原样使用。
    Image img = LoadImageFromScreen();
    if (!img.data) return;
    ExportImage(img, xt_get_cstr(pathVal));
    UnloadImage(img);
}

/* 裁剪(UI 输入栏等需限制绘制区域的控件用):raylib BeginScissorMode/EndScissorMode 桥接 */
void XT_BeginScissor(uintptr_t x, uintptr_t y, uintptr_t w, uintptr_t h) {
    BeginScissorMode((int)XT_TO_INT(x), (int)XT_TO_INT(y), (int)XT_TO_INT(w), (int)XT_TO_INT(h));
}
void XT_EndScissor(void) {
    EndScissorMode();
}

/* 系统剪贴板(输入栏 Ctrl+C/V 用) */
uintptr_t XT_GetClipboard(void) {
    const char* t = GetClipboardText();
    if (!t) t = "";
    return (uintptr_t)xt_string_new(t);
}
void XT_SetClipboard(uintptr_t text) {
    if (!IS_PTR(text)) return;
    SetClipboardText(xt_get_cstr(text));
}

#ifdef _WIN32
/* IME 候选框定位(输入栏获焦/光标移动时调用,让中文输入法候选窗跟随光标) */
typedef void* XT_HWND;
typedef void* XT_HIMC;
typedef struct { long l, t, r, b; } XT_RECT;
typedef struct { unsigned long dwStyle; struct { long x, y; } pt; XT_RECT area; } XT_COMPFORM;
extern __declspec(dllimport) XT_HWND WINAPI GetForegroundWindow(void);
extern __declspec(dllimport) XT_HIMC WINAPI ImmGetContext(XT_HWND);
extern __declspec(dllimport) int WINAPI ImmReleaseContext(XT_HWND, XT_HIMC);
extern __declspec(dllimport) int WINAPI ImmSetCompositionWindow(XT_HIMC, XT_COMPFORM*);
extern __declspec(dllimport) int WINAPI ImmSetCandidateWindow(XT_HIMC, XT_COMPFORM*);
_Static_assert(sizeof(XT_COMPFORM) == 28, "COMPOSITIONFORM 布局漂移");

void XT_SetIMEPos(uintptr_t x, uintptr_t y) {
    XT_HWND hwnd = GetForegroundWindow();
    if (!hwnd) return;
    XT_HIMC himc = ImmGetContext(hwnd);
    if (!himc) return;
    // CFS_FORCE_POSITION|CFS_POINT:候选窗跟随光标。注意 IME 会为被抑制的组合窗
    // 预留约 26px 行高,候选窗落在 pt 下方约 26px——由调用方(UI 输入栏)补偿。
    // CFS_CANDIDATEPOS 被部分 IME 忽视;CFS_RECT 会被微软拼音误判翻到上方。
    XT_COMPFORM cf;
    memset(&cf, 0, sizeof(cf));
    cf.dwStyle = 0x0022;
    cf.pt.x = (long)XT_TO_INT(x);
    cf.pt.y = (long)XT_TO_INT(y);
    ImmSetCompositionWindow(himc, &cf);
    ImmReleaseContext(hwnd, himc);
}

/* ---- IME 内联组合(拼音串直接显示在输入栏内) ----
   原理:子类化 raylib 窗口 WndProc,拦 WM_IME_COMPOSITION 读组合中串(GCS_COMPSTR)存全局,
   消息照常放行给 GLFW(结果字符经 GetCharPressed 上屏,路径不变)。
   组合串由 UI 输入栏自绘(下划线样式),实现"拼音打在栏内"。 */
typedef intptr_t (WINAPI *XT_WNDPROC)(XT_HWND, unsigned int, uintptr_t, intptr_t);
extern __declspec(dllimport) intptr_t WINAPI SetWindowLongPtrW(XT_HWND, int, intptr_t);
extern __declspec(dllimport) intptr_t WINAPI CallWindowProcW(XT_WNDPROC, XT_HWND, unsigned int, uintptr_t, intptr_t);
extern __declspec(dllimport) long WINAPI ImmGetCompositionStringW(XT_HIMC, unsigned long, void*, unsigned long);
extern __declspec(dllimport) int WINAPI WideCharToMultiByte(unsigned int, unsigned long, const wchar_t*, int, char*, int, void*, void*);

#define XT_WM_IME_STARTCOMP  0x010D
#define XT_WM_IME_ENDCOMP    0x010E
#define XT_WM_IME_COMP       0x010F
#define XT_GCS_COMPSTR       0x0008
#define XT_GWLP_WNDPROC      (-4)

static XT_WNDPROC xt_glfw_proc = NULL;
static wchar_t xt_ime_comp[256];
static int xt_ime_comp_len = 0;

static intptr_t WINAPI xt_ime_wndproc(XT_HWND hwnd, unsigned int msg, uintptr_t wp, intptr_t lp) {
    if (msg == XT_WM_IME_STARTCOMP) {
        // 吃掉开始组合:不创建 IME 原生组合窗(拼音串由输入栏内联自绘);
        // 不放行给 GLFW——GLFW 不需要该消息来收结果字符(结果走 COMPOSITION 的 RESULTSTR)
        xt_ime_comp_len = 0;
        xt_ime_comp[0] = 0;
        return 0;
    } else if (msg == XT_WM_IME_ENDCOMP) {
        xt_ime_comp_len = 0;
        xt_ime_comp[0] = 0;
    } else if (msg == XT_WM_IME_COMP) {
        if (lp & XT_GCS_COMPSTR) {
            XT_HIMC himc = ImmGetContext(hwnd);
            if (himc) {
                long n = ImmGetCompositionStringW(himc, XT_GCS_COMPSTR, NULL, 0);
                if (n > 0 && n < 510) {
                    ImmGetCompositionStringW(himc, XT_GCS_COMPSTR, xt_ime_comp, (unsigned long)(n + 2));
                    xt_ime_comp_len = (int)(n / 2);
                    xt_ime_comp[xt_ime_comp_len] = 0;
                } else {
                    xt_ime_comp_len = 0;
                    xt_ime_comp[0] = 0;
                }
                ImmReleaseContext(hwnd, himc);
            }
        }
    }
    return CallWindowProcW(xt_glfw_proc, hwnd, msg, wp, lp);
}

/* 安装 IME 钩子(窗口初始化后调用,幂等);成功返 1 */
uintptr_t XT_IME_Hook(void) {
    XT_HWND hwnd = (XT_HWND)GetWindowHandle();
    if (!hwnd) return XT_FROM_INT(0);
    if (xt_glfw_proc) return XT_FROM_INT(1);
    intptr_t old = SetWindowLongPtrW(hwnd, XT_GWLP_WNDPROC, (intptr_t)xt_ime_wndproc);
    if (!old) return XT_FROM_INT(0);
    xt_glfw_proc = (XT_WNDPROC)old;
    return XT_FROM_INT(1);
}

/* 当前组合中串(UTF-8;无组合时返空串) */
uintptr_t XT_IME_GetComp(void) {
    if (xt_ime_comp_len <= 0) return (uintptr_t)xt_string_new("");
    char u8[768];
    int n = WideCharToMultiByte(65001, 0, xt_ime_comp, xt_ime_comp_len, u8, 767, NULL, NULL);
    if (n <= 0) return (uintptr_t)xt_string_new("");
    u8[n] = 0;
    return (uintptr_t)xt_string_new(u8);
}

/* ---- IME 启用/禁用(输入栏焦点开关) ----
   无输入栏焦点时断开窗口的 IME 上下文:组合与候选窗整体不再产生
   (此前失焦打字候选窗失去定位点,落在屏幕右下角);获焦时恢复保存的上下文。幂等。 */
extern __declspec(dllimport) XT_HIMC WINAPI ImmAssociateContextEx(XT_HWND, XT_HIMC, unsigned long);

static XT_HIMC xt_ime_saved_himc = NULL;
static int xt_ime_enabled = 1;

uintptr_t XT_IME_Enable(uintptr_t on) {
    XT_HWND hwnd = (XT_HWND)GetWindowHandle();
    if (!hwnd) return XT_FROM_INT(0);
    int want = XT_TO_INT(on) ? 1 : 0;
    if (want == xt_ime_enabled) return XT_FROM_INT(1);
    if (want) {
        if (xt_ime_saved_himc) ImmAssociateContextEx(hwnd, xt_ime_saved_himc, 0);
        xt_ime_enabled = 1;
    } else {
        XT_HIMC himc = ImmGetContext(hwnd);
        if (himc) { xt_ime_saved_himc = himc; ImmReleaseContext(hwnd, himc); }
        ImmAssociateContextEx(hwnd, NULL, 0);
        xt_ime_enabled = 0;
        // 禁用瞬间可能有进行中的组合:丢弃内联组合串(等价于组合取消,不上屏)
        xt_ime_comp_len = 0;
        xt_ime_comp[0] = 0;
    }
    return XT_FROM_INT(1);
}
#else
uintptr_t XT_IME_Hook(void) { return XT_FROM_INT(0); }
uintptr_t XT_IME_GetComp(void) { return (uintptr_t)xt_string_new(""); }
uintptr_t XT_IME_Enable(uintptr_t on) { (void)on; return XT_FROM_INT(0); }
void XT_SetIMEPos(uintptr_t x, uintptr_t y) { (void)x; (void)y; }
#endif
