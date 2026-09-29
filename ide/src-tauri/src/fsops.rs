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

// 不进文件树的目录(IDE 自身/工具链产物)
fn skipped(name: &str) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "target" | "dist" | "gen" | "__pycache__" | ".vscode"
    )
}

#[tauri::command]
pub async fn fs_read_file(path: String) -> Result<String, String> {
    let raw = fs::read(&path).map_err(|e| format!("读失败 {}: {}", path, e))?;
    // 编译器世界是 UTF-8:非 UTF-8 文件宁可报错也不乱码展示
    let mut text =
        String::from_utf8(raw).map_err(|_| format!("文件不是有效 UTF-8: {}", path))?;
    if text.starts_with('\u{feff}') {
        text.remove(0);
    }
    Ok(text)
}

#[tauri::command]
pub async fn fs_write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.parent().map_or(false, |d| d.is_dir()) {
        return Err(format!("父目录不存在: {}", path));
    }
    fs::write(p, content).map_err(|e| format!("写失败 {}: {}", path, e))
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
