// 玄铁语言文档本地库:从文档站拉取 all.txt,按分篇标记切分为单文件落盘,
// 供 Agent 用 read_file 按需阅读(索引注入系统提示词,内容不整篇进上下文)。
// all.txt 格式(build-ai-docs.mjs 生成):每篇以 "============ <相对路径> ============" 分隔;
// 文件首部带 UTF-8 BOM(对象存储无 charset 头时的编码自证)。
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::PathBuf;
use tauri::Manager;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsFetchResult {
    pub count: usize,
    pub dir: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsIndex {
    pub dir: String,
    pub index: String,
    pub count: usize,
}

const DOCS_MAX_BYTES: usize = 16 * 1024 * 1024;

fn docs_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {}", e))?
        .join("docs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("建文档目录失败: {}", e))?;
    Ok(dir)
}

/// 文档目录(供工具白名单与设置展示)
#[tauri::command]
pub async fn docs_dir(app: tauri::AppHandle) -> Result<String, String> {
    Ok(docs_root(&app)?.to_string_lossy().to_string())
}

/// 相对路径安全过滤:拒绝绝对路径/盘符/.. 逃逸(文档站来源不可完全信任)
fn safe_rel(rel: &str) -> Option<String> {
    let rel = rel.trim().replace('\\', "/");
    if rel.is_empty() || rel.starts_with('/') || rel.contains(':') {
        return None;
    }
    if rel.split('/').any(|seg| seg.is_empty() || seg == ".." || seg == ".") {
        return None;
    }
    Some(rel)
}

/// 下载并按分篇标记切分 all.txt,全量替换本地文档目录;返回篇数。
#[tauri::command]
pub async fn fetch_docs(
    app: tauri::AppHandle,
    base_url: String,
    version: String,
) -> Result<DocsFetchResult, String> {
    if !base_url.starts_with("https://") && !base_url.starts_with("http://localhost") && !base_url.starts_with("http://127.0.0.1") {
        return Err("文档站地址必须为 https".into());
    }
    let url = format!("{}/ai/all.txt", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .user_agent("xuantie-foundry/0.3")
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("HTTP 客户端初始化失败: {}", e))?;
    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("文档下载失败: {}", e))?;
    if resp.status().as_u16() != 200 {
        return Err(format!("文档站返回 HTTP {}", resp.status().as_u16()));
    }
    use futures::StreamExt;
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let b = chunk.map_err(|e| format!("读取文档失败: {}", e))?;
        buf.extend_from_slice(&b);
        if buf.len() >= DOCS_MAX_BYTES {
            buf.truncate(DOCS_MAX_BYTES);
            break;
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text);

    // 切分:分隔行为 12 个等号 + 空格 + 相对路径 + 空格 + 12 个等号
    let mut sections: Vec<(String, String)> = Vec::new();
    let mut cur_rel: Option<String> = None;
    let mut cur_body = String::new();
    for line in text.lines() {
        let trimmed = line.trim_end();
        if trimmed.starts_with("============") && trimmed.ends_with("============") {
            if let Some(rel) = cur_rel.take() {
                sections.push((rel, std::mem::take(&mut cur_body)));
            }
            let mid = trimmed.trim_matches('=').trim();
            cur_rel = safe_rel(mid);
            continue;
        }
        if cur_rel.is_some() {
            cur_body.push_str(line);
            cur_body.push('\n');
        }
    }
    if let Some(rel) = cur_rel.take() {
        sections.push((rel, cur_body));
    }
    if sections.is_empty() {
        return Err("all.txt 未解析到任何文档(格式与预期不符)".into());
    }

    // 全量替换:清空旧文档目录再写(避免旧篇残留)
    let dir = docs_root(&app)?;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            let p = entry.path();
            if p.is_dir() {
                let _ = std::fs::remove_dir_all(&p);
            } else {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    let mut manifest: Vec<(String, String)> = Vec::new();
    for (rel, body) in &sections {
        let path = dir.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("建文档子目录失败: {}", e))?;
        }
        std::fs::write(&path, body).map_err(|e| format!("写文档 {} 失败: {}", rel, e))?;
        // 标题:首行 "# XXX";缺省用文件名(去扩展名)
        let title = body
            .lines()
            .find(|l| l.starts_with("# "))
            .map(|l| l.trim_start_matches('#').trim().to_string())
            .unwrap_or_else(|| {
                rel.rsplit('/').next().unwrap_or(rel).trim_end_matches(".md").to_string()
            });
        manifest.push((rel.clone(), title));
    }

    // INDEX.md:顶层逐条列,子目录按组聚合(索引要短——它会随每轮对话进系统提示词)
    let mut top: Vec<&(String, String)> = Vec::new();
    let mut subs: BTreeMap<&str, usize> = BTreeMap::new();
    for item in &manifest {
        match item.0.split_once('/') {
            Some((d, _)) => *subs.entry(d).or_insert(0) += 1,
            None => top.push(item),
        }
    }
    let mut index = String::from("# 玄铁语言文档索引\n\n");
    for (rel, title) in &top {
        index.push_str(&format!("- {} → {}\n", title, rel));
    }
    for (d, n) in &subs {
        index.push_str(&format!("- {}/({} 篇,文件名即主题) → {}/\n", d, n, d));
    }
    index.push_str("\n需要语言特性/关键字/标准库用法时:先用 docs_search 按关键词检索定位,再对命中的文档用 read_file 精读,然后动手写代码。\n");
    std::fs::write(dir.join("INDEX.md"), &index).map_err(|e| format!("写索引失败: {}", e))?;
    std::fs::write(dir.join(".version"), &version).map_err(|e| format!("写版本标记失败: {}", e))?;

    let count = manifest.len();
    Ok(DocsFetchResult {
        count,
        dir: dir.to_string_lossy().to_string(),
    })
}

