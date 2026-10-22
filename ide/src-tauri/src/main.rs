// 玄铁铸造厂 —— Tauri 2 桌面壳入口
// v0.1 作用域:文件树 / Monaco+LSP / 一键运行 / 内嵌终端 / 铁铺 / 新建工程
// 空指针/禁用项见 ide/AGENTS.md 永久禁令:调试器 UI、插件系统、Git 界面(UI 设计器已解禁)
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ailog;
mod docs;
mod fsops;
mod exec;
mod http;
mod lsp;
mod menubar;
mod preflight;
mod pty;
mod scaffold;
mod tools;

use std::collections::HashMap;
use std::sync::atomic::AtomicU32;
use std::sync::Mutex;

pub struct AppState {
    pub lsp: Mutex<HashMap<u32, lsp::LspSession>>,
    pub next_lsp_id: AtomicU32,
    pub pty: Mutex<HashMap<String, pty::PtySession>>,
    /// macOS 手动最大化:铺满可用工作区前保存的原窗口几何 (x, y, w, h)
    pub mac_prev_geom: Mutex<Option<(i32, i32, u32, u32)>>,
    /// 未保存文件数(前端 set_unsaved 同步;macOS 红点=隐藏时若 >0 留给 JS 询问)
    pub unsaved: AtomicU32,
}

// ---- 关机拦截:未保存文件数 >0 时阻止系统关机(WM_QUERYENDSESSION 返回 FALSE) ----
// 为什么在 Rust 做:系统关机是同步询问窗口过程的,JS 侧来不及应答;未保存数由前端在
// 每次内容变化/保存/开关文件时经 set_unsaved 同步过来,此处置于进程内原子量。
#[cfg(windows)]
mod shutdown_guard {
    use std::sync::atomic::{AtomicIsize, AtomicU32, Ordering};
    use std::sync::OnceLock;
    use tauri::{AppHandle, Emitter, Manager};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        DefWindowProcW, SetWindowLongPtrW, GWLP_WNDPROC, WM_QUERYENDSESSION,
    };

    static UNSAVED: AtomicU32 = AtomicU32::new(0);
    static OLD_PROC: AtomicIsize = AtomicIsize::new(0);
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn set_unsaved(n: u32) {
        UNSAVED.store(n, Ordering::SeqCst);
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: *mut core::ffi::c_void,
        msg: u32,
        wparam: usize,
        lparam: isize,
    ) -> isize {
        if msg == WM_QUERYENDSESSION {
            let n = UNSAVED.load(Ordering::SeqCst);
            if n > 0 {
                if let Some(app) = APP.get() {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("shutdown-blocked", n);
                }
                return 0; // FALSE = 阻止本次关机(系统会给出"此应用阻止关机"的返回入口)
            }
            return 1; // TRUE = 允许关机
        }
        let old = OLD_PROC.load(Ordering::SeqCst);
        if old != 0 {
            let f: unsafe extern "system" fn(*mut core::ffi::c_void, u32, usize, isize) -> isize =
                core::mem::transmute(old);
            return f(hwnd, msg, wparam, lparam);
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    /// 窗口创建后挂接:替换窗口过程并链到原过程(只加一层关机询问,不改既有行为)
    pub fn install(app: AppHandle, window: &tauri::WebviewWindow) {
        let _ = APP.set(app);
        let Ok(hwnd) = window.hwnd() else { return };
        let hwnd = hwnd.0 as *mut core::ffi::c_void; // windows HWND 新类型 → windows-sys 裸指针
        unsafe {
            let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, wnd_proc as *const () as usize as isize);
            OLD_PROC.store(old, Ordering::SeqCst);
        }
    }
}

/// 前端同步未保存文件数(关窗/关机拦截共用;macOS 红点隐藏时判断是否留给 JS 询问)
#[tauri::command]
fn set_unsaved(app: tauri::AppHandle, n: u32) {
    use tauri::Manager;
    app.state::<AppState>()
        .unsaved
        .store(n, std::sync::atomic::Ordering::SeqCst);
    #[cfg(windows)]
    shutdown_guard::set_unsaved(n);
}

