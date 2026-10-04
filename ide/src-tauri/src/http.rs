// HTTP 命令:账号系统(社区论坛)专用通道。走 Rust 侧而非 WebView fetch,
// 一并绕开跨域限制与 httpOnly Cookie 不可读问题(Set-Cookie 在此捕获)。
// 安全护栏:仅放行 https 与本机地址。
// 流式命令 http_stream:SSE 逐块解析为统一事件(ai-stream-{id}),支持中止。
use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResult {
    pub status: u16,
    pub body: String,
    pub session_cookie: String,
}

// 流式中止表:streamId → 取消标志
fn cancel_slot(id: &str, insert: Option<Arc<AtomicBool>>) -> Option<Arc<AtomicBool>> {
    static MAP: Mutex<Option<HashMap<String, Arc<AtomicBool>>>> = Mutex::new(None);
    let mut guard = MAP.lock().ok()?;
    let map = guard.get_or_insert_with(HashMap::new);
    match insert {
        Some(f) => {
            map.insert(id.to_string(), f.clone());
            None
        }
        None => map.remove(id),
    }
}

async fn emit_chunk(app: &tauri::AppHandle, id: &str, payload: serde_json::Value) -> bool {
    use tauri::Emitter;
    let s = payload.to_string();
    app.emit(&format!("ai-stream-{}", id), s).is_ok()
}

