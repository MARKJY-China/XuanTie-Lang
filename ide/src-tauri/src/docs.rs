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

/// 玄铁基础认知块缓存路径(app 数据目录 primer.txt;与文档库同级)。
fn primer_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("建应用数据目录失败: {}", e))?;
    Ok(dir.join("primer.txt"))
}

/// 读本地缓存的玄铁基础认知块(社区后台版本覆盖后落盘;未缓存返回 None → 前端用内置常量)。
#[tauri::command]
pub async fn primer_read(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let path = primer_path(&app)?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(Some(s)),
        Err(_) => Ok(None),
    }
}

/// 写本地缓存(空内容不写——后台清空认知块时保留本地/内置兜底)。
#[tauri::command]
pub async fn primer_write(app: tauri::AppHandle, content: String) -> Result<(), String> {
    if content.trim().is_empty() {
        return Ok(());
    }
    let path = primer_path(&app)?;
    std::fs::write(&path, content).map_err(|e| format!("写认知块缓存失败: {}", e))
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
    index.push_str("\n需要语言特性/关键字/标准库用法时:先用 docs_search 按关键词检索(返回命中所在章节整块);需要可直接抄的完整代码示例时用 example_search;仍不够再 read_file 精读原文。\n");
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
    // 块返回:命中行不再是单行,而是扩展到"所在章节"(向上遇标题停且限 40 行,向下遇标题停
    // 且限 60 行)——AI 实测反馈:单行命中必然触发第二次 read_file,块返回可砍掉一半往返。
    let mut blocks: Vec<(String, usize, usize, String)> = Vec::new(); // (文件, 起, 止, 文本)
    let mut files_scanned = 0usize;
    let per_file_cap = 2usize;
    let total_chars_cap = 20000usize;
    let mut total_chars = 0usize;
    for (rel, path) in &files {
        if blocks.len() >= max || total_chars >= total_chars_cap {
            break;
        }
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        files_scanned += 1;
        let lines: Vec<&str> = text.lines().collect();
        let mut in_file = 0usize;
        let mut last_end: Option<usize> = None;
        for (i, line) in lines.iter().enumerate() {
            if !line.to_lowercase().contains(&q_lower) {
                continue;
            }
            let (start, end) = extract_block(&lines, i);
            // 与上一块重叠则合并跳过(同一节多个命中只出一次)
            if let Some(le) = last_end {
                if start <= le + 1 {
                    continue;
                }
            }
            let body: String = lines[start..=end].join("\n");
            total_chars += body.len();
            blocks.push((rel.clone(), start + 1, end + 1, body));
            last_end = Some(end);
            in_file += 1;
            if in_file >= per_file_cap || total_chars >= total_chars_cap {
                break;
            }
        }
    }
    if blocks.is_empty() {
        return Ok(format!(
            "未在玄铁文档中找到「{}」(已扫描 {} 篇)",
            q, files_scanned
        ));
    }
    let mut out = format!(
        "玄铁文档检索「{}」:{} 个命中章节{}。\n",
        q,
        blocks.len(),
        if blocks.len() >= max || total_chars >= total_chars_cap {
            "(已达上限,可换更精确的关键词)"
        } else {
            ""
        }
    );
    for (rel, a, b, body) in &blocks {
        out.push_str(&format!("── {}:{}-{} ──\n{}\n\n", rel, a, b, body));
    }
    out.push_str("(以上为命中所在章节的完整内容;需要更多用 read_file 打开原文档)");
    Ok(out)
}

/// 命中行扩展为所在章节:向上到最近标题(含,限 40 行),向下到下一标题(不含,限 60 行)。
fn extract_block(lines: &[&str], hit: usize) -> (usize, usize) {
    let mut start = hit;
    let mut up = 0;
    while start > 0 && up < 40 {
        start -= 1;
        up += 1;
        if lines[start].starts_with('#') {
            break;
        }
    }
    let mut end = hit;
    let mut down = 0;
    while end + 1 < lines.len() && down < 60 {
        end += 1;
        down += 1;
        if lines[end].starts_with('#') {
            end -= 1;
            break;
        }
    }
    (start, end)
}

/// 完整代码示例检索:扫描本地文档的 ```xuanti/```xuantie 栅栏块,按关键词命中数排序返回。
/// (AI 实测反馈:模板是"拷贝-改写器",需要的是完整可跑片段,不是规格行)
#[tauri::command]
pub async fn docs_examples(
    app: tauri::AppHandle,
    query: String,
    max_examples: Option<usize>,
) -> Result<String, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("搜索词不能为空".into());
    }
    let dir = docs_root(&app)?;
    let q_lower = q.to_lowercase();
    let max = max_examples.unwrap_or(3).clamp(1, 6);
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    collect_md_files(&dir, &dir, &mut files);
    if files.is_empty() {
        return Err("本地尚无玄铁文档(等待启动时自动拉取,或在设置中手动检查更新)".into());
    }
    // (文件, 起行, 止行, 块文本, 命中数)
    let mut found: Vec<(String, usize, usize, String, usize)> = Vec::new();
    for (rel, path) in &files {
        let Ok(text) = std::fs::read_to_string(path) else {
            continue;
        };
        let lines: Vec<&str> = text.lines().collect();
        let mut i = 0usize;
        while i < lines.len() {
            let t = lines[i].trim();
            if t.starts_with("```") {
                let fence = t.trim_start_matches('`').trim().to_lowercase();
                let is_xuan = fence.starts_with("xuanti") || fence.starts_with("xuantie");
                let start = i;
                let mut j = i + 1;
                while j < lines.len() && !lines[j].trim().starts_with("```") {
                    j += 1;
                }
                if is_xuan && j < lines.len() {
                    let body: String = lines[start + 1..j].join("\n");
                    let score = body.to_lowercase().matches(&q_lower).count();
                    if score > 0 {
                        found.push((rel.clone(), start + 2, j + 1, body, score));
                    }
                    i = j + 1;
                    continue;
                }
                i = j + 1;
                continue;
            }
            i += 1;
        }
    }
    if found.is_empty() {
        return Ok(format!("未找到含「{}」的玄铁代码示例(试试更通用的关键词,或改用 docs_search)", q));
    }
    found.sort_by(|a, b| b.4.cmp(&a.4));
    found.truncate(max);
    let mut out = format!("玄铁代码示例「{}」:{} 段(可直接抄改;来源为本地官方文档)\n", q, found.len());
    let mut chars = 0usize;
    for (n, (rel, a, b, body, _)) in found.iter().enumerate() {
        out.push_str(&format!("── 示例 {} · {}:{}-{} ──\n```xuanti\n{}\n```\n\n", n + 1, rel, a, b, body));
        chars += body.len();
        if chars > 12000 {
            out.push_str("(已截断:示例总量超预算,如需更多请收窄关键词)\n");
            break;
        }
    }
    Ok(out)
}
