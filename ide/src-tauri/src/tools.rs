// 工具定位(PATH 扫描,不经 where.exe,避免 GBK 路径乱码)+ 设置持久化
use serde::Serialize;
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

// 读取工具自述版本:`<工具> -h` 首行(如「玄铁 (XuanTie) 编译器驱动 v1.0.0」)
#[tauri::command]
pub async fn tool_version(path: String) -> Result<String, String> {
    let mut cmd = std::process::Command::new(&path);
    cmd.arg("-h");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("运行 {} -h 失败: {}", path, e))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let first = text.lines().next().unwrap_or("").trim().to_string();
    if first.is_empty() {
        Err("无法读取版本信息".into())
    } else {
        Ok(first)
    }
}

// 当前进程是否以管理员权限运行(Windows:TokenElevation;非 Windows 恒 false)
#[tauri::command]
pub async fn is_elevated() -> Result<bool, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
        };
        // windows-sys 0.59:OpenProcessToken 在 Threading 模块
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err("OpenProcessToken 失败".into());
            }
            let mut elev = TOKEN_ELEVATION { TokenIsElevated: 0 };
            let mut ret_len: u32 = 0;
            let ok = GetTokenInformation(
                token,
                TokenElevation,
                &mut elev as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<TOKEN_ELEVATION>() as u32,
                &mut ret_len,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err("GetTokenInformation 失败".into());
            }
            return Ok(elev.TokenIsElevated != 0);
        }
    }
    #[allow(unreachable_code)]
    Ok(false)
}

// 以管理员身份重启:PowerShell Start-Process -Verb RunAs(触发 UAC,由用户确认);
// 授权成功旧实例退出,取消则保留
#[tauri::command]
pub async fn relaunch_as_admin(app: tauri::AppHandle) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| format!("取自身路径失败: {}", e))?;
    let script = format!("Start-Process -FilePath '{}' -Verb RunAs", exe.display());
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let status = cmd
        .status()
        .map_err(|e| format!("启动提权流程失败: {}", e))?;
    if status.success() {
        app.exit(0);
        Ok(())
    } else {
        Err("未获得管理员授权".into())
    }
}

// ============ 铁铺(目录布局与 tiepm/核心.xt 同源,勿单方面改) ============
// 已安装 = %USERPROFILE%\.tiepm\已安装\<包>\tiepm.toml
// 内置库 = tiepm.exe 同级 lib\ 或上一级 lib\(探针 数组\数组.xt),版本取各库 tiepm.toml

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TiepmPkg {
    pub name: String,
    pub version: String,
    pub builtin: bool,
}

// 与 tiepm 取内置库表 同款:首个含 版本=" 的行,取引号内内容
fn parse_toml_version(text: &str) -> Option<String> {
    for line in text.lines() {
        let net: String = line
            .chars()
            .filter(|c| *c != ' ' && *c != '\t' && *c != '\r')
            .collect();
        if let Some(i) = net.find("版本=\"") {
            let rest = &net[i + "版本=\"".len()..];
            if let Some(end) = rest.find('"') {
                return Some(rest[..end].to_string());
            }
        }
    }
    None
}

fn user_tiepm_home() -> Option<std::path::PathBuf> {
    std::env::var("USERPROFILE")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".tiepm"))
}

fn builtin_lib_dir(tiepm_path: &str) -> Option<std::path::PathBuf> {
    let exe = std::path::Path::new(tiepm_path);
    let dir = exe.parent()?;
    let probe = |base: &std::path::Path| base.join("lib").join("数组").join("数组.xt");
    if probe(dir).is_file() {
        return Some(dir.join("lib"));
    }
    let up = dir.join("..").join("lib");
    if probe(&up).is_file() {
        return Some(up);
    }
    None
}

fn read_lib_version(pkg_dir: &std::path::Path) -> String {
    std::fs::read_to_string(pkg_dir.join("tiepm.toml"))
        .ok()
        .and_then(|t| parse_toml_version(&t))
        .unwrap_or_else(|| "?".into())
}