#[tauri::command]
pub async fn http_stream(
    app: tauri::AppHandle,
    id: String,
    method: String,
    url: String,
    body: Option<serde_json::Value>,
    cookie: Option<String>,
    auth: Option<String>,
    format: String,
) -> Result<(), String> {
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("仅允许 https 或本机地址".into());
    }
    let flag = Arc::new(AtomicBool::new(false));
    cancel_slot(&id, Some(flag.clone()));
    let cleanup = |id: &str| {
        cancel_slot(id, None);
    };

    // 流式通道不设总超时:原 300s 总超时会拦腰切断长思考/大输出的正常长流——实测
    // "IDE 放后台跑长任务时流中断高发"(长任务总耗时必然撞线)。改为只约束连接与读空闲:
    // 180s 无任何数据才算真死,正常 SSE 长流不受总时长限制。
    let client = reqwest::Client::builder()
        .user_agent("xuantie-foundry/0.2")
        .connect_timeout(std::time::Duration::from_secs(15))
        .read_timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("不支持的 HTTP 方法: {}", other)),
    };
    if let Some(c) = cookie {
        if !c.is_empty() {
            req = req.header("Cookie", c);
        }
    }
    if let Some(a) = auth {
        if !a.is_empty() {
            req = req.header("Authorization", a);
        }
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            let _ = emit_chunk(&app, &id, serde_json::json!({"type":"error","message":format!("请求失败: {}", e)}));
            let _ = emit_chunk(&app, &id, serde_json::json!({"type":"done"}));
            cleanup(&id);
            return Ok(());
        }
    };
    let status = resp.status().as_u16();
    let _ = emit_chunk(&app, &id, serde_json::json!({"type":"status","status":status}));
    if status != 200 {
        let text = resp.text().await.unwrap_or_default();
        // 提取上游 error.message(两类模板都兼容),失败给原文片段
        let mut msg = format!("HTTP {}", status);
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(em) = v.get("error").and_then(|e| e.get("message")).and_then(|m| m.as_str()) {
                msg = em.to_string();
            } else if let Some(er) = v.get("error").and_then(|e| e.as_str()) {
                msg = er.to_string();
            }
        }
        let _ = emit_chunk(&app, &id, serde_json::json!({"type":"error","message":msg}));
        let _ = emit_chunk(&app, &id, serde_json::json!({"type":"done"}));
        cleanup(&id);
        return Ok(());
    }

    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    let community = format == "community";
    let sse_raw = format == "sse-raw";
    // 流诊断统计:块数/字节/总时长/末次数据时间/是否见到 [DONE]。
    // 结束路径必须能回答"流为什么结束"——上游 EOF 断连与正常 [DONE] 此前无法区分,
    // 导致 IDE 侧只报"未收到 finish_reason"而无任何线索(实测反馈:控制台看不到根因)。
    let t0 = std::time::Instant::now();
    let mut n_chunks: u64 = 0;
    let mut n_bytes: u64 = 0;
    let mut last_data = std::time::Instant::now();
    let mut saw_done = false;
    let mut aborted = false;
    'outer: while let Some(chunk) = stream.next().await {
        if flag.load(Ordering::Relaxed) {
            aborted = true;
            let _ = emit_chunk(&app, &id, serde_json::json!({"type":"aborted"}));
            break;
        }
        let bytes = match chunk {
            Ok(b) => b,
            Err(e) => {
                let _ = emit_chunk(&app, &id, serde_json::json!({"type":"error","message":format!("读取流失败: {} (已收 {} 块/{} 字节/{} ms)", e, n_chunks, n_bytes, t0.elapsed().as_millis())}));
                break;
            }
        };
        n_chunks += 1;
        n_bytes += bytes.len() as u64;
        last_data = std::time::Instant::now();
        buf.extend_from_slice(&bytes);
        // 按空行切分 SSE 事件
        while let Some(pos) = find_event_end(&buf) {
            let event: Vec<u8> = buf.drain(..pos).collect();
            let text = String::from_utf8_lossy(&event);
            for line in text.lines() {
                if let Some(payload) = line.strip_prefix("data: ") {
                    let payload = payload.trim();
                    if payload == "[DONE]" {
                        // [DONE] 不转发,统一转成末尾的 {type:"done"}(sse-raw 同此约定)
                        saw_done = true;
                        break 'outer;
                    }
                    if sse_raw {
                        // 原样透传:不做任何协议解析,每个 SSE data 载荷包成
                        // {"type":"sse","data":"<payload>"} 事件,协议翻译在 WebView TS 层
                        // (DSH OpenAI 兼容适配器)完成。status/error/aborted/done 逻辑不变。
                        if !emit_chunk(&app, &id, serde_json::json!({"type":"sse","data":payload})).await {
                            break 'outer;
                        }
                        continue;
                    }
                    if community {
                        // 社区代理已归一化,原样转发
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) {
                            if !emit_chunk(&app, &id, v).await {
                                break 'outer;
                            }
                        }
                        continue;
                    }
                    // OpenAI 兼容流:解析 delta / usage
                    let v: serde_json::Value = match serde_json::from_str(payload) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if let Some(us) = v.get("usage").and_then(|u| u.get("total_tokens")).and_then(|n| n.as_i64()) {
                        let _ = emit_chunk(&app, &id, serde_json::json!({"type":"usage","tokens":us}));
                    }
                    if let Some(delta) = v
                        .get("choices")
                        .and_then(|c| c.get(0))
                        .and_then(|c| c.get("delta"))
                    {
                        for key in ["reasoning_content", "reasoning"] {
                            if let Some(s) = delta.get(key).and_then(|x| x.as_str()) {
                                if !s.is_empty() {
                                    let _ = emit_chunk(&app, &id, serde_json::json!({"type":"thinking","text":s}));
                                }
                            }
                        }
                        if let Some(s) = delta.get("content").and_then(|x| x.as_str()) {
                            if !s.is_empty() {
                                let _ = emit_chunk(&app, &id, serde_json::json!({"type":"text","text":s}));
                            }
                        }
                    }
                }
            }
        }
    }
    // 结束原因诊断:EOF 且未见 [DONE] = 上游/网关在流中途切断了连接(IDE 侧将表现为截断)
    if !aborted && !saw_done {
        let _ = emit_chunk(
            &app,
            &id,
            serde_json::json!({
                "type": "warn",
                "message": format!(
                    "上游连接在流中途结束(EOF,未收到 [DONE]):已收 {} 块/{} 字节/总 {} ms,末次数据距今 {} ms——多为网关/服务端空闲或总时长切断",
                    n_chunks, n_bytes, t0.elapsed().as_millis(), last_data.elapsed().as_millis()
                )
            }),
        );
    }
    let _ = emit_chunk(
        &app,
        &id,
        serde_json::json!({
            "type": "stat",
            "data": {
                "chunks": n_chunks,
                "bytes": n_bytes,
                "ms": t0.elapsed().as_millis(),
                "end": if aborted { "aborted" } else if saw_done { "done" } else { "eof" },
                "silentMs": last_data.elapsed().as_millis(),
            }
        }),
    );
    let _ = emit_chunk(&app, &id, serde_json::json!({"type":"done"}));
    cleanup(&id);
    Ok(())
}

