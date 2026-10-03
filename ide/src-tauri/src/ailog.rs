// AI 链路日志中枢(开发者模式):环形缓冲(5000)+ 控制台窗口。
// TS 侧上报(ai_log_push,entry 为 JSON 字符串,格式由 src/ai/log-bus.ts 定义),
// 控制台窗口拉历史(ai_log_fetch)+ 订阅广播事件 "ai-log"。
// ai_log_set_enabled(false) 时 push 直接丢弃(省开销),历史保留可读。
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::Manager;

const CAP: usize = 5000;

static ENABLED: AtomicBool = AtomicBool::new(false);

fn store() -> &'static Mutex<VecDeque<String>> {
    static STORE: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();
    STORE.get_or_init(|| Mutex::new(VecDeque::with_capacity(CAP)))
}

#[tauri::command]
pub fn ai_log_set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::SeqCst);
}

#[tauri::command]
pub fn ai_log_push(app: tauri::AppHandle, entry: String) -> Result<(), String> {
    if !ENABLED.load(Ordering::SeqCst) {
        return Ok(());
    }
    {
        let mut q = store().lock().map_err(|e| e.to_string())?;
        if q.len() >= CAP {
            q.pop_front();
        }
        q.push_back(entry.clone());
    }
    use tauri::Emitter;
    let _ = app.emit("ai-log", entry);
    Ok(())
}

#[tauri::command]
pub fn ai_log_fetch() -> Result<Vec<String>, String> {
    let q = store().lock().map_err(|e| e.to_string())?;
    Ok(q.iter().cloned().collect())
}

/// 打开(或聚焦)智器对话控制台窗口;WebviewUrl::App 在 dev 走 devUrl、prod 走内嵌资源,同一代码路径。
/// 必须是 async 命令:同步命令在主线程执行,而建窗要等主线程事件循环——在主线程里等主线程
/// 会死锁(wry: "must be called from a separate thread, otherwise the channel will introduce a deadlock")。
/// 死锁表现:控制台窗口白屏+关不掉、主窗口全部协议资源请求挂起、整个应用无法关闭。
#[tauri::command]
pub async fn open_ai_console(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("ai-console") {
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "ai-console",
        tauri::WebviewUrl::App("console.html".into()),
    )
    .title("智器对话 控制台")
    .inner_size(900.0, 600.0)
    .min_inner_size(560.0, 360.0)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
