// 玄铁铸造厂 —— Tauri 2 桌面壳入口
// v0.1 作用域:文件树 / Monaco+LSP / 一键运行 / 内嵌终端 / 铁铺 / 新建工程
// 禁区(ide/AGENTS.md):调试器 UI、插件系统、Git 界面、可视化控件设计器
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ailog;
mod docs;
mod fsops;
mod exec;
mod http;
mod lsp;
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

/// 前端同步未保存文件数(关窗/关机拦截共用)
#[tauri::command]
fn set_unsaved(n: u32) {
    #[cfg(windows)]
    shutdown_guard::set_unsaved(n);
    #[cfg(not(windows))]
    let _ = n;
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            lsp: Mutex::new(HashMap::new()),
            next_lsp_id: AtomicU32::new(1),
            pty: Mutex::new(HashMap::new()),
        })
        // 主窗口关闭时联动关闭控制台窗口(该回调在主线程,直接 close 无死锁)
        .on_window_event(|window, event| {
            if window.label() == "main" {
                use tauri::Manager;
                if matches!(
                    event,
                    tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed
                ) {
                    if let Some(console) = window.app_handle().get_webview_window("ai-console") {
                        let _ = console.close();
                    }
                }
            }
        })
        .setup(|app| {
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
            set_unsaved,
        ])
        .run(tauri::generate_context!())
        .expect("玄铁铸造厂启动失败");
}
