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
        ])
        .run(tauri::generate_context!())
        .expect("玄铁铸造厂启动失败");
}
