// API 文档书独立窗口:与主窗口分离,使用系统标题栏,可自由拖动/缩放。
// target 深链:method:<方法名> / page:<页面 id>;已存在窗口走 docs-open 事件刷新内容。
use tauri::{AppHandle, Emitter, Manager};

fn pct_encode(s: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        let c = *b;
        if c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.' | b'~') {
            out.push(c as char);
        } else {
            out.push('%');
            out.push(HEX[(c >> 4) as usize] as char);
            out.push(HEX[(c & 0x0F) as usize] as char);
        }
    }
    out
}

/// 打开(或聚焦)API 文档书窗口。async 命令:建窗必须回主线程事件循环,
/// 同步命令在主线程里等待会死锁(同 tiepmwin::open_tiepm_window)。
#[tauri::command]
pub async fn open_docs_window(app: AppHandle, target: Option<String>) -> Result<(), String> {
    let target = target.unwrap_or_default();
    if let Some(win) = app.get_webview_window("docs-window") {
        let _ = win.show();
        win.set_focus().map_err(|e| e.to_string())?;
        if !target.is_empty() {
            app.emit_to("docs-window", "docs-open", target)
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let mut url = "docs.html".to_string();
    if !target.is_empty() {
        url.push_str("?target=");
        url.push_str(&pct_encode(&target));
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "docs-window",
        tauri::WebviewUrl::App(url.into()),
    )
    .title("玄铁 API 文档书")
    // 自绘标题栏:去掉系统标题栏,避免左上角出现两个标题
    .decorations(false)
    .inner_size(1000.0, 720.0)
    .min_inner_size(640.0, 480.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}
