// 系统字体枚举与外部字体导入。
//
// 系统字体不依赖第三方 crate:只读每个字体文件的表目录与 name 表,拿 family name。
// 这样扫描几十上百个字体文件时不必把整个字体读进内存。支持 TTF/OTF/TTC/OTC。
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use tauri::{AppHandle, Manager};

static SYSTEM_FONTS: OnceLock<Vec<String>> = OnceLock::new();

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFont {
    family: String,
    path: String,
    data_url: String,
}

#[tauri::command]
pub fn list_system_fonts() -> Vec<String> {
    SYSTEM_FONTS.get_or_init(scan_system_fonts).clone()
}

#[tauri::command]
pub fn import_font(app: AppHandle, path: String) -> Result<ImportedFont, String> {
    let src = PathBuf::from(&path);
    let ext = src
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "ttf" && ext != "otf" {
        return Err("只支持导入 .ttf / .otf 字体".to_string());
    }
    let data = fs::read(&src).map_err(|e| format!("读取字体失败: {e}"))?;
    // 优先使用字体内部 family 名;解析失败才退化为文件名
    let family = families_from_file(&src)
        .into_iter()
        .next()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| {
            src.file_stem()
                .and_then(|n| n.to_str())
                .map(|n| n.trim().to_string())
                .filter(|n| !n.is_empty())
        })
        .unwrap_or_else(|| "导入字体".to_string());
    let file_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "字体文件名非法".to_string())?
        .to_string();

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("取应用数据目录失败: {e}"))?
        .join("fonts");
    fs::create_dir_all(&dir).map_err(|e| format!("建字体目录失败: {e}"))?;
    let stored = dir.join(&file_name);
    fs::write(&stored, &data).map_err(|e| format!("保存字体失败: {e}"))?;

    let data_url = data_url(&ext, &data);
    Ok(ImportedFont {
        family,
        path: stored.to_string_lossy().to_string(),
        data_url,
    })
}

/// 启动时按设置里的导入路径重新登记字体。
#[tauri::command]
pub fn font_data_url(path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "ttf" && ext != "otf" {
        return Err("字体路径不是 .ttf / .otf".to_string());
    }
    let data = fs::read(&p).map_err(|e| format!("读取字体失败: {e}"))?;
    Ok(data_url(&ext, &data))
}

fn data_url(ext: &str, data: &[u8]) -> String {
    let mime = if ext == "otf" { "font/otf" } else { "font/ttf" };
    format!("data:{mime};base64,{}", base64_encode(data))
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn scan_system_fonts() -> Vec<String> {
    let mut files = Vec::new();
    for root in font_roots() {
        collect_font_files(&root, &mut files, 0);
    }
    files.sort();
    files.dedup();

    // key 用小写去重,value 保留首次遇到的大小写
    let mut names: BTreeMap<String, String> = BTreeMap::new();
    for file in files {
        let families = families_from_file(&file);
        if families.is_empty() {
            if let Some(stem) = file.file_stem().and_then(|s| s.to_str()) {
                let stem = stem.trim();
                if !stem.is_empty() {
                    names.entry(stem.to_lowercase()).or_insert_with(|| stem.to_string());
                }
            }
            continue;
        }
        for family in families {
            let family = family.trim().to_string();
            if family.is_empty() {
                continue;
            }
            names.entry(family.to_lowercase()).or_insert(family);
        }
    }
    let mut out: Vec<String> = names.into_values().collect();
    out.sort_by_key(|s| s.to_lowercase());
    out
}

fn font_roots() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    #[cfg(target_os = "windows")]
    {
        let windir = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        roots.push(windir.join("Fonts"));
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            roots.push(PathBuf::from(local).join("Microsoft").join("Windows").join("Fonts"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        roots.push(PathBuf::from("/System/Library/Fonts"));
        roots.push(PathBuf::from("/System/Library/Fonts/Supplemental"));
        roots.push(PathBuf::from("/Library/Fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            roots.push(PathBuf::from(home).join("Library").join("Fonts"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        roots.push(PathBuf::from("/usr/share/fonts"));
        roots.push(PathBuf::from("/usr/local/share/fonts"));
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            roots.push(home.join(".local").join("share").join("fonts"));
            roots.push(home.join(".fonts"));
        }
    }
    roots
}

fn collect_font_files(dir: &Path, out: &mut Vec<PathBuf>, depth: u8) {
    if depth > 4 {
        return;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_font_files(&path, out, depth + 1);
        } else if is_font_file(&path) {
            out.push(path);
        }
    }
}

fn is_font_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .as_deref(),
        Some("ttf" | "otf" | "ttc" | "otc")
    )
}

