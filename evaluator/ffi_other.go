//go:build !windows

// FFI「外」模块——非 Windows 平台暂不支持 DLL 调用。
// 玄铁 FFI 目前依赖 Windows syscall（LoadDLL/DLL/FindProc），
// 在 macOS / Linux 上构建时使用本存根，运行时返回明确错误。
package evaluator

import (
	"errors"

	"xuantie/object"
)

var errFFIUnsupported = errors.New("FFI(DLL) 暂不支持当前平台（仅 Windows）")

func ffiLoadDLL(libPath string) (uintptr, error) {
	return 0, errFFIUnsupported
}

func ffiCall(handle uintptr, path, procName string, args []object.Object) (int64, error) {
	return 0, errFFIUnsupported
}
