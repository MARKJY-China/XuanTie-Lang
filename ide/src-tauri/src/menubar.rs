//! macOS 系统菜单栏:把自绘菜单行的功能桥接到屏幕顶部系统菜单
//!
//! 背景:作者在 Windows 上自绘了菜单行(文件/编辑/查看/编译/终端/帮助),
//! macOS 上没有系统菜单接入,屏幕顶栏一直是 Tauri 默认英文菜单。
//! 本模块(macOS 生效)构建中文系统菜单,菜单项 id 与前端自绘菜单的 act 一致,
//! 点击后经 "menu-act" 事件发给前端,由前端同一动作链执行(见 main.ts handleMenuAct)。
//! Windows/Linux 保留自绘菜单行,本模块不参与。

use tauri::menu::{Menu, MenuItemBuilder, PredefinedMenuItem, Submenu, SubmenuBuilder};
use tauri::menu::MenuEvent;
use tauri::{AppHandle, Manager, Wry};

/// 从设置文件读取最近工程列表(与前端 settings.recentWorkspaces 同源,存于 settings.json)
fn read_recents(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = app.path().app_config_dir() else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(dir.join("settings.json")) else {
        return vec![];
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else {
        return vec![];
    };
    v.get("recentWorkspaces")
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 第一个子菜单 = macOS 应用菜单(关于/隐藏/退出;退出用自定义项以便拦截红点逻辑)
fn app_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let about = MenuItemBuilder::with_id("app-about", "关于玄铁铸造厂").build(app)?;
    let services = PredefinedMenuItem::services(app, Some("服务"))?;
    let hide = PredefinedMenuItem::hide(app, Some("隐藏玄铁铸造厂"))?;
    let hide_others = PredefinedMenuItem::hide_others(app, Some("隐藏其他"))?;
    let show_all = PredefinedMenuItem::show_all(app, Some("全部显示"))?;
    // 自定义"退出":macOS 红点=隐藏/关窗常驻 Dock,退出必须走此菜单项(⌘Q)才放行
    let quit = MenuItemBuilder::with_id("quit-app", "退出玄铁铸造厂")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    SubmenuBuilder::new(app, "玄铁铸造厂")
        .item(&about)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&services)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&hide)
        .item(&hide_others)
        .item(&show_all)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&quit)
        .build()
}

fn file_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let open_folder = MenuItemBuilder::with_id("open-folder", "打开文件夹…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let new_project = MenuItemBuilder::with_id("new-project", "新建工程…")
        .accelerator("CmdOrCtrl+N")
        .build(app)?;
    // 打开最近工程(动态子菜单:每次重建菜单时读取最新 recentWorkspaces)
    let recents = read_recents(app);
    let mut recent = SubmenuBuilder::new(app, "打开最近工程");
    if recents.is_empty() {
        recent = recent.text("recent-noop", "(暂无最近工程)");
    } else {
        for (i, p) in recents.iter().enumerate() {
            recent = recent.text(format!("recent-open:{i}"), p.clone());
        }
        recent = recent.separator().text("recent-clear", "清除最近打开记录");
    }
    let recent = recent.build()?;
    let save = MenuItemBuilder::with_id("save", "保存").accelerator("CmdOrCtrl+S").build(app)?;
    let save_all = MenuItemBuilder::with_id("save-all", "全部保存").build(app)?;
    let refresh_tree = MenuItemBuilder::with_id("refresh-tree", "刷新文件树").build(app)?;
    let file = SubmenuBuilder::new(app, "文件")
        .item(&open_folder)
        .item(&new_project)
        .item(&recent)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&save)
        .item(&save_all)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&refresh_tree);
    // "以管理员身份重启"是 Windows 语义(UAC 提权重启),macOS 无此概念,不显示
    #[cfg(target_os = "windows")]
    {
        let relaunch = MenuItemBuilder::with_id("relaunch-admin", "以管理员身份重启").build(app)?;
        return file.separator().item(&relaunch).build();
    }
    file.build()
}