/// 从字体文件里读取所有 face 的 family 名(只读表目录和 name 表,不整文件读入)。
fn families_from_file(path: &Path) -> Vec<String> {
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    let Ok(len) = f.metadata().map(|m| m.len()) else {
        return Vec::new();
    };
    if len < 12 {
        return Vec::new();
    }
    let mut head = [0u8; 12];
    if f.read_exact(&mut head).is_err() {
        return Vec::new();
    }
    let offsets = if &head[0..4] == b"ttcf" {
        let count = u32::from_be_bytes([head[8], head[9], head[10], head[11]]) as usize;
        if count == 0 || count > 512 {
            return Vec::new();
        }
        let mut buf = vec![0u8; count * 4];
        if f.seek(SeekFrom::Start(12)).is_err() || f.read_exact(&mut buf).is_err() {
            return Vec::new();
        }
        buf.chunks_exact(4)
            .map(|c| u32::from_be_bytes([c[0], c[1], c[2], c[3]]) as u64)
            .filter(|off| *off + 12 <= len)
            .collect()
    } else {
        vec![0]
    };
    let mut out = Vec::new();
    for offset in offsets {
        if let Some(family) = family_at(&mut f, len, offset) {
            if !out.iter().any(|n| n == &family) {
                out.push(family);
            }
        }
    }
    out
}

fn family_at(f: &mut File, len: u64, face_offset: u64) -> Option<String> {
    if face_offset + 12 > len {
        return None;
    }
    f.seek(SeekFrom::Start(face_offset + 4)).ok()?;
    let mut header = [0u8; 8];
    f.read_exact(&mut header).ok()?;
    let num_tables = u16::from_be_bytes([header[0], header[1]]) as usize;
    if num_tables == 0 || num_tables > 512 {
        return None;
    }
    let records_start = face_offset + 12;
    let bytes = num_tables * 16;
    if records_start + bytes as u64 > len {
        return None;
    }
    let mut records = vec![0u8; bytes];
    f.seek(SeekFrom::Start(records_start)).ok()?;
    f.read_exact(&mut records).ok()?;

    let mut name_offset = 0u32;
    let mut name_length = 0u32;
    for record in records.chunks_exact(16) {
        if &record[0..4] == b"name" {
            name_offset = u32::from_be_bytes([record[8], record[9], record[10], record[11]]);
            name_length = u32::from_be_bytes([record[12], record[13], record[14], record[15]]);
            break;
        }
    }
    if name_offset == 0 || name_length < 6 {
        return None;
    }
    if name_offset as u64 + name_length as u64 > len {
        return None;
    }
    // name 表通常很小;异常长度按上限截断,避免坏字体让内存暴涨
    let take = name_length.min(4 * 1024 * 1024) as usize;
    let mut table = vec![0u8; take];
    f.seek(SeekFrom::Start(name_offset as u64)).ok()?;
    f.read_exact(&mut table).ok()?;
    parse_name_table(&table)
}

fn parse_name_table(t: &[u8]) -> Option<String> {
    let count = read_u16(t, 2)? as usize;
    let string_offset = read_u16(t, 4)? as usize;
    let mut best: Option<(i32, String)> = None;
    for i in 0..count {
        let rec = 6 + i * 12;
        if rec + 12 > t.len() {
            break;
        }
        let platform = read_u16(t, rec)?;
        let _encoding = read_u16(t, rec + 2)?;
        let language = read_u16(t, rec + 4)?;
        let name_id = read_u16(t, rec + 6)?;
        if name_id != 1 && name_id != 16 {
            continue;
        }
        let length = read_u16(t, rec + 8)? as usize;
        let offset = read_u16(t, rec + 10)? as usize;
        let start = string_offset + offset;
        if start + length > t.len() {
            continue;
        }
        let text = decode_name(&t[start..start + length], platform);
        let text = text.trim_matches('\0').trim();
        if text.is_empty() {
            continue;
        }
        let mut score = if name_id == 16 { 20 } else { 10 };
        if platform == 3 {
            score += 10;
            if language == 0x0409 {
                score += 10;
            }
        } else if platform == 0 {
            score += 6;
        }
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, text.to_string()));
        }
    }
    best.map(|(_, s)| s)
}

fn read_u16(data: &[u8], off: usize) -> Option<u16> {
    let b = data.get(off..off + 2)?;
    Some(u16::from_be_bytes([b[0], b[1]]))
}

fn decode_name(bytes: &[u8], platform: u16) -> String {
    if platform == 0 || platform == 3 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_be_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn system_fonts_are_detected() {
        let fonts = list_system_fonts();
        assert!(!fonts.is_empty(), "系统字体扫描结果为空");
        assert!(fonts.iter().all(|f| !f.trim().is_empty()));
    }

    #[test]
    fn data_url_reads_a_system_ttf() {
        let mut files = Vec::new();
        for root in font_roots() {
            collect_font_files(&root, &mut files, 0);
        }
        let Some(path) = files
            .into_iter()
            .find(|p| p.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("ttf")))
        else {
            return; // 精简系统可能没有 ttf;不把环境缺失当功能失败
        };
        let url = font_data_url(path.to_string_lossy().to_string()).expect("读取系统 ttf 失败");
        assert!(url.starts_with("data:font/ttf;base64,"));
        assert!(url.len() > 100);
    }

    #[test]
    fn base64_roundtrip_shape() {
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
    }
}