// ---- macOS 窗口最大化:铺满可用工作区(自动避开菜单栏与 Dock) / 还原 ----
// 为什么手写:macOS 上 toggleMaximize(系统 zoom)的目标不贴近整屏,与用户习惯不符;
// 故 macOS 上手动铺满 primary_monitor 的 work_area 并记忆原几何,还原时恢复。
// 铺满态用内存标记(mac_prev_geom 是否 Some)判定,不比对像素(系统缩放/对齐会引入像素差)。
// Windows/Linux 维持系统 toggleMaximize 语义(该 command 仅 macOS 生效)。
#[tauri::command]
fn mac_maximize(window: tauri::WebviewWindow, state: tauri::State<AppState>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        let mut guard = state.mac_prev_geom.lock().unwrap();
        if let Some((x, y, w, h)) = guard.take() {
            // 铺满中 → 还原到铺满前几何
            window
                .set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            window
                .set_size(tauri::PhysicalSize::new(w, h))
                .map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            // 未铺满 → 记录当前几何,铺满可用工作区
            let pos = window.outer_position().map_err(|e| e.to_string())?;
            let size = window.outer_size().map_err(|e| e.to_string())?;
            *guard = Some((pos.x, pos.y, size.width, size.height));
            let monitor = window
                .primary_monitor()
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "no primary monitor".to_string())?;
            let wa = monitor.work_area();
            window.set_position(wa.position).map_err(|e| e.to_string())?;
            window.set_size(wa.size).map_err(|e| e.to_string())?;
            Ok(true)
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (window, state);
        Ok(false)
    }
}

