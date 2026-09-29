// 新建工程脚手架:<父目录>/<工程名>/ + 玄铁.配置.toml + 主.xt
// 工程配置格式对齐 xuantie_compiler/玄铁.配置.toml([项目] 入口 / [编译] 严格度·忽略警告)
use std::path::Path;

const CONFIG_FILE: &str = "[项目]\r\n入口 = \"主.xt\"\r\n\r\n[编译]\r\n严格度 = 默认\r\n忽略警告 = [\"W001\"]\r\n";

const MAIN_CONSOLE: &str = r#"// 主.xt —— 玄铁控制台示例
// 运行:点工具栏「▶ 运行」,或在终端执行 xtc pao 主.xt

设 名字: 字 = "玄铁"
示("你好,#{名字}!1+1=#{1+1}")

// 下一步:把 名字 换成你的名字;装包用工具栏「铁铺」
"#;

const MAIN_EMPTY: &str = "// 主.xt\n";

#[tauri::command]
pub async fn scaffold_project(dir: String, name: String, template: String) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(format!("工程名非法: {}", name));
    }
    let root = Path::new(&dir).join(&name);
    if root.exists() {
        return Err(format!("目录已存在: {}", root.display()));
    }
    std::fs::create_dir_all(&root).map_err(|e| format!("建工程目录失败: {}", e))?;
    std::fs::write(root.join("玄铁.配置.toml"), CONFIG_FILE)
        .map_err(|e| format!("写工程配置失败: {}", e))?;
    let main_src = match template.as_str() {
        "console" => MAIN_CONSOLE,
        "empty" => MAIN_EMPTY,
        other => {
            // 清掉半成品目录:模板名非法是编程错误,报错而非静默
            let _ = std::fs::remove_dir_all(&root);
            return Err(format!("未知模板: {}", other));
        }
    };
    std::fs::write(root.join("主.xt"), main_src).map_err(|e| format!("写 主.xt 失败: {}", e))?;
    Ok(root.to_string_lossy().to_string())
}
