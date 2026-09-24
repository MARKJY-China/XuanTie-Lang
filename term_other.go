//go:build !windows

// 非 Windows 平台：无需启用控制台 VT 处理（空实现）。
package main

func enableVirtualTerminalProcessing() {}
