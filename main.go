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

var version = "0.15.7"

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

func printHelp() {
	fmt.Println("用法:")
	fmt.Println("  xuantie <源文件>          解释执行脚本")
	fmt.Println("  xuantie zao <源文件>      编译为独立可执行文件 (或用 build/造)")
	fmt.Println("  xuantie tie <源文件>      使用 LLVM 编译为原生二进制文件 (里程碑特性)")
	fmt.Println("")
	fmt.Println("选项:")
	fmt.Println("  --pt <os>      目标操作系统 (windows, linux, darwin)")
	fmt.Println("  --jg <arch>    目标指令集架构 (amd64, arm64, 386)")
	fmt.Println("  -V, --version  打印版本号")
	fmt.Println("  -h, --help, -? 打印此帮助信息")
}

func main() {
	enableVirtualTerminalProcessing()
	useColor := isPowerShell()

	if len(os.Args) < 2 {
		printHelp()
		return
	}

	isBuild := false
	isNative := false
	filename := ""
	targetOS := ""
	targetArch := ""

	// 解析命令行参数
	for i := 1; i < len(os.Args); i++ {
		arg := os.Args[i]
		switch arg {
		case "build", "zao", "造":
			isBuild = true
		case "tie", "铁":
			isNative = true
		case "--平台", "--pt":
			if i+1 < len(os.Args) {
				targetOS = os.Args[i+1]
				i++
			}
		case "--架构", "--jg":
			if i+1 < len(os.Args) {
				targetArch = os.Args[i+1]
				i++
			}
		case "-V", "--version":
			fmt.Printf("玄铁(XuanTie) %s\n", version)
			return
		case "-h", "--help", "-?":
			printHelp()
			return
		default:
			if filename == "" {
				filename = arg
			}
		}
	}

	if filename == "" {
		fmt.Println("未指定源文件")
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
				fmt.Fprintf(os.Stderr, "\t%s%s%s\n", colorRed, msg, colorReset)
			} else {
				fmt.Fprintf(os.Stderr, "\t%s\n", msg)
			}
			// 尝试解析 [行:x, 列:y]
			var line, col int
			n, _ := fmt.Sscanf(msg, "[行:%d, 列:%d]", &line, &col)
			if n == 2 && line > 0 && line <= len(lines) {
				errorLine := strings.ReplaceAll(lines[line-1], "\t", "    ")
				fmt.Fprintf(os.Stderr, "\t%s\n", errorLine)
				if useColor {
					fmt.Fprintf(os.Stderr, "\t%s%s^%s\n", strings.Repeat(" ", col-1), colorRed, colorReset)
				} else {
					fmt.Fprintf(os.Stderr, "\t%s^\n", strings.Repeat(" ", col-1))
				}
			}
		}
		return
	}

	if isNative {
		fmt.Printf("正在使用 LLVM 编译 %s -> 原生二进制文件 (平台: %s, 架构: %s) ...\n", filename, runtime.GOOS, runtime.GOARCH)
		c := compiler.NewLLVMCompiler(program)
		llvmIR := c.Compile()

		// 1. 写入 LLVM IR 到本地文件以供调试
		irFile := strings.TrimSuffix(filename, ".xt") + ".ll"
		err := ioutil.WriteFile(irFile, []byte(llvmIR), 0644)
		if err != nil {
			fmt.Printf("创建 LLVM IR 文件失败: %v\n", err)
			return
		}
		// defer os.Remove(irFile) // 暂时保留以供调试

		// 2. 编译 C 运行时
		// 我们假设运行时源代码在执行路径下的 runtime 目录
		exePath, _ := os.Executable()
		runtimeDir := filepath.Join(filepath.Dir(exePath), "runtime")
		// 如果是 go run 运行，则在当前目录找
		if strings.Contains(exePath, "go-build") {
			runtimeDir = "runtime"
		}

		rtC := filepath.Join(runtimeDir, "xt_runtime.c")

		// 1. 使用 clang 将 LLVM IR 编译为 MinGW 格式的对象文件
		objFile := strings.TrimSuffix(filename, ".xt") + ".o"
		clangCmd := exec.Command("clang", "-target", "x86_64-w64-windows-gnu", "-c", irFile, "-o", objFile)
		if out, err := clangCmd.CombinedOutput(); err != nil {
			fmt.Printf("LLVM 编译为对象文件失败: %v\n", err)
			fmt.Printf("错误详情: %s\n", string(out))
			return
		}

		// 2. 使用 gcc (MinGW) 进行最终链接
		outputName := strings.TrimSuffix(filepath.Base(filename), ".xt")
		if runtime.GOOS == "windows" {
			outputName += ".exe"
		}
		gccCmd := exec.Command("gcc", objFile, rtC, "-o", outputName)
		out, err := gccCmd.CombinedOutput()
		fmt.Printf("生成的 LLVM IR 已保存至: %s\n", irFile)

		// 编译失败时输出详细信息
		if err != nil {
			fmt.Printf("MinGW 链接失败 (请确保已安装 GCC/MinGW): %v\n", err)
			fmt.Printf("错误详情: %s\n", string(out))
			return
		}

		// 清理中间对象文件
		os.Remove(objFile)

		fmt.Printf("原生编译完成: %s\n", outputName)
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
		actualOS := runtime.GOOS
		if targetOS != "" {
			actualOS = targetOS
		}
		if actualOS == "windows" {
			outputName += ".exe"
		}

		fmt.Printf("正在编译 %s -> %s (平台: %s, 架构: %s) ...\n", filename, outputName, actualOS, targetArch)
		// 在当前目录下执行编译，明确指定临时文件
		cmd := exec.Command("go", "build", "-a", "-o", outputName, tmpFile)
		cmd.Env = os.Environ()
		if targetOS != "" {
			cmd.Env = append(cmd.Env, "GOOS="+targetOS)
		}
		if targetArch != "" {
			cmd.Env = append(cmd.Env, "GOARCH="+targetArch)
		}
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

	// 设置环境变量，支持相对路径引用
	absPath, _ := filepath.Abs(filename)
	env["__FILE__"] = &object.String{Value: absPath}
	env["__DIR__"] = &object.String{Value: filepath.Dir(absPath)}

	result := evaluator.Eval(program, env)
	if result != nil && result.Type() == object.ERROR_OBJ {
		if useColor {
			fmt.Fprintf(os.Stderr, "%s%s运行时错误:%s %s\n", colorBold, colorRed, colorReset, result.Inspect())
		} else {
			fmt.Fprintf(os.Stderr, "运行时错误: %s\n", result.Inspect())
		}
	}
}
