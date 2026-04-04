package main

import (
	"fmt"
	"io/ioutil"
	"os"
	"strings"
	"xuantie/evaluator"
	"xuantie/lexer"
	"xuantie/object"
	"xuantie/parser"
)

var version = "0.3.3"

func main() {
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
		fmt.Printf("读取文件失败: %s\n", err)
		return
	}

	l := lexer.New(string(data))
	p := parser.New(l)
	program := p.ParseProgram()
	if len(p.Errors()) > 0 {
		fmt.Println("解析错误:")
		lines := strings.Split(string(data), "\n")
		for _, msg := range p.Errors() {
			fmt.Printf("\t%s\n", msg)
			// 尝试解析 [行:x, 列:y]
			var line, col int
			n, _ := fmt.Sscanf(msg, "[行:%d, 列:%d]", &line, &col)
			if n == 2 && line > 0 && line <= len(lines) {
				errorLine := strings.ReplaceAll(lines[line-1], "\t", "    ")
				fmt.Printf("\t%s\n", errorLine)
				fmt.Printf("\t%s^\n", strings.Repeat(" ", col-1))
			}
		}
		return
	}

	env := make(map[string]object.Object)
	evaluator.RegisterStdLib(env)
	result := evaluator.Eval(program, env)
	if result != nil && result.Type() == object.ERROR_OBJ {
		fmt.Printf("运行时错误 %s\n", result.Inspect())
	}
}
