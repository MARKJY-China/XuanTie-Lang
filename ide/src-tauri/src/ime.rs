// 中文输入法模式切换(Windows IMM32)
//
// 目标:编辑器里「字符串内中文 / 代码区英文」自动切换,以及字符串内用英文模式敲冒号时切回中文。
// 实现说明:
//   - WebView2 的输入焦点在宿主进程创建的子窗口(类名 Chrome_WidgetWin_*)上,所以先找它;
//     找不到再退回主窗口 HWND。
//   - 用 ImmGetContext 拿输入上下文;拿不到(第三方输入法/TSF-only)返回 false,前端静默降级,
//     不报错、不影响编辑。
//   - 中文模式:打开 IME + 转换模式 NATIVE;英文模式:关闭 IME + ALPHANUMERIC。
//     (微软拼音两种都吃;第三方输入法多数只认其中一种,能切多少算多少。)

#[cfg(windows)]
fn ime_apply(hwnd: isize, chinese: bool) -> bool {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::Input::Ime::{
        ImmGetContext, ImmReleaseContext, ImmSetConversionStatus, ImmSetOpenStatus,
        IME_CMODE_ALPHANUMERIC, IME_CMODE_NATIVE,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClassNameW, GetWindow, GW_CHILD, GW_HWNDNEXT,
    };

    unsafe fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(h, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..n as usize])
    }

    unsafe fn find_webview_child(h: HWND) -> HWND {
        let mut c = GetWindow(h, GW_CHILD);
        while !c.is_null() {
            if class_of(c).starts_with("Chrome_WidgetWin") {
                return c;
            }
            let deep = find_webview_child(c);
            if !deep.is_null() {
                return deep;
            }
            c = GetWindow(c, GW_HWNDNEXT);
        }
        std::ptr::null_mut()
    }

    unsafe {
        let root = hwnd as *mut std::ffi::c_void as HWND;
        if root.is_null() {
            return false;
        }
        let child = find_webview_child(root);
        let target = if !child.is_null() { child } else { root };
        let himc = ImmGetContext(target);
        if himc.is_null() {
            return false;
        }
        let conv = if chinese {
            IME_CMODE_NATIVE
        } else {
            IME_CMODE_ALPHANUMERIC
        };
        ImmSetOpenStatus(himc, if chinese { 1 } else { 0 });
        ImmSetConversionStatus(himc, conv, 0);
        ImmReleaseContext(target, himc);
        true
    }
}

/// 切换输入法模式:chinese=true 中文,false 英文。返回是否真正生效(第三方输入法可能为 false)。
#[tauri::command]
pub fn ime_set_mode(window: tauri::WebviewWindow, chinese: bool) -> Result<bool, String> {
    #[cfg(windows)]
    {
        let hwnd = window.hwnd().map_err(|e| e.to_string())?;
        Ok(ime_apply(hwnd.0 as isize, chinese))
    }
    #[cfg(not(windows))]
    {
        let _ = (window, chinese);
        Ok(false)
    }
}
