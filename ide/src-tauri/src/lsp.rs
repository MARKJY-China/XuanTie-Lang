// xt_lsp 进程桥:spawn + stdio Content-Length 分帧双向转发
// stdout 帧 → 事件 lsp-msg-{id};stderr 行 → lsp-err-{id};退出 → lsp-exit-{id}
// 分帧与 lsp/xt_lsp.xt 的 读一帧/写帧 对齐:头逐行读到 \r\n\r\n,体按 Content-Length 精确取。
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};

use crate::AppState;

pub struct LspSession {
    pub stdin: ChildStdin,
    pub child: Child,
}

fn read_frame<R: BufRead>(reader: &mut R) -> Option<Vec<u8>> {
    let mut head: Vec<u8> = Vec::new();
    loop {
        let mut line = Vec::new();
        let n = reader.read_until(b'\n', &mut line).ok()?;
        if n == 0 {
            return None; // EOF
        }
        head.extend_from_slice(&line);
        if head.ends_with(b"\r\n\r\n") {
            break;
        }
        if head.len() > 16384 {
            return None; // 头异常膨胀,防跑飞
        }
    }
    let head_str = String::from_utf8_lossy(&head);
    let mut len: Option<usize> = None;
    for line in head_str.lines() {
        let lower = line.to_ascii_lowercase();
        if let Some(v) = lower.strip_prefix("content-length:") {
            len = v.trim().parse::<usize>().ok();
        }
    }
    let len = len?;
    let mut body = vec![0u8; len];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, AppState>,
    server_path: String,
    cwd: String,
    xtc_path: String,
) -> Result<u32, String> {
    let _ = xtc_path; // initialize 的 _xtcPath 由前端组装进请求体;此处仅保持调用签名对称
    let mut cmd = Command::new(&server_path);
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // GUI 进程(无控制台)拉起控制台子系统子进程会弹常驻 CMD 黑窗:CREATE_NO_WINDOW 压掉
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    if !cwd.is_empty() {
        cmd.current_dir(&cwd);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("拉起 xt_lsp 失败({}): {}", server_path, e))?;
    let stdout = child.stdout.take().ok_or("xt_lsp 无 stdout")?;
    let stderr = child.stderr.take().ok_or("xt_lsp 无 stderr")?;
    let stdin = child.stdin.take().ok_or("xt_lsp 无 stdin")?;

    let id = state.next_lsp_id.fetch_add(1, Ordering::SeqCst);

    // stderr 日志线程
    let app_err = app.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if app_err.emit(&format!("lsp-err-{}", id), l).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // stdout 分帧转发线程
    let app_out = app.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_frame(&mut reader) {
                Some(body) => {
                    let text = String::from_utf8_lossy(&body).to_string();
                    if app_out.emit(&format!("lsp-msg-{}", id), text).is_err() {
                        break; // 前端已关,停止转发
                    }
                }
                None => break,
            }
        }
        let _ = app_out.emit(&format!("lsp-exit-{}", id), "");
    });

    state
        .lsp
        .lock()
        .map_err(|_| "LSP 状态锁中毒")?
        .insert(id, LspSession { stdin, child });
    Ok(id)
}

#[tauri::command]
pub async fn lsp_send(state: State<'_, AppState>, id: u32, message: String) -> Result<(), String> {
    let mut sessions = state.lsp.lock().map_err(|_| "LSP 状态锁中毒")?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| format!("LSP 会话不存在: {}", id))?;
    let body = message.into_bytes();
    let mut frame = format!("Content-Length: {}\r\n\r\n", body.len()).into_bytes();
    frame.extend_from_slice(&body);
    session
        .stdin
        .write_all(&frame)
        .map_err(|e| format!("写入 xt_lsp 失败: {}", e))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("刷新 xt_lsp 管道失败: {}", e))
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, AppState>, id: u32) -> Result<(), String> {
    let mut sessions = state.lsp.lock().map_err(|_| "LSP 状态锁中毒")?;
    if let Some(mut session) = sessions.remove(&id) {
        let _ = session.child.kill();
        let _ = session.child.wait();
    }
    Ok(())
}