// 找 buf 中首个 SSE 事件边界(空行)的结束位置;无则 None
fn find_event_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n").map(|p| p + 4).or_else(|| {
        buf.windows(2).position(|w| w == b"\n\n").map(|p| p + 2)
    })
}

#[tauri::command]
pub async fn http_stream_abort(id: String) -> Result<(), String> {
    if let Some(flag) = cancel_slot(&id, None) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

// ---- web_fetch(三层联网栈入口):静态抓取 → 不足时自动升级无头渲染 ----
// 第一层搜索 = web_search(必应直连);第二层 = fetch_static(HTTP + HTML 提取);
// 第三层 = web_render(隐藏 WebView2 窗口渲染 JS/SPA 后取 DOM)。

const WEB_FETCH_MAX_BYTES: usize = 2 * 1024 * 1024;
const WEB_FETCH_MAX_CHARS: usize = 12000;
// 静态抓取正文低于此字符数视为"JS 渲染型页面",自动升级到隐藏浏览器渲染
const RENDER_UPGRADE_THRESHOLD: usize = 400;

// 静态抓取(原 web_fetch 逻辑抽出,供三层升级复用)
async fn fetch_static(url: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
    let resp = client.get(url).send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err(format!("HTTP {}", status));
    }
    // 限 2MB:流式读满即停
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let b = chunk.map_err(|e| format!("读取响应失败: {}", e))?;
        buf.extend_from_slice(&b);
        if buf.len() >= WEB_FETCH_MAX_BYTES {
            buf.truncate(WEB_FETCH_MAX_BYTES);
            break;
        }
    }
    let html = String::from_utf8_lossy(&buf).into_owned();
    Ok(html_to_text(&html))
}

fn truncate_text(text: String) -> String {
    if text.chars().count() > WEB_FETCH_MAX_CHARS {
        let truncated: String = text.chars().take(WEB_FETCH_MAX_CHARS).collect();
        format!("{}\n…[正文过长已截断到 {} 字符]", truncated, WEB_FETCH_MAX_CHARS)
    } else {
        text
    }
}

// ============ 第三层:无头浏览器(隐藏 WebView2 窗口渲染) ============
// 用 Tauri 自带的 WebView2 加载目标 URL(visible(false)),等 load 完成后注入脚本取
// document.documentElement.outerHTML;eval_with_callback 直接回调返回,无需任何 IPC 权限。
// 外部浏览器(Chrome/Edge --headless)方案已实测否决:部分环境被安全软件静默拦截(连
// Chrome 自己的 --log-file 都不写),且不能保证用户机器装有 Chrome;WebView2 是 Tauri
// 应用硬依赖,必然存在,是唯一可靠通道。

use std::sync::OnceLock;
use tauri::webview::{PageLoadEvent, WebviewWindowBuilder};
use tauri::WebviewUrl;
use tokio::sync::oneshot;

// 渲染结果回传通道:render window label → oneshot sender
fn render_senders() -> &'static Mutex<HashMap<String, oneshot::Sender<String>>> {
    static M: OnceLock<Mutex<HashMap<String, oneshot::Sender<String>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 渲染完成后等待 JS 补渲染的静默期(SPA 常见 setTimeout/fetch 补内容)
const RENDER_SETTLE_MS: u64 = 1500;
/// eval 取 DOM 的自身超时(脚本执行 + 大 DOM 序列化)
const RENDER_EVAL_TIMEOUT_SECS: u64 = 10;

