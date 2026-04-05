package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"xuantie/compiler"
	"xuantie/evaluator"
	"xuantie/lexer"
	"xuantie/object"
	"xuantie/parser"
)

var version = "0.9.0"

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
		fmt.Println("用法: xuantie build <源文件> (编译为独立可执行文件)")
		fmt.Println("其他选项: -V, --version 打印版本号")
		return
	}

	isBuild := false
	filename := os.Args[1]

	if filename == "build" {
		if len(os.Args) < 3 {
			fmt.Println("用法: xuantie build <源文件>")
			return
		}
		isBuild = true
		filename = os.Args[2]
	}

	if filename == "-V" || filename == "--version" {
		fmt.Printf("玄铁(XuanTie) %s\n", version)
		return
	}

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

	if isBuild {
		c := compiler.New(program)
		goCode := c.Compile()

		if len(c.Errors()) > 0 {
			if useColor {
				fmt.Printf("%s%s编译转译错误:%s\n", colorBold, colorRed, colorReset)
			} else {
				fmt.Println("编译转译错误:")
			}
			for _, msg := range c.Errors() {
				if useColor {
					fmt.Printf("\t%s%s%s\n", colorRed, msg, colorReset)
				} else {
					fmt.Printf("\t%s\n", msg)
				}
			}
			return
		}

		// 使用系统临时目录存储中间文件，隐藏 Go 字眼
		tmpDir := os.TempDir()
		tmpFile := filepath.Join(tmpDir, fmt.Sprintf("xt_boot_%d.go", os.Getpid()))
		err := ioutil.WriteFile(tmpFile, []byte(goCode), 0644)
		if err != nil {
			fmt.Printf("创建临时编译文件失败: %v\n", err)
			return
		}
		defer os.Remove(tmpFile)

		outputName := strings.TrimSuffix(filepath.Base(filename), ".xt")
		if runtime.GOOS == "windows" {
			outputName += ".exe"
		}

		fmt.Printf("正在编译 %s -> %s ...\n", filename, outputName)
		// 在当前目录下执行编译，明确指定临时文件
		cmd := exec.Command("go", "build", "-o", outputName, tmpFile)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		err = cmd.Run()
		if err != nil {
			fmt.Printf("编译失败: %v\n", err)
			return
		}
		fmt.Printf("编译完成: %s\n", outputName)
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