fn edit_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let undo = MenuItemBuilder::with_id("undo", "撤销").accelerator("CmdOrCtrl+Z").build(app)?;
    let redo = MenuItemBuilder::with_id("redo", "重做").accelerator("Shift+CmdOrCtrl+Z").build(app)?;
    let find = MenuItemBuilder::with_id("find", "查找").accelerator("CmdOrCtrl+F").build(app)?;
    let replace = MenuItemBuilder::with_id("replace", "替换").accelerator("Alt+CmdOrCtrl+F").build(app)?;
    let comment = MenuItemBuilder::with_id("comment", "切换行注释").accelerator("CmdOrCtrl+/").build(app)?;
    SubmenuBuilder::new(app, "编辑")
        .item(&undo)
        .item(&redo)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&find)
        .item(&replace)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&comment)
        .build()
}

fn view_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let bottom = MenuItemBuilder::with_id("view-bottom", "切换终端面板").accelerator("CmdOrCtrl+`").build(app)?;
    let sidebar = MenuItemBuilder::with_id("view-sidebar", "切换文件树侧栏").build(app)?;
    let ai = MenuItemBuilder::with_id("view-ai", "切换智器对话").build(app)?;
    let designer = MenuItemBuilder::with_id("ui-designer", "UI 设计器(代码 ⇄ 界面)").build(app)?;
    SubmenuBuilder::new(app, "查看")
        .item(&bottom)
        .item(&sidebar)
        .item(&ai)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&designer)
        .build()
}

fn build_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let build_file = MenuItemBuilder::with_id("build-file", "编译当前文件").accelerator("Shift+CmdOrCtrl+B").build(app)?;
    let build_project = MenuItemBuilder::with_id("build-project", "编译整个项目").build(app)?;
    SubmenuBuilder::new(app, "编译")
        .item(&build_file)
        .item(&build_project)
        .build()
}

fn term_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let new_t = MenuItemBuilder::with_id("term-new", "新建终端").accelerator("Shift+CmdOrCtrl+`").build(app)?;
    let clear = MenuItemBuilder::with_id("term-clear", "清空当前终端").build(app)?;
    let close = MenuItemBuilder::with_id("term-close", "关闭当前会话").build(app)?;
    SubmenuBuilder::new(app, "终端")
        .item(&new_t)
        .item(&clear)
        .item(&close)
        .build()
}

fn help_menu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let docs = MenuItemBuilder::with_id("help-docs", "官方文档 (xt.markjy.com)").build(app)?;
    let feedback = MenuItemBuilder::with_id("feedback", "反馈问题").build(app)?;
    SubmenuBuilder::new(app, "帮助")
        .item(&docs)
        .item(&PredefinedMenuItem::separator(app)?)
        .item(&feedback)
        .build()
}

/// 构建完整系统菜单(macOS:第一个子菜单是应用菜单)
pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    menu.append(&app_menu(app)?)?;
    menu.append(&file_menu(app)?)?;
    menu.append(&edit_menu(app)?)?;
    menu.append(&view_menu(app)?)?;
    menu.append(&build_submenu(app)?)?;
    menu.append(&term_menu(app)?)?;
    menu.append(&help_menu(app)?)?;
    Ok(menu)
}

/// 菜单点击分发:把 act id 发给前端,由前端 handleMenuAct 执行
/// (App 菜单的 PredefinedMenuItem 如 关于/退出 由系统处理,不发事件)
pub fn dispatch(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref().to_string();
    if !id.is_empty() && id.starts_with("tauri://") {
        return;
    }
    use tauri::Emitter;
    let _ = app.emit("menu-act", id);
}

/// 前端在最近工程列表变化后调用:整体重建系统菜单(刷新"打开最近工程"子菜单)
#[tauri::command]
pub fn menu_sync_recent(app: AppHandle) {
    #[cfg(target_os = "macos")]
    {
        if let Ok(menu) = build_menu(&app) {
            let _ = app.set_menu(menu);
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}
