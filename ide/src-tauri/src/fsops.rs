// 文件系统命令:读/写/树/建/改名/删(删除走回收站,不做硬删兜底)
use serde::Serialize;
use std::fs;
use std::path::Path;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<FileNode>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResult {
    pub text: String,
    pub encoding: String,
}

const BOM_UTF8: [u8; 3] = [0xEF, 0xBB, 0xBF];

// 编码探测阶梯:BOM > 严格 UTF-8 > GBK(无错) > GB18030(替换,可能乱码)
// 返回 (文本, 编码标签);标签同时是"按编码保存"接受的取值
fn decode_bytes(raw: &[u8]) -> (String, String) {
    if raw.starts_with(&BOM_UTF8) {
        return (
            String::from_utf8_lossy(&raw[3..]).into_owned(),
            "UTF-8 BOM".into(),
        );
    }
    if raw.starts_with(&[0xFF, 0xFE]) {
        let (text, _, had_errors) = encoding_rs::UTF_16LE.decode(&raw[2..]);
        return (
            text.into_owned(),
            if had_errors {
                "UTF-16 LE(有损)".into()
            } else {
                "UTF-16 LE".into()
            },
        );
    }
    if raw.starts_with(&[0xFE, 0xFF]) {
        let (text, _, had_errors) = encoding_rs::UTF_16BE.decode(&raw[2..]);
        return (
            text.into_owned(),
            if had_errors {
                "UTF-16 BE(有损)".into()
            } else {
                "UTF-16 BE".into()
            },
        );
    }
    if let Ok(text) = std::str::from_utf8(raw) {
        return (text.to_string(), "UTF-8".into());
    }
    let (text, _, had_errors) = encoding_rs::GBK.decode(raw);
    if !had_errors {
        return (text.into_owned(), "GBK".into());
    }
    let (text, _, _) = encoding_rs::GB18030.decode(raw);
    (text.into_owned(), "GB18030(有损)".into())
}

// 按指定标签编码;无法表示的字符宁报错不静默替换
fn encode_text(text: &str, encoding: &str) -> Result<Vec<u8>, String> {
    match encoding {
        "UTF-8" => Ok(text.as_bytes().to_vec()),
        "UTF-8 BOM" => {
            let mut out = BOM_UTF8.to_vec();
            out.extend_from_slice(text.as_bytes());
            Ok(out)
        }
        "UTF-16 LE" => {
            // encode 返回 (字节, 实际编码, 是否有损)
            let (bytes, _, had_errors) = encoding_rs::UTF_16LE.encode(text);
            if had_errors {
                return Err(format!("存在无法用 {} 表示的字符", encoding));
            }
            let mut out = vec![0xFF, 0xFE];
            out.extend_from_slice(&bytes);
            Ok(out)
        }
        "UTF-16 BE" => {
            let (bytes, _, had_errors) = encoding_rs::UTF_16BE.encode(text);
            if had_errors {
                return Err(format!("存在无法用 {} 表示的字符", encoding));
            }
            let mut out = vec![0xFE, 0xFF];
            out.extend_from_slice(&bytes);
            Ok(out)
        }
        "GBK" | "GB18030" | "Big5" | "Shift-JIS" | "Windows-1252" => {
            let enc = encoding_rs::Encoding::for_label(encoding.to_lowercase().as_bytes())
                .ok_or_else(|| format!("未知编码: {}", encoding))?;
            let (bytes, _, had_errors) = enc.encode(text);
            if had_errors {
                return Err(format!("存在无法用 {} 表示的字符", encoding));
            }
            Ok(bytes.into_owned())
        }
        other => Err(format!("不支持的编码: {}", other)),
    }
}

// 不进文件树的目录(IDE 自身/工具链产物)
fn skipped(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "gen" | "__pycache__" | ".vscode"
    )
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<ReadResult, String> {
    let raw = fs::read(&path).map_err(|e| format!("读失败 {}: {}", path, e))?;
    let (mut text, encoding) = decode_bytes(&raw);
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    Ok(ReadResult { text, encoding })
}

// 按用户显式指定的编码重新打开(不走探测)
#[tauri::command]
pub async fn fs_read_file_as(path: String, encoding: String) -> Result<String, String> {
    let raw = fs::read(&path).map_err(|e| format!("读失败 {}: {}", path, e))?;
    let text = match encoding.as_str() {
        "UTF-8" | "UTF-8 BOM" => {
            let body = raw.strip_prefix(&BOM_UTF8[..]).unwrap_or(&raw);
            String::from_utf8_lossy(body).into_owned()
        }
        "UTF-16 LE" => encoding_rs::UTF_16LE.decode(&raw).0.into_owned(),
        "UTF-16 BE" => encoding_rs::UTF_16BE.decode(&raw).0.into_owned(),
        label => {
            let enc = encoding_rs::Encoding::for_label(label.to_lowercase().as_bytes())
                .ok_or_else(|| format!("未知编码: {}", label))?;
            enc.decode(&raw).0.into_owned()
        }
    };
    let mut text = text;
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    Ok(text)
}