#[tauri::command]
pub async fn web_render(
    app: tauri::AppHandle,
    url: String,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("仅允许 https 或本机地址(http:// 的外网地址被拒绝)".into());
    }
    let parsed: tauri::Url = url.parse().map_err(|e| format!("URL 解析失败: {}", e))?;
    let total_timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(30).clamp(5, 120));

    let label = format!(
        "wr-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let (tx, rx) = oneshot::channel::<String>();
    render_senders().lock().map_err(|_| "渲染通道锁中毒")?.insert(label.clone(), tx);

    let fired = Arc::new(AtomicBool::new(false));
    let label_for_cb = label.clone();
    let fired_cb = fired.clone();
    let win = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(parsed))
        .visible(false)
        .inner_size(1024.0, 768.0)
        .title("render")
        .on_page_load(move |window, payload| {
            // 只处理主文档 Finished;iframe 的 load 也走这里,用 once 标志防重复
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if fired_cb.swap(true, Ordering::SeqCst) {
                return;
            }
            let l = label_for_cb.clone();
            tauri::async_runtime::spawn(async move {
                // 静默期:等 SPA 的异步补渲染
                tokio::time::sleep(std::time::Duration::from_millis(RENDER_SETTLE_MS)).await;
                let (etx, erx) = oneshot::channel::<String>();
                // 回调签名是 Fn(可能被多次调用),oneshot send 消费所有权 → 用 Mutex<Option> 一次性取走
                let cell = Arc::new(Mutex::new(Some(etx)));
                let cell_cb = cell.clone();
                let ok = window
                    .eval_with_callback(
                        "document.documentElement.outerHTML",
                        move |v| {
                            if let Ok(mut g) = cell_cb.lock() {
                                if let Some(tx) = g.take() {
                                    let _ = tx.send(v);
                                }
                            }
                        },
                    )
                    .is_ok();
                let html = if ok {
                    match tokio::time::timeout(
                        std::time::Duration::from_secs(RENDER_EVAL_TIMEOUT_SECS),
                        erx,
                    )
                    .await
                    {
                        Ok(Ok(raw)) => {
                            // eval_with_callback 回传的是 JSON 序列化字符串(带引号转义)
                            serde_json::from_str::<String>(&raw).unwrap_or(raw)
                        }
                        _ => String::new(),
                    }
                } else {
                    String::new()
                };
                if let Some(tx) = render_senders().lock().ok().and_then(|mut m| m.remove(&l)) {
                    let _ = tx.send(html);
                }
            });
        })
        .build()
        .map_err(|e| format!("创建渲染窗口失败: {}", e))?;

    let result = tokio::time::timeout(total_timeout, rx).await;
    let _ = win.close();
    match result {
        Ok(Ok(html)) => {
            if html.trim().is_empty() {
                return Err("渲染完成但页面为空(可能加载失败或页面无内容)".into());
            }
            Ok(truncate_text(html_to_text(&html)))
        }
        Ok(Err(_)) => Err("渲染窗口在完成前被关闭".into()),
        Err(_) => {
            if let Ok(mut m) = render_senders().lock() {
                m.remove(&label);
            }
            Err(format!("渲染超时({} 秒)", total_timeout.as_secs()))
        }
    }
}

