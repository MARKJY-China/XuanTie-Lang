package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"runtime"
	"strings"
	"syscall"
	"xuantie/evaluator"
	"xuantie/lexer"
	"xuantie/object"
	"xuantie/parser"
)

var version = "0.3.6"

const (
	colorReset = "\033[0m"
	colorRed   = "\033[31m"
	colorBold  = "\033[1m"
)

// enableVirtualTerminalProcessing 为 Windows 启用 ANSI 转义序列支持
func enableVirtualTerminalProcessing() {
	if runtime.GOOS != "windows" {
		return
	}

	// Windows 控制台默认不启用 ANSI 处理，需要手动开启 VT100
	const (
		enableVirtualTerminalProcessingMode = 0x0004
	)

	var (
		handle syscall.Handle
		mode   uint32
	)

	// 处理标准输出
	handle = syscall.Handle(os.Stdout.Fd())
	if err := syscall.GetConsoleMode(handle, &mode); err == nil {
		mode |= enableVirtualTerminalProcessingMode
		syscall.Syscall(syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode").Addr(), 2, uintptr(handle), uintptr(mode), 0)
	}

	// 处理标准错误
	handle = syscall.Handle(os.Stderr.Fd())
	if err := syscall.GetConsoleMode(handle, &mode); err == nil {
		mode |= enableVirtualTerminalProcessingMode
		syscall.Syscall(syscall.NewLazyDLL("kernel32.dll").NewProc("SetConsoleMode").Addr(), 2, uintptr(handle), uintptr(mode), 0)
	}
}

func isPowerShell() bool {
	// 无论是否是 PowerShell，只要是 Windows 我们都尝试开启 VT100
	// 这样 CMD、PowerShell、Windows Terminal 都能支持彩色
	return runtime.GOOS == "windows" || os.Getenv("PSModulePath") != ""
}

func main() {
	enableVirtualTerminalProcessing()
	useColor := isPowerShell()

	if len(os.Args) < 2 {
		fmt.Println("用法: xuantie <源文件>")
		fmt.Println("其他选项: -V, --version 打印版本号")
		return
	}

	arg := os.Args[1]
	if arg == "-V" || arg == "--version" {
		fmt.Printf("玄铁(XuanTie) %s\n", version)
		return
	}

	filename := arg
	data, err := ioutil.ReadFile(filename)
	if err != nil {
		if useColor {
			fmt.Printf("%s%s读取文件失败:%s %s找不到文件或无法打开 (%s)%s\n", colorBold, colorRed, colorReset, colorRed, filename, colorReset)
		} else {
			fmt.Printf("读取文件失败: 找不到文件或无法打开 (%s)\n", filename)
		}
		return
	}

	l := lexer.New(string(data))
	p := parser.New(l)
	program := p.ParseProgram()
	program.FilePath = filename // 设置主程序路径

	if len(p.Errors()) > 0 {
		if useColor {
			fmt.Printf("%s%s解析错误:%s\n", colorBold, colorRed, colorReset)
		} else {
			fmt.Println("解析错误:")
		}
		lines := strings.Split(string(data), "\n")
		for _, msg := range p.Errors() {
			if useColor {
				fmt.Printf("\t%s%s%s\n", colorRed, msg, colorReset)
			} else {
				fmt.Printf("\t%s\n", msg)
			}
			// 尝试解析 [行:x, 列:y]
			var line, col int
			n, _ := fmt.Sscanf(msg, "[行:%d, 列:%d]", &line, &col)
			if n == 2 && line > 0 && line <= len(lines) {
				errorLine := strings.ReplaceAll(lines[line-1], "\t", "    ")
				fmt.Printf("\t%s\n", errorLine)
				if useColor {
					fmt.Printf("\t%s%s^%s\n", strings.Repeat(" ", col-1), colorRed, colorReset)
				} else {
					fmt.Printf("\t%s^\n", strings.Repeat(" ", col-1))
				}
			}
		}
		return
	}

	env := make(map[string]object.Object)
	evaluator.RegisterStdLib(env)
	result := evaluator.Eval(program, env)
	if result != nil && result.Type() == object.ERROR_OBJ {
		if useColor {
			fmt.Printf("%s%s运行时错误%s %s%s%s\n", colorBold, colorRed, colorReset, colorRed, result.Inspect(), colorReset)
		} else {
			fmt.Printf("运行时错误 %s\n", result.Inspect())
		}
	}
}