#[tauri::command]
pub async fn fs_write_file(
    path: String,
    content: String,
    encoding: Option<String>,
) -> Result<(), String> {
    let bytes = match encoding.as_deref() {
        None | Some("UTF-8") => content.into_bytes(),
        Some(label) => encode_text(&content, label)?,
    };
    let p = Path::new(&path);
    if !p.parent().map_or(false, |d| d.is_dir()) {
        return Err(format!("父目录不存在: {}", path));
    }
    match fs::write(p, bytes) {
        Ok(()) => Ok(()),
        // 权限不足(需管理员/只读):返回可识别前缀,前端给出提权重启通路
        Err(e)
            if e.kind() == std::io::ErrorKind::PermissionDenied || e.raw_os_error() == Some(5) =>
        {
            Err(format!("ELEVATE:{}", path))
        }
        Err(e) => Err(format!("写失败 {}: {}", path, e)),
    }
}

const MAX_ENTRIES: usize = 20000;

fn walk(dir: &Path, depth: u32, count: &mut usize) -> Result<Vec<FileNode>, String> {
    let mut nodes = Vec::new();
    if depth > 24 {
        return Ok(nodes);
    }
    let entries =
        fs::read_dir(dir).map_err(|e| format!("读目录失败 {}: {}", dir.display(), e))?;
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    // 目录在前,同按名称排序
    items.sort_by(|a, b| {
        let da = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let db = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        db.cmp(&da).then_with(|| a.file_name().cmp(&b.file_name()))
    });
    for entry in items {
        *count += 1;
        if *count > MAX_ENTRIES {
            return Err("目录条目过多(>20000),拒绝全量加载".into());
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let path = entry.path();
        if is_dir {
            if skipped(&name) {
                continue;
            }
            let children = walk(&path, depth + 1, count)?;
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children,
            });
        } else {
            nodes.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: false,
                children: Vec::new(),
            });
        }
    }
    Ok(nodes)
}

#[tauri::command]
pub async fn fs_list_tree(root: String) -> Result<Vec<FileNode>, String> {
    let mut count = 0usize;
    walk(Path::new(&root), 0, &mut count)
}

#[tauri::command]
pub async fn fs_create_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("已存在,拒绝覆盖: {}", path));
    }
    fs::write(p, content).map_err(|e| format!("创建失败 {}: {}", path, e))
}

#[tauri::command]
pub async fn fs_create_dir(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err(format!("已存在: {}", path));
    }
    fs::create_dir_all(&path).map_err(|e| format!("创建目录失败 {}: {}", path, e))
}

#[tauri::command]
pub async fn fs_rename(from: String, to: String) -> Result<(), String> {
    if Path::new(&to).exists() {
        return Err(format!("目标已存在: {}", to));
    }
    fs::rename(&from, &to).map_err(|e| format!("改名失败 {} → {}: {}", from, to, e))
}

#[tauri::command]
pub async fn fs_delete(path: String) -> Result<(), String> {
    trash::delete(&path).map_err(|e| format!("删除失败(回收站) {}: {}", path, e))
}

#[tauri::command]
pub async fn fs_exists(path: String) -> Result<bool, String> {
    Ok(Path::new(&path).exists())
}

/// 列目录一级条目(名字;目录名带尾 / 标注);按名排序,限 1000 条。
/// 供 IDE 构建"环境快照"(官方库子目录清单等)注入系统提示词,免去 AI 反复 dir 探测。
#[tauri::command]
pub async fn fs_list_dir(path: String) -> Result<Vec<String>, String> {
    let entries = fs::read_dir(&path).map_err(|e| format!("读目录失败 {}: {}", path, e))?;
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                format!("{}/", name)
            } else {
                name
            }
        })
        .collect();
    names.sort();
    names.truncate(1000);
    Ok(names)
}

// ---- 工程指令文件(AGENTS.md / XuanTieAI.md)----
// 参考 DSH agent-instructions 的发现语义(工程目录同层候选、按序、限大小),简化到本需求:
// 只读工程根目录(不递归),文件名不区分大小写匹配 AGENTS.md / XuanTieAI.md。

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInstruction {
    /// 磁盘上的真实文件名(回显用)
    pub name: String,
    pub path: String,
    pub content: String,
}

/// 单个工程指令文件的大小上限(超过则忽略,与 DSH maxSourceBytes 精神一致)
const INSTRUCTION_MAX_BYTES: u64 = 100 * 1024;

#[tauri::command]
pub async fn project_instructions(root: String) -> Result<Vec<ProjectInstruction>, String> {
    let dir = Path::new(&root);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        // 目录不可读:按"没有指令"处理(不阻塞 Agent 启动)
        Err(_) => return Ok(Vec::new()),
    };
    // 候选顺序固定:AGENTS.md 优先于 XuanTieAI.md(两份都存在时都会携带)
    let wanted = ["agents.md", "xuantieai.md"];
    let mut found: Vec<(usize, ProjectInstruction)> = Vec::new();
    for entry in entries.filter_map(|e| e.ok()) {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_lowercase();
        let Some(rank) = wanted.iter().position(|w| *w == lower) else {
            continue;
        };
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Ok(meta) = path.metadata() {
            if meta.len() > INSTRUCTION_MAX_BYTES {
                continue;
            }
        }
        let bytes = match fs::read(&path) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let mut content = String::from_utf8_lossy(&bytes).into_owned();
        if content.starts_with('\u{feff}') {
            content.remove(0);
        }
        found.push((
            rank,
            ProjectInstruction {
                name,
                path: path.to_string_lossy().to_string(),
                content,
            },
        ));
    }
    found.sort_by_key(|(rank, _)| *rank);
    Ok(found.into_iter().map(|(_, v)| v).collect())
}