// ---- web_fetch:三层自动升级(静态优先,不足时无头渲染) ----
// render 参数:"auto"(默认)/"always"(强制渲染)/"never"(仅静态)。
#[tauri::command]
pub async fn web_fetch(
    app: tauri::AppHandle,
    url: String,
    render: Option<String>,
) -> Result<String, String> {
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("仅允许 https 或本机地址(http:// 的外网地址被拒绝)".into());
    }
    let mode = render.as_deref().unwrap_or("auto");
    match mode {
        "never" => {
            let text = fetch_static(&url).await?;
            Ok(format!("[静态抓取]\n{}", truncate_text(text)))
        }
        "always" => {
            let text = web_render(app.clone(), url, None).await?;
            Ok(format!("[浏览器渲染]\n{}", text))
        }
        _ => {
            // auto:静态抓取;正文过短(疑似 JS 渲染型)或抓取失败 → 升级渲染
            let static_result = fetch_static(&url).await;
            let need_render = match &static_result {
                Ok(t) => t.chars().count() < RENDER_UPGRADE_THRESHOLD,
                Err(_) => true,
            };
            if !need_render {
                let text = static_result.unwrap_or_default();
                return Ok(format!("[静态抓取]\n{}", truncate_text(text)));
            }
            match web_render(app, url, None).await {
                Ok(rendered) => {
                    // 渲染结果 vs 静态结果取更长的(渲染偶发失败时保住静态内容)
                    let rendered = truncate_text(rendered);
                    let rendered_len = rendered.chars().count();
                    if let Ok(static_text) = static_result {
                        let static_trunc = truncate_text(static_text);
                        if static_trunc.chars().count() > rendered_len {
                            return Ok(format!(
                                "[静态抓取(浏览器渲染内容更少,取静态版本)]\n{}",
                                static_trunc
                            ));
                        }
                    }
                    Ok(format!("[浏览器渲染]\n{}", rendered))
                }
                Err(e) => match static_result {
                    Ok(text) if !text.trim().is_empty() => Ok(format!(
                        "[静态抓取(浏览器渲染失败: {}; 页面可能是需要 JS 渲染的 SPA)]\n{}",
                        e,
                        truncate_text(text)
                    )),
                    _ => Err(format!("抓取失败: {}", e)),
                },
            }
        }
    }
}

// ---- web_search(第一层:必应国内版直连,零 Key) ----
// 结果条结构(2026-10 实测): <h2 ...><a ... href="直链URL" ...>标题</a>...</h2> 与
// <p ...>摘要</p>;href 为直链,无需解码重定向包装。

fn strip_fragment(html: &str) -> String {
    // 复用完整提取器(剥标签/反转义/压缩空白)再修剪首尾空白
    html_to_text(html).trim().to_string()
}

/// 找下一个 <p 标签(兼容 <p> 无属性与 <p class=...>;排除 <pre/<param 等前缀)
fn find_p_tag(hay: &str) -> Option<usize> {
    let mut cursor = 0usize;
    while let Some(rel) = find_ascii_ci(&hay[cursor..], "<p") {
        let pos = cursor + rel;
        match hay[pos + 2..].chars().next() {
            Some(c) if matches!(c, ' ' | '>' | '\t' | '\n' | '\r') => return Some(pos),
            Some(_) => cursor = pos + 2,
            None => return None,
        }
    }
    None
}

fn parse_bing_results(html: &str) -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    let mut cursor = 0usize;
    while out.len() < 5 {
        let Some(h2_rel) = find_ascii_ci(&html[cursor..], "<h2") else {
            break;
        };
        let h2 = cursor + h2_rel;
        let Some(a_rel) = find_ascii_ci(&html[h2..], "<a ") else {
            break;
        };
        let a = h2 + a_rel;
        // href="..."
        let Some(href_rel) = find_ascii_ci(&html[a..], "href=\"") else {
            cursor = a + 2;
            continue;
        };
        let href_start = a + href_rel + 6;
        let Some(href_end_rel) = html[href_start..].find('"') else {
            break;
        };
        let href = &html[href_start..href_start + href_end_rel];
        // 标题:<a ...> 到 </a>
        let Some(gt_rel) = html[a..].find('>') else {
            break;
        };
        let title_start = a + gt_rel + 1;
        let Some(title_end_rel) = find_ascii_ci(&html[title_start..], "</a>") else {
            break;
        };
        let title = strip_fragment(&html[title_start..title_start + title_end_rel]);
        // 摘要:标题之后,窗口内第一个 <p ...> 至 </p>
        let after_h2 = title_start + title_end_rel;
        let search_window_end = (after_h2 + 6000).min(html.len());
        let window = &html[after_h2..search_window_end];
        let snippet = if let Some(p_rel) = find_p_tag(window) {
            let p = after_h2 + p_rel;
            if let Some(gt) = html[p..].find('>') {
                let s_start = p + gt + 1;
                if let Some(s_end_rel) = find_ascii_ci(&html[s_start..], "</p>") {
                    strip_fragment(&html[s_start..s_start + s_end_rel])
                } else {
                    String::new()
                }
            } else {
                String::new()
            }
        } else {
            String::new()
        };
        if !href.starts_with("http") {
            cursor = after_h2;
            continue;
        }
        out.push((title, href.to_string(), snippet));
        cursor = after_h2;
    }
    out
}

