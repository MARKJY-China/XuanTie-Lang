//go:build windows

// FFI「外」模块——Windows DLL 加载与调用（原生实现）。
// 与 ffi_other.go 二选一：本文件只在 Windows 编译。
package evaluator

import (
	"strings"
	"syscall"
	"unsafe"

	"xuantie/object"
)

// ffiLoadDLL 加载 DLL 并返回句柄。
func ffiLoadDLL(libPath string) (uintptr, error) {
	dll, err := syscall.LoadDLL(libPath)
	if err != nil {
		return 0, err
	}
	return uintptr(dll.Handle), nil
}

// ffiCall 调用 DLL 导出函数，返回整数结果。
// 字符串参数按函数名是否以 W 结尾决定 UTF-16 / 本地字节编码。
func ffiCall(handle uintptr, path, procName string, args []object.Object) (int64, error) {
	dll := &syscall.DLL{Name: path, Handle: syscall.Handle(handle)}
	proc, err := dll.FindProc(procName)
	if err != nil {
		return 0, err
	}

	uArgs := make([]uintptr, len(args))
	for i, a := range args {
		switch v := a.(type) {
		case *object.Integer:
			uArgs[i] = uintptr(v.Value)
		case *object.String:
			if strings.HasSuffix(procName, "W") {
				p, _ := syscall.UTF16PtrFromString(v.Value)
				uArgs[i] = uintptr(unsafe.Pointer(p))
			} else {
				p, _ := syscall.BytePtrFromString(v.Value)
				uArgs[i] = uintptr(unsafe.Pointer(p))
			}
		default:
			uArgs[i] = 0
		}
	}

	r1, _, _ := proc.Call(uArgs...)
	return int64(r1), nil
}
