//go:build windows

// Windows 控制台 VT 处理（原生实现）。与 term_other.go 二选一。
package main

import (
	"os"
	"syscall"
)

func enableVirtualTerminalProcessing() {
	const enableVirtualTerminalProcessingMode = 0x0004
	var (
		handle syscall.Handle
		mode   uint32
	)
	handle = syscall.Handle(os.Stdout.Fd())
	if err := syscall.GetConsoleMode(handle, &mode); err == nil {
		mode |= enableVirtualTerminalProcessingMode
		syscall.Syscall(syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode").Addr(), 2, uintptr(handle), uintptr(mode), 0)
	}
	handle = syscall.Handle(os.Stderr.Fd())
	if err := syscall.GetConsoleMode(handle, &mode); err == nil {
		mode |= enableVirtualTerminalProcessingMode
		syscall.Syscall(syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode").Addr(), 2, uintptr(handle), uintptr(mode), 0)
	}
}