#[tauri::command]
pub async fn web_search(query: String) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("查询内容不能为空".into());
    }
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
    let url = format!("https://cn.bing.com/search?q={}&count=5", urlencoding(q));
    let resp = client
        .get(&url)
        .header("Accept-Language", "zh-CN,zh;q=0.9")
        .send()
        .await
        .map_err(|e| format!("搜索请求失败: {}", e))?;
    if resp.status().as_u16() != 200 {
        return Err(format!("搜索服务返回 HTTP {}", resp.status().as_u16()));
    }
    let body = resp.text().await.map_err(|e| format!("读取搜索响应失败: {}", e))?;
    let results = parse_bing_results(&body);
    if results.is_empty() {
        return Ok(format!("未找到「{}」的搜索结果(可能被反爬拦截,或关键词无结果)", q));
    }
    let mut out = String::new();
    for (i, (title, url, snippet)) in results.iter().enumerate() {
        out.push_str(&format!(
            "{}. {}\n   {}\n   {}\n",
            i + 1,
            if title.is_empty() { "(无标题)" } else { title },
            url,
            if snippet.is_empty() { "(无摘要)" } else { snippet }
        ));
    }
    out.push_str("(可对其中任意链接调用 web_fetch 打开全文阅读)");
    Ok(out)
}

// 最小 URL 编码(查询参数用):保留 unreserved,其余百分号编码
fn urlencoding(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

// HTML → 纯文本:删 script/style/noscript 整块 → 删全部标签 → 基础实体反转义 → 压缩空白。
// 全程按 char 边界切片(不允许出现字节级切割,多字节字符安全);
// ASCII 模式(标签/闭合标记)用大小写不敏感的字节窗口匹配。
fn find_ascii_ci(hay: &str, needle: &str) -> Option<usize> {
    let hb = hay.as_bytes();
    let nb = needle.as_bytes();
    hb.windows(nb.len()).position(|w| w.eq_ignore_ascii_case(nb))
}

fn append_unescaped(out: &mut String, s: &str) {
    let mut rest = s;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp..];
        // 数字实体(&#123; / &#x1F600;):先试解码,失败按字面 & 处理
        if tail.starts_with("&#") {
            let (radix, skip) = if tail.starts_with("&#x") || tail.starts_with("&#X") {
                (16u32, 3usize)
            } else {
                (10u32, 2usize)
            };
            if let Some(semi) = tail[skip..].find(';').map(|p| p + skip) {
                let digits = &tail[skip..semi];
                if !digits.is_empty() && digits.len() <= 8 {
                    if let Ok(code) = u32::from_str_radix(digits, radix) {
                        if let Some(c) = char::from_u32(code) {
                            out.push(c);
                            rest = &tail[semi + 1..];
                            continue;
                        }
                    }
                }
            }
        }
        let (rep, len): (&str, usize) = if tail.starts_with("&amp;") {
            ("&", 5)
        } else if tail.starts_with("&lt;") {
            ("<", 4)
        } else if tail.starts_with("&gt;") {
            (">", 4)
        } else if tail.starts_with("&quot;") {
            ("\"", 6)
        } else if tail.starts_with("&#39;") {
            ("'", 5)
        } else if tail.starts_with("&nbsp;") {
            (" ", 6)
        } else {
            ("&", 1)
        };
        out.push_str(rep);
        rest = &tail[len..];
    }
    out.push_str(rest);
}

