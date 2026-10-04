// 玄铁环境自检(preflight):内置探针 → xtc 编译(tie) → 运行 → 解析 [自检] 行。
// 用途:① 结果注入 AI 环境快照,免去 AI 自写冒烟/探针测试反复试探基础环境与语义;
//       ② 任一关键项未通过时给用户黄色警告提示。
// 探针源码随二进制内嵌(preflight_probe.xt),产物落在 app 数据目录 preflight/(每次覆盖)。
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tauri::{Emitter, Manager};
use tokio::io::AsyncBufReadExt;

const PROBE: &str = include_str!("preflight_probe.xt");
/// 校验进度事件名(前端状态栏/控制台监听):stage=阶段、log=子进程输出行、done=结束概要
pub const PROGRESS_EVENT: &str = "preflight-progress";

fn emit_progress(app: &tauri::AppHandle, payload: serde_json::Value) {
    // 与 http.rs emit_chunk 同款约定:发 JSON 字符串而非对象——前端统一 JSON.parse;
    // 发对象的形态会让约定的解析路径抛异常(实测:进度事件全被吞,控制台空白)
    let _ = app.emit(PROGRESS_EVENT, payload.to_string());
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightItem {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightResult {
    /// 编译+运行成功且探针跑到收尾(关键行为全部实测可执行)
    pub ok: bool,
    /// 探针输出的 [自检] 键值对(基础语义实测事实,直接注入 AI 上下文)
    pub items: Vec<PreflightItem>,
    /// 失败诊断(编译/运行输出尾部;ok=true 时为空)
    pub detail: String,
    pub ms: u64,
}

fn preflight_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {}", e))?
        .join("preflight");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建自检目录失败: {}", e))?;
    Ok(dir)
}

/// 无窗执行并把子进程输出逐行 emit 到进度事件(CI 式日志);超时 kill_on_drop。
/// tag 用于前端着色(如 "编译" / "运行")。
async fn run_streaming(
    app: &tauri::AppHandle,
    program: &str,
    args: &[String],
    cwd: &Path,
    timeout_secs: u64,
    tag: &str,
) -> Result<(i32, String, String), String> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        // tokio::process::Command 自带 creation_flags(无需 std CommandExt)
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("启动失败 {}: {}", program, e))?;
    let stdout = child.stdout.take().ok_or("无法捕获输出")?;
    let stderr = child.stderr.take().ok_or("无法捕获错误输出")?;

    let pump = |app: tauri::AppHandle, tag: String, is_err: bool, reader: Box<dyn tokio::io::AsyncRead + Unpin + Send>| async move {
        let mut lines = tokio::io::BufReader::new(reader).lines();
        let mut buf = String::new();
        while let Ok(Some(line)) = lines.next_line().await {
            emit_progress(
                &app,
                serde_json::json!({ "type": "log", "tag": tag, "text": line }),
            );
            if is_err {
                buf.push_str("[stderr] ");
            }
            buf.push_str(&line);
            buf.push('\n');
        }
        buf
    };
    let app_out = app.clone();
    let app_err = app.clone();
    let tag_out = tag.to_string();
    let tag_err = tag.to_string();
    let out_task = tokio::spawn(pump(app_out, tag_out, false, Box::new(stdout)));
    let err_task = tokio::spawn(pump(app_err, tag_err, true, Box::new(stderr)));

    let status = match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), child.wait()).await {
        Ok(Ok(st)) => st,
        Ok(Err(e)) => return Err(format!("执行失败: {}", e)),
        Err(_) => {
            emit_progress(
                app,
                serde_json::json!({ "type": "stage", "text": format!("超过 {} 秒未结束,已强制终止", timeout_secs) }),
            );
            let _ = child.kill().await;
            return Err(format!("超过 {} 秒未结束,已强制终止", timeout_secs));
        }
    };
    let stdout_text = out_task.await.unwrap_or_default();
    let stderr_text = err_task.await.unwrap_or_default();
    Ok((status.code().unwrap_or(-1), stdout_text, stderr_text))
}

fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[tauri::command]
pub async fn preflight_run(app: tauri::AppHandle, xtc: String) -> Result<PreflightResult, String> {
    let t0 = std::time::Instant::now();
    let dir = preflight_dir(&app)?;
    emit_progress(&app, serde_json::json!({ "type": "stage", "text": "准备自检探针…" }));
    std::fs::write(dir.join("preflight.xt"), PROBE).map_err(|e| format!("写自检探针失败: {}", e))?;

    // 编译:xtc tie preflight.xt(首次无 runtime .o 时现场编 C,可达数秒;给足 180s)
    emit_progress(&app, serde_json::json!({ "type": "stage", "text": format!("编译探针({} tie)…", xtc) }));
    let (code, out, err) = run_streaming(&app, &xtc, &["tie".into(), "preflight.xt".into()], &dir, 180, "编译").await?;
    if code != 0 {
        emit_progress(&app, serde_json::json!({ "type": "stage", "text": format!("编译失败(退出码 {})", code) }));
        return Ok(PreflightResult {
            ok: false,
            items: Vec::new(),
            detail: format!("编译失败(退出码 {}):\n{}\n{}", code, tail(&out, 15), tail(&err, 15)),
            ms: t0.elapsed().as_millis() as u64,
        });
    }
    emit_progress(&app, serde_json::json!({ "type": "stage", "text": "编译完成,运行探针…" }));

    // 运行产物
    let exe = dir.join("preflight.exe");
    let (rcode, rout, rerr) = run_streaming(&app, &exe.to_string_lossy(), &[], &dir, 60, "探针").await?;
    let mut items = Vec::new();
    for line in rout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("[自检] ") {
            if let Some((k, v)) = rest.split_once('=') {
                items.push(PreflightItem {
                    key: k.trim().to_string(),
                    value: v.trim().to_string(),
                });
            }
        }
    }
    let finished = items
        .iter()
        .any(|i| i.key == "完成" && i.value == "全部执行完毕");
    let ok = rcode == 0 && finished;
    emit_progress(
        &app,
        serde_json::json!({
            "type": "done",
            "ok": ok,
            "ms": t0.elapsed().as_millis() as u64,
            "text": if ok { "全部通过" } else { "存在未通过项" },
        }),
    );
    Ok(PreflightResult {
        ok,
        detail: if ok {
            String::new()
        } else if rcode != 0 {
            format!("运行失败(退出码 {}):\n{}\n{}", rcode, tail(&rout, 15), tail(&rerr, 15))
        } else {
            "探针输出不完整(未跑到收尾),可能本地工具链异常".to_string()
        },
        items,
        ms: t0.elapsed().as_millis() as u64,
    })
}
