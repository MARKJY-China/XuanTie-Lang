// 工具定位(PATH 扫描,不经 where.exe,避免 GBK 路径乱码)+ 设置持久化
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn find_on_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var("PATH").ok()?;
    for dir in path_var.split(';') {
        let dir = dir.trim().trim_matches('"');
        if dir.is_empty() {
            continue;
        }
        for ext in ["", ".exe", ".cmd", ".bat"] {
            let candidate = PathBuf::from(dir).join(format!("{}{}", name, ext));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn tool_locate(name: String) -> Result<String, String> {
    if name.is_empty() || name.contains('\\') || name.contains('/') || name.contains(':') {
        return Err("工具名非法".into());
    }
    match find_on_path(&name) {
        Some(p) => Ok(p.to_string_lossy().to_string()),
        None => Err(format!("PATH 里找不到 {}", name)),
    }
}

// 探测该 xtc 是否支持 pao 子命令(编译+运行一步式)。
// 事实:截至 2026-09-30,所有已构建 xtc(含自举链顶)都不认 pao,它只在未编译的工作区源码里。
#[tauri::command]
pub async fn tool_pao_support(xtc_path: String) -> Result<bool, String> {
    let mut cmd = std::process::Command::new(&xtc_path);
    cmd.arg("-h");
    #[cfg(windows)]
    {
        // 探测不该闪黑窗
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("运行 xtc -h 失败: {}", e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.contains("pao"))
}

// 运行产物缓存目录(<app_cache>/run),旧版 xtc 的 tie+运行 回退产物放这里,不污染工程
#[tauri::command]
pub async fn run_cache_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("取缓存目录失败: {}", e))?
        .join("run");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建运行缓存目录失败: {}", e))?;
    Ok(dir.to_string_lossy().to_string())
}

fn settings_file(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("取配置目录失败: {}", e))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
pub async fn settings_load(app: AppHandle) -> Result<String, String> {
    match std::fs::read_to_string(settings_file(&app)?) {
        Ok(text) => Ok(text),
        // 首启无设置文件:返回空对象(前端回默认值),不算错误
        Err(_) => Ok("{}".into()),
    }
}

#[tauri::command]
pub async fn settings_save(app: AppHandle, content: String) -> Result<(), String> {
    // 拒绝写入非 JSON:设置文件损坏宁可报错
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("设置内容不是合法 JSON: {}", e))?;
    let file = settings_file(&app)?;
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建配置目录失败: {}", e))?;
    }
    std::fs::write(&file, content).map_err(|e| format!("写设置失败: {}", e))
}