fn html_to_text(html: &str) -> String {
    const SKIP_TAGS: [&str; 3] = ["script", "style", "noscript"];
    const BREAK_TAGS: [&str; 16] = [
        "p", "div", "br", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article",
        "header", "footer", "pre",
    ];
    let mut out = String::with_capacity(html.len() / 2);
    let mut rest = html;
    while let Some(lt) = rest.find('<') {
        append_unescaped(&mut out, &rest[..lt]);
        let after_lt = &rest[lt..];
        if after_lt.starts_with("<!--") {
            match after_lt.find("-->") {
                Some(end) => {
                    rest = &after_lt[end + 3..];
                    continue;
                }
                None => break,
            }
        }
        let gt = match after_lt.find('>') {
            Some(p) => p,
            None => break,
        };
        let inner = &after_lt[1..gt];
        let name_end = inner
            .find(|c: char| !c.is_ascii_alphanumeric())
            .unwrap_or(inner.len());
        let (closing, name_part) = if let Some(stripped) = inner.strip_prefix('/') {
            let end = stripped
                .find(|c: char| !c.is_ascii_alphanumeric())
                .unwrap_or(stripped.len());
            (true, &stripped[..end])
        } else {
            (false, &inner[..name_end])
        };
        let name = name_part.to_ascii_lowercase();
        if !closing && SKIP_TAGS.contains(&name.as_str()) {
            let close_pat = format!("</{}>", name);
            let after_gt = &after_lt[gt + 1..];
            if let Some(end) = find_ascii_ci(after_gt, &close_pat) {
                rest = &after_gt[end + close_pat.len()..];
                continue;
            }
            // 无闭合(残缺/自闭合):只跳过标签本身
        }
        if BREAK_TAGS.contains(&name.as_str()) {
            out.push('\n');
        }
        rest = &after_lt[gt + 1..];
    }
    append_unescaped(&mut out, rest);
    // 压缩空白:行内连续空白→单空格,连续空行→单空行
    let mut result = String::with_capacity(out.len());
    let mut blank_run = 0;
    for line in out.lines() {
        let squashed: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
        if squashed.is_empty() {
            blank_run += 1;
            if blank_run <= 1 {
                result.push('\n');
            }
        } else {
            blank_run = 0;
            result.push_str(&squashed);
            result.push('\n');
        }
    }
    result.trim().to_string()
}