/// 查询当前是否处于"铺满可用工作区"状态(供图标/尺寸记忆同步,不切换)
#[tauri::command]
fn mac_maximized(state: tauri::State<AppState>) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        Ok(state.mac_prev_geom.lock().unwrap().is_some())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = state;
        Ok(false)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            lsp: Mutex::new(HashMap::new()),
            next_lsp_id: AtomicU32::new(1),
            pty: Mutex::new(HashMap::new()),
            mac_prev_geom: Mutex::new(None),
            unsaved: AtomicU32::new(0),
        })
        // 主窗口关闭拦截:Rust 同步 prevent(把"是否关闭"的决定权交给前端 handler),
        // 前端决定关闭时显式 destroy(脏文件询问/红点隐藏/放行);Destroyed 联动关闭控制台
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    // macOS:无未保存文件时红点=隐藏(Dock 常驻,保留状态),已隐藏(再次关闭/Dock 右键)=放行销毁;
                    // 有未保存文件则留给前端询问(不在此处理)
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::Manager;
                        let n = window
                            .app_handle()
                            .state::<AppState>()
                            .unsaved
                            .load(std::sync::atomic::Ordering::SeqCst);
                        let dirty = n > 0;
                        eprintln!("[close-req] unsaved={n} dirty={dirty}");
                        if !dirty {
                            if window.is_visible().unwrap_or(true) {
                                let _ = window.hide();
                            } else {
                                let _ = window.destroy();
                            }
                        }
                    }
                }
                use tauri::Manager;
                if matches!(event, tauri::WindowEvent::Destroyed) {
                    eprintln!("[close-req] window DESTROYED");
                    // 窗口销毁:清掉残留 pty(重建窗口后 Rust 侧会话失效,前端会重建;不清理则报"会话已存在")
                    pty::kill_all(&window.app_handle().state::<AppState>());
                    if let Some(console) = window.app_handle().get_webview_window("ai-console") {
                        let _ = console.close();
                    }
                }
            }
        })
        .setup(|app| {
            // macOS:挂系统中文菜单栏(自绘菜单行在前端隐藏;点击经 menu-act 事件回前端)
            #[cfg(target_os = "macos")]
            {
                if let Ok(menu) = menubar::build_menu(app.handle()) {
                    let _ = app.set_menu(menu);
                }
            }
            // 关机拦截:窗口就绪后挂接 WM_QUERYENDSESSION 询问(仅 Windows;见 shutdown_guard)
            #[cfg(windows)]
            {
                use tauri::Manager;
                if let Some(w) = app.get_webview_window("main") {
                    shutdown_guard::install(app.handle().clone(), &w);
                }
            }
            #[cfg(not(windows))]
            let _ = app;
            Ok(())
        })
        .on_menu_event(|app, event| {
            use tauri::Manager;
            // 菜单"退出"(⌘Q):直接销毁主窗口并退出(destroy 不走 closeRequested,不会被 JS 隐藏逻辑拦截)
            if event.id().as_ref() == "quit-app" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.destroy();
                }
                app.exit(0);
                return;
            }
            menubar::dispatch(app, event);
        })
        .invoke_handler(tauri::generate_handler![
            fsops::fs_read_file,
            fsops::fs_read_file_as,
            fsops::fs_write_file,
            fsops::fs_list_tree,
            fsops::fs_create_file,
            fsops::fs_create_dir,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_exists,
            fsops::fs_list_dir,
            fsops::project_instructions,
            docs::docs_dir,
            docs::fetch_docs,
            docs::docs_index,
            docs::docs_search,
            docs::docs_examples,
            docs::primer_read,
            preflight::preflight_run,
            docs::primer_write,
            tools::attach_read,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            pty::pty_start,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            tools::tool_locate,
            tools::tool_pao_support,
            tools::tool_version,
            tools::run_cache_dir,
            tools::is_elevated,
            tools::relaunch_as_admin,
            tools::tiepm_packages,
            tools::tiepm_clean,
            http::http_json,
            http::http_stream,
            http::http_stream_abort,
            tools::settings_load,
            tools::settings_save,
            scaffold::scaffold_project,
            exec::exec_capture,
            exec::kill_all_exec,
            ailog::ai_log_push,
            ailog::ai_log_fetch,
            ailog::ai_log_set_enabled,
            ailog::open_ai_console,
            http::web_fetch,
            http::web_render,
            http::web_search,
            mac_maximize,
            mac_maximized,
            menubar::menu_sync_recent,
            set_unsaved,
        ])
        .build(tauri::generate_context!())
        .expect("玄铁铸造厂启动失败")
        .run(|app: &tauri::AppHandle<tauri::Wry>, event: tauri::RunEvent| {
            match event {
                // macOS 兜底:主窗口仍可见时拒绝退出(红点隐藏走 JS,正常退出先 destroy,到不了这里)
                tauri::RunEvent::ExitRequested { api, .. } => {
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::Manager;
                        let vis = app
                            .get_webview_window("main")
                            .and_then(|w| w.is_visible().ok())
                            .unwrap_or(false);
                        eprintln!("[exit-req] main visible={vis}");
                        if vis {
                            api.prevent_exit();
                        }
                    }
                }
                // macOS:Dock 图标点击 → 窗口在则显示(隐藏保留状态),已销毁则重建
                tauri::RunEvent::Reopen { .. } => {
                    #[cfg(target_os = "macos")]
                    {
                        use tauri::Manager;
                        if app.get_webview_window("main").is_none() {
                            let _ = rebuild_main_window(app);
                        } else if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                }
                _ => {}
            }
        });
}

/// macOS:Dock 点击时主窗口已销毁则按配置文件参数重建(尺寸/红绿灯样式与首启一致)
#[cfg(target_os = "macos")]
fn rebuild_main_window(app: &tauri::AppHandle<tauri::Wry>) -> tauri::Result<()> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("玄铁铸造厂")
        .inner_size(1200.0, 780.0)
        .min_inner_size(960.0, 620.0)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .build()?;
    win.set_focus()?;
    Ok(())
}