#[tauri::command]
pub async fn tiepm_packages(tiepm_path: String) -> Result<Vec<TiepmPkg>, String> {
    let mut out: Vec<TiepmPkg> = Vec::new();
    if let Some(home) = user_tiepm_home() {
        let inst = home.join("已安装");
        if let Ok(entries) = std::fs::read_dir(&inst) {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().to_string())
                .collect();
            names.sort();
            for name in names {
                let version = read_lib_version(&inst.join(&name));
                out.push(TiepmPkg {
                    name,
                    version,
                    builtin: false,
                });
            }
        }
    }
    if let Some(lib) = builtin_lib_dir(&tiepm_path) {
        let mut names: Vec<String> = std::fs::read_dir(&lib)
            .map_err(|e| format!("读内置库目录失败: {}", e))?
            .filter_map(|e| e.ok())
            .filter(|e| e.path().is_dir())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| lib.join(n).join(format!("{}.xt", n)).is_file())
            .collect();
        names.sort();
        for name in names {
            let version = read_lib_version(&lib.join(&name));
            out.push(TiepmPkg {
                name,
                version,
                builtin: true,
            });
        }
    }
    Ok(out)
}

// 清理铁铺缓存目录(比 tiepm 的 del /q 更彻底:文件与子目录一并清),返回摘要文案
#[tauri::command]
pub async fn tiepm_clean() -> Result<String, String> {
    let home = user_tiepm_home().ok_or("无法获取用户目录(USERPROFILE)")?;
    let cache = home.join("缓存");
    if !cache.exists() {
        return Ok("铁铺缓存目录不存在,无需清理".into());
    }
    let mut removed = 0usize;
    let entries = std::fs::read_dir(&cache).map_err(|e| format!("读缓存目录失败: {}", e))?;
    for e in entries {
        let e = e.map_err(|e| format!("读缓存目录失败: {}", e))?;
        let p = e.path();
        if p.is_file() {
            std::fs::remove_file(&p).map_err(|e| format!("删除失败 {}: {}", p.display(), e))?;
            removed += 1;
        } else if p.is_dir() {
            std::fs::remove_dir_all(&p).map_err(|e| format!("删除失败 {}: {}", p.display(), e))?;
            removed += 1;
        }
    }
    Ok(format!("铁铺缓存已清理(共 {} 项)", removed))
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

// ---- 附件读取(图片/视频上传:读文件 → base64 data URL 供多模态发送) ----

const ATTACH_MAX_BYTES: u64 = 30 * 1024 * 1024;

fn mime_of(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    let ext = lower.rsplit('.').next().unwrap_or("");
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mov" => "video/quicktime",
        "avi" => "video/x-msvideo",
        "mkv" => "video/x-matroska",
        _ => "",
    }
}

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[(n >> 18) as usize & 63] as char);
        out.push(B64_TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64_TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64_TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachData {
    pub mime: String,
    pub data_url: String,
    pub size_bytes: u64,
}

/// 读一个本地媒体文件 → base64 data URL(图片/视频上传用;限 30MB,按扩展名判 mime)。
#[tauri::command]
pub async fn attach_read(path: String) -> Result<AttachData, String> {
    let p = std::path::Path::new(&path);
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mime = mime_of(&name);
    if mime.is_empty() {
        return Err(format!("不支持的文件类型: {}", name));
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件失败 {}: {}", path, e))?;
    if meta.len() > ATTACH_MAX_BYTES {
        return Err(format!(
            "文件过大({:.1}MB,上限 30MB)",
            meta.len() as f64 / 1024.0 / 1024.0
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败 {}: {}", path, e))?;
    let data_url = format!("data:{};base64,{}", mime, base64_encode(&bytes));
    Ok(AttachData {
        mime: mime.to_string(),
        data_url,
        size_bytes: bytes.len() as u64,
    })
}