#[tauri::command]
pub async fn http_json(
    method: String,
    url: String,
    body: Option<serde_json::Value>,
    cookie: Option<String>,
    auth: Option<String>,
    timeout_secs: Option<u64>,
) -> Result<HttpResult, String> {
    if !(url.starts_with("https://")
        || url.starts_with("http://localhost")
        || url.starts_with("http://127.0.0.1"))
    {
        return Err("仅允许 https 或本机地址".into());
    }
    let timeout = std::time::Duration::from_secs(timeout_secs.unwrap_or(180));
    let client = reqwest::Client::builder()
        .user_agent("xuantie-foundry/0.2")
        .timeout(timeout)
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
    let mut req = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        other => return Err(format!("不支持的 HTTP 方法: {}", other)),
    };
    if let Some(c) = cookie {
        if !c.is_empty() {
            req = req.header("Cookie", c);
        }
    }
    if let Some(a) = auth {
        if !a.is_empty() {
            req = req.header("Authorization", a);
        }
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| format!("请求失败: {}", e))?;
    let status = resp.status().as_u16();
    let mut session_cookie = String::new();
    for v in resp.headers().get_all(reqwest::header::SET_COOKIE) {
        if let Ok(s) = v.to_str() {
            if let Some(rest) = s.strip_prefix("xt_session=") {
                session_cookie = rest.split(';').next().unwrap_or("").to_string();
            }
        }
    }
    let text = resp.text().await.map_err(|e| format!("读响应失败: {}", e))?;
    Ok(HttpResult {
        status,
        body: text,
        session_cookie,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_script_style_and_tags() {
        let html = r#"<html><head><style>body{color:red}</style><script>alert(1)</script></head>
            <body><h1>标题</h1><p>第一段 <b>加粗</b></p><noscript>no</noscript><p>第二段</p></body></html>"#;
        let text = html_to_text(html);
        assert!(!text.contains("alert"), "script 内容被剥: {}", text);
        assert!(!text.contains("color:red"), "style 内容被剥: {}", text);
        assert!(!text.contains("<b>"), "标签被剥: {}", text);
        assert!(text.contains("标题"), "正文保留: {}", text);
        assert!(text.contains("第一段 加粗"), "内联标签剥掉文本保留: {}", text);
        assert!(text.contains("第二段"), "多段保留: {}", text);
    }

    #[test]
    fn unescapes_entities() {
        let text = html_to_text("<p>a &amp; b &lt;x&gt; &quot;q&quot; &#39;s&#39; x&nbsp;y</p>");
        assert!(text.contains("a & b <x> \"q\" 's' x y"), "实体反转义: {}", text);
    }

    #[test]
    fn collapses_whitespace() {
        let text = html_to_text("<p>a   b</p>\n\n\n\n<p>c</p>");
        assert!(!text.contains("   "), "连续空白压缩: {:?}", text);
        assert!(!text.contains("\n\n\n"), "连续空行压缩: {:?}", text);
    }

    #[test]
    fn utf8_safe() {
        let text = html_to_text("<p>中文多字节字符〔1〕测试</p>");
        assert!(text.contains("中文多字节字符〔1〕测试"), "多字节安全: {}", text);
    }

    #[test]
    fn find_ascii_ci_works() {
        assert_eq!(find_ascii_ci("x</SCRIPT>y", "</script>"), Some(1));
        assert_eq!(find_ascii_ci("abc", "</script>"), None);
    }

    #[test]
    fn unescapes_numeric_entities() {
        // 必应摘要实测含数字实体(&#225;),不解码会在模型侧显示为乱码
        let text = html_to_text("<p>xu&#225;n &#x4E2D;&#25991; &#999999999; &#xZZ;</p>");
        assert!(text.contains("xuán"), "十进制实体: {}", text);
        assert!(text.contains("中文"), "十六进制实体: {}", text);
        assert!(text.contains("&#999999999;") || text.contains("999999999"), "越界码点不崩: {}", text);
    }

    #[test]
    fn parses_bing_results() {
        // 结构取自 2026-10 必应国内版实测(直链 href + b_lineclamp 摘要)
        let html = r#"
            <li class="b_algo"><h2><a href="https://baike.baidu.com/item/%E7%8E%84/1876">玄（汉语文字）_百度百科</a></h2>
            <p class="b_lineclamp4">玄（拼音：xu&#225;n）为汉语一级通用规范汉字</p></li>
            <li class="b_algo"><h2 class="x"><a href="https://xt.markjy.com/">玄铁 XuanTie</a></h2>
            <p>自举编译器 XTC 逐代编译达成字节级定点。</p></li>
            <li class="b_algo"><h2><a href="/local/path">内部链接应跳过</a></h2><p>本地路径</p></li>
        "#;
        let results = parse_bing_results(html);
        assert_eq!(results.len(), 2, "非 http 链接被跳过: {:?}", results);
        assert_eq!(results[0].1, "https://baike.baidu.com/item/%E7%8E%84/1876");
        assert!(results[0].0.contains("百度百科"), "标题: {:?}", results[0]);
        assert!(results[0].2.contains("xuán"), "摘要含解码实体: {:?}", results[0]);
        assert_eq!(results[1].1, "https://xt.markjy.com/");
        assert!(results[1].2.contains("自举编译器"), "摘要: {:?}", results[1]);
    }

    #[test]
    fn urlencodes_query() {
        assert_eq!(urlencoding("abc-1_.~"), "abc-1_.~");
        assert_eq!(urlencoding("玄铁"), "%E7%8E%84%E9%93%81");
        assert_eq!(urlencoding("a b&c"), "a%20b%26c");
    }
}
