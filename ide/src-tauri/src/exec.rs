// exec_capture:DSH run_command 工具的执行后端。
// std/tokio process 捕获 stdout/stderr/exit code,超时 kill。
// 刻意不用 PTY(pty.rs 是交互终端用的,捕获场景 PTY 会混入控制序列)。
use serde::Serialize;
use std::collections::HashSet;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// 正在执行的 run_command 进程 pid 登记表(用户点终止按钮时强杀;含子进程树)
fn running_exec() -> &'static Mutex<HashSet<u32>> {
    static M: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 强杀所有正在执行的命令进程(连同子进程树);
/// Windows 用 taskkill /T /F,非 Windows 用 kill -9(pgid 尽力)。
#[tauri::command]
pub async fn kill_all_exec() -> Result<usize, String> {
    let pids: Vec<u32> = running_exec()
        .lock()
        .map_err(|_| "进程登记表锁中毒")?
        .drain()
        .collect();
    let mut killed = 0usize;
    for pid in pids {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let mut c = std::process::Command::new("taskkill");
            c.args(["/PID", &pid.to_string(), "/T", "/F"]);
            c.creation_flags(0x08000000);
            if c.status().map(|s| s.success()).unwrap_or(false) {
                killed += 1;
            }
        }
        #[cfg(not(windows))]
        {
            let mut c = std::process::Command::new("kill");
            c.args(["-9", &pid.to_string()]);
            if c.status().map(|s| s.success()).unwrap_or(false) {
                killed += 1;
            }
        }
    }
    Ok(killed)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecResult {
    pub status: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

// Windows cmd 默认输出 GBK;先按 UTF-8 试,失败回退 GBK(chcp 65001 环境两种都能对上)
fn decode_out(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GBK.decode(bytes).0.into_owned(),
    }
}

#[tauri::command]
pub async fn exec_capture(
    program: String,
    args: Vec<String>,
    cwd: String,
    timeout_secs: Option<u64>,
) -> Result<ExecResult, String> {
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(120).clamp(1, 600));
    let mut cmd = tokio::process::Command::new(&program);
    cmd.args(&args)
        .current_dir(&cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Windows:CREATE_NO_WINDOW(0x08000000)——cmd /c 默认会创建控制台黑窗,捕获场景必须压掉
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("启动失败 {}: {}", program, e))?;
    // 登记 pid:供 kill_all_exec(用户点对话框终止按钮)强杀
    let pid = child.id();
    if let Some(p) = pid {
        if let Ok(mut set) = running_exec().lock() {
            set.insert(p);
        }
    }
    let result = tokio::time::timeout(timeout, child.wait_with_output()).await;
    if let Some(p) = pid {
        if let Ok(mut set) = running_exec().lock() {
            set.remove(&p);
        }
    }
    match result {
        Ok(Ok(out)) => Ok(ExecResult {
            status: out.status.code().unwrap_or(-1),
            stdout: decode_out(&out.stdout),
            stderr: decode_out(&out.stderr),
            timed_out: false,
        }),
        Ok(Err(e)) => Err(format!("执行失败 {}: {}", program, e)),
        // 超时:wait_with_output 的 Future 被 drop → kill_on_drop 杀进程
        Err(_) => Ok(ExecResult {
            status: -1,
            stdout: String::new(),
            stderr: format!("超过 {} 秒未结束,已强制终止", timeout.as_secs()),
            timed_out: true,
        }),
    }
}
