// 新 IDE 窗口:与主窗口同壳,从欢迎页启动(?new=1),不自动恢复主窗口工程与标签。
// 前端每窗口独立运行;主窗口关闭/不关闭由各自 close 流程处理。
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, WebviewUrl, WebviewWindowBuilder};

static NEXT_WINDOW: AtomicU32 = AtomicU32::new(1);

#[tauri::command]
pub async fn open_ide_window(app: AppHandle) -> Result<(), String> {
    let n = NEXT_WINDOW.fetch_add(1, Ordering::SeqCst);
    let label = format!("ide-{n}");
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App("index.html?new=1".into()),
    )
    .title("玄铁铸造厂")
    .inner_size(1200.0, 780.0)
    .min_inner_size(960.0, 620.0);
    // 主窗口在 Windows 上由 setup 关掉系统边框,新窗口同样自绘标题栏
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    builder.build().map(|_| ()).map_err(|e| e.to_string())
}
