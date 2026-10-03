// PTY 终端:portable-pty(Windows ConPTY)
// 会话输出 → 事件 pty-out-{id};进程退出 → pty-exit-{id}
// 运行/铁铺走直连程序(不经 shell),主终端默认 PowerShell。
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};

use tauri::{AppHandle, Emitter, State};

use crate::AppState;

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn MasterPty + Send>,
    pub killer: Box<dyn ChildKiller + Send + Sync>,
}

#[tauri::command]
pub async fn pty_start(
    app: AppHandle,
    state: State<'_, AppState>,
    session: String,
    cwd: String,
    cols: u16,
    rows: u16,
    program: Option<String>,
    args: Option<Vec<String>>,
) -> Result<(), String> {
    {
        let map = state.pty.lock().map_err(|_| "终端状态锁中毒")?;
        if map.contains_key(&session) {
            return Err(format!("终端会话已存在: {}", session));
        }
    }
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("打开 PTY 失败: {}", e))?;

    let mut cmd = match program {
        Some(p) => {
            let mut c = CommandBuilder::new(p);
            if let Some(a) = args {
                for arg in a {
                    c.arg(arg);
                }
            }
            c
        }
        None => {
            let mut c = CommandBuilder::new("powershell.exe");
            c.arg("-NoLogo");
            c
        }
    };
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("PTY 拉起进程失败: {}", e))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY 取写入端失败: {}", e))?;
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY 取读取端失败: {}", e))?;
    let killer = child.clone_killer();

    state.pty.lock().map_err(|_| "终端状态锁中毒")?.insert(
        session.clone(),
        PtySession {
            writer,
            master: pair.master,
            killer,
        },
    );

    // 读线程:ConPTY 输出 → pty-out-{id}
    let app_out = app.clone();
    let sid = session.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]).to_string();
                    if app_out.emit(&format!("pty-out-{}", sid), text).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // 等待线程:退出 → pty-exit-{id},payload 携带退出码(0=成功),前端徽标据此判成败
    let sid2 = session;
    std::thread::spawn(move || {
        let code = match child.wait() {
            Ok(st) => st.exit_code(),
            Err(_) => 1,
        };
        let _ = app.emit(&format!("pty-exit-{}", sid2), code.to_string());
    });

    Ok(())
}

#[tauri::command]
pub async fn pty_write(
    state: State<'_, AppState>,
    session: String,
    data: String,
) -> Result<(), String> {
    let mut map = state.pty.lock().map_err(|_| "终端状态锁中毒")?;
    let s = map
        .get_mut(&session)
        .ok_or_else(|| format!("终端会话不存在: {}", session))?;
    s.writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("终端写入失败: {}", e))?;
    s.writer
        .flush()
        .map_err(|e| format!("终端刷新失败: {}", e))
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    session: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = state.pty.lock().map_err(|_| "终端状态锁中毒")?;
    if let Some(s) = map.get(&session) {
        // 会话刚退出时的 resize 竞态属正常,忽略错误
        let _ = s.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        });
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_kill(state: State<'_, AppState>, session: String) -> Result<(), String> {
    let mut map = state.pty.lock().map_err(|_| "终端状态锁中毒")?;
    if let Some(mut s) = map.remove(&session) {
        let _ = s.killer.kill();
        // master 随结构体丢弃,ConPTY 句柄随之关闭
    }
    Ok(())
}