/// 本地文档索引(供 Agent 系统提示词注入;未拉取过返回 None)
#[tauri::command]
pub async fn docs_index(app: tauri::AppHandle) -> Result<Option<DocsIndex>, String> {
    let dir = docs_root(&app)?;
    let Ok(index) = std::fs::read_to_string(dir.join("INDEX.md")) else {
        return Ok(None);
    };
    let count = index.lines().filter(|l| l.starts_with("- ")).count();
    Ok(Some(DocsIndex {
        dir: dir.to_string_lossy().to_string(),
        index,
        count,
    }))
}

// ---- docs_search:关键词检索本地文档库(逐文件逐行匹配,返回 文档:行号 + 命中行) ----

fn collect_md_files(dir: &std::path::Path, base: &std::path::Path, out: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let p = entry.path();
        if p.is_dir() {
            collect_md_files(&p, base, out);
        } else if p.extension().map(|e| e == "md").unwrap_or(false) {
            let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
            if name == "INDEX.md" {
                continue;
            }
            let rel = p
                .strip_prefix(base)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_default();
            out.push((rel, p));
        }
    }
}

/// 关键词精确检索(全文逐行;ASCII 不区分大小写);每篇最多 5 条命中,总量封顶 max_results。
#[tauri::command]
pub async fn docs_search(
    app: tauri::AppHandle,
    query: String,
    max_results: Option<usize>,
) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("搜索词不能为空".into());
    }
    let dir = docs_root(&app)?;
    let max = max_results.unwrap_or(20).clamp(1, 50);
    let q_lower = q.to_lowercase();
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_md_files(&dir, &dir, &mut files);
    if files.is_empty() {
        return Err("本地尚无玄铁文档(等待启动时自动拉取,或在设置中手动检查更新)".into());
    }
    let mut hits: Vec<(String, usize, String)> = Vec::new();
    let mut files_scanned = 0usize;
    'outer: for (rel, path) in &files {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        files_scanned += 1;
        let mut per_file = 0usize;
        for (i, line) in text.lines().enumerate() {
            if line.to_lowercase().contains(&q_lower) {
                let snippet: String = line.trim().chars().take(200).collect();
                hits.push((rel.clone(), i + 1, snippet));
                per_file += 1;
                if per_file >= 5 || hits.len() >= max {
                    break;
                }
            }
        }
        if hits.len() >= max {
            break 'outer;
        }
    }
    if hits.is_empty() {
        return Ok(format!(
            "未在玄铁文档中找到「{}」(已扫描 {} 篇)",
            q, files_scanned
        ));
    }
    let mut out = format!(
        "玄铁文档检索「{}」:命中 {} 条{}。\n",
        q,
        hits.len(),
        if hits.len() >= max { "(已达上限,可换更精确的关键词)" } else { "" }
    );
    for (rel, no, line) in &hits {
        out.push_str(&format!("- {}:{}\n  {}\n", rel, no, line));
    }
    out.push_str("(用 read_file 打开对应文档阅读完整上下文)");
    Ok(out)
}
