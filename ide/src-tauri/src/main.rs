// 玄铁铸造厂 —— Tauri 2 桌面壳入口
// v0.1 作用域:文件树 / Monaco+LSP / 一键运行 / 内嵌终端 / 铁铺 / 新建工程
// 禁区(ide/AGENTS.md):调试器 UI、插件系统、Git 界面、可视化控件设计器
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod fsops;
mod lsp;
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
        .invoke_handler(tauri::generate_handler![
            fsops::fs_read_file,
            fsops::fs_write_file,
            fsops::fs_list_tree,
            fsops::fs_create_file,
            fsops::fs_create_dir,
            fsops::fs_rename,
            fsops::fs_delete,
            fsops::fs_exists,
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
            tools::settings_load,
            tools::settings_save,
            scaffold::scaffold_project,
        ])
        .run(tauri::generate_context!())
        .expect("玄铁铸造厂启动失败");
}
