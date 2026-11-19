// 铁铺独立窗口:安装/搜索不再占用主窗口的终端会话(pty),
// 安装进程走管道捕获,逐行 emit "tiepm-line",结束时 emit "tiepm-done"。
// 同一时刻只允许一个安装任务(全局 BUSY),取消用 taskkill /T /F 连子进程树一起杀。
use serde::Serialize;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

static BUSY: AtomicBool = AtomicBool::new(false);
static PID: AtomicU32 = AtomicU32::new(0);
/// 正在安装的包名(窗口重开/后开时认领正在跑的安装,继续显示输出)
static CURRENT: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

#[derive(Clone, Serialize)]
struct StartPayload {
    name: String,
}

#[derive(Clone, Serialize)]
struct LinePayload {
    name: String,
    line: String,
    err: bool,
}

#[derive(Clone, Serialize)]
struct DonePayload {
    name: String,
    code: i32,
    ok: bool,
}

/// 打开(或聚焦)铁铺窗口。必须是 async 命令:同步命令在主线程执行,而建窗要等主线程事件循环,
/// 在主线程里等主线程会死锁(同 ailog::open_ai_console 的注释)。
#[tauri::command]
pub async fn open_tiepm_window(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("tiepm-window") {
        let _ = win.show();
        win.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        "tiepm-window",
        tauri::WebviewUrl::App("tiepm.html".into()),
    )
    .title("铁铺 · 安装与搜索")
    .inner_size(780.0, 600.0)
    .min_inner_size(520.0, 380.0)
    .center()
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 安装/升级一个铁器:tiepm az <名> 覆盖安装即升级。
/// 立即返回(进程在后台跑),进度与结果全部走事件,避免长命令卡住窗口。
#[tauri::command]
pub async fn tiepm_install_start(
    app: AppHandle,
    tiepm_path: String,
    name: String,
) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.len() > 128 {
        return Err("包名不能为空且不超过 128 字节".into());
    }
    if name.contains('/') || name.contains('\\') || name.contains("..") || name.contains('\0') {
        return Err("包名含非法字符".into());
    }
    if BUSY.swap(true, Ordering::SeqCst) {
        return Err("已有安装任务在进行,请等它结束或先取消".into());
    }
    let mut cmd = tokio::process::Command::new(&tiepm_path);
    cmd.arg("az")
        .arg(&name)
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Windows:CREATE_NO_WINDOW(0x08000000)——不弹控制台黑窗(tokio Command 自带该扩展方法)
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            BUSY.store(false, Ordering::SeqCst);
            return Err(format!("启动 tiepm 失败: {}", e));
        }
    };
    let pid = child.id().unwrap_or(0);
    PID.store(pid, Ordering::SeqCst);
    if let Ok(mut cur) = CURRENT.lock() {
        *cur = name.clone();
    }
    let _ = app.emit(
        "tiepm-start",
        StartPayload {
            name: name.clone(),
        },
    );
    let out = child.stdout.take();
    let errp = child.stderr.take();
    let app2 = app.clone();
    let name2 = name.clone();
    // 后台任务:两条流并发读,读完再等子进程退出(顺序:先读完输出,避免管道写满)
    tauri::async_runtime::spawn(async move {
        let mut readers = Vec::new();
        if let Some(o) = out {
            readers.push(tauri::async_runtime::spawn(stream_lines(
                o,
                app2.clone(),
                name2.clone(),
                false,
            )));
        }
        if let Some(e) = errp {
            readers.push(tauri::async_runtime::spawn(stream_lines(
                e,
                app2.clone(),
                name2.clone(),
                true,
            )));
        }
        for r in readers {
            let _ = r.await;
        }
        let code = match child.wait().await {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };
        BUSY.store(false, Ordering::SeqCst);
        PID.store(0, Ordering::SeqCst);
        if let Ok(mut cur) = CURRENT.lock() {
            cur.clear();
        }
        let _ = app2.emit(
            "tiepm-done",
            DonePayload {
                name: name2,
                code,
                ok: code == 0,
            },
        );
    });
    Ok(())
}

async fn stream_lines<R>(reader: R, app: AppHandle, name: String, err: bool)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut rd = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match rd.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                let s = String::from_utf8_lossy(&buf);
                let line = s.trim_end_matches(['\r', '\n']).to_string();
                if line.is_empty() {
                    continue;
                }
                let _ = app.emit(
                    "tiepm-line",
                    LinePayload {
                        name: name.clone(),
                        line,
                        err,
                    },
                );
            }
            Err(_) => break,
        }
    }
}

/// 取消正在进行的安装(连同子进程树)。返回是否真的杀到了进程。
#[tauri::command]
pub async fn tiepm_install_cancel() -> Result<bool, String> {
    let pid = PID.load(Ordering::SeqCst);
    if pid == 0 {
        return Ok(false);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]);
        c.creation_flags(0x08000000);
        let ok = c.status().map(|s| s.success()).unwrap_or(false);
        return Ok(ok);
    }
    #[cfg(not(windows))]
    {
        let ok = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        Ok(ok)
    }
}

/// 当前是否有安装任务(窗口重开后恢复按钮态用)
#[tauri::command]
pub fn tiepm_install_busy() -> bool {
    BUSY.load(Ordering::SeqCst)
}

/// 正在安装的包名(没有则空串):后开的铁铺窗口据此认领进度
#[tauri::command]
pub fn tiepm_install_current() -> String {
    CURRENT.lock().map(|s| s.clone()).unwrap_or_default()
}
