// LLVMCompiler 编译器
// 由TraeAI负责大部分代码编写。所有代码都已经过作者审核并经过ClaudeOpus4.7深度扫描分析。

package compiler

import (
	"bytes"
	"fmt"
	"io/ioutil"
	"path/filepath"
	"reflect"
	"strings"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/parser"
)

type SymbolInfo struct {
	AddrReg   string
	Type      string // i64, %XTString*, i1, double, i8*
	ClassName string // 如果是实例，记录类名
	IsGlobal  bool
}
type ClassInfo struct {
	Name            string
	Fields          []string
	Methods         map[string]string // 映射方法名到 LLVM 函数名
	MethodArgsCount map[string]int    // 映射方法名到参数个数（不含 this）
	Parent          string
}

type LLVMCompiler struct {
	program         *ast.Program
	output          bytes.Buffer
	allocaOutput    bytes.Buffer // 存储当前函数的所有 alloca
	funcOutput      bytes.Buffer
	globalOutput    bytes.Buffer // 存储全局变量定义的 IR
	regCount        int
	labelCount      int
	symbolTable     map[string]SymbolInfo
	strings         map[string]string
	classes         map[string]*ClassInfo
	scopeStack      [][]string // 每层作用域需要 release 的寄存器列表
	currentFunc     string     // 为空表示在 main 中
	currentClass    string     // 当前正在转译的类名
	currentLabel    string     // 最近一个基本块标签
	filePath        string     // 当前正在转译的文件路径
	breakLabels     []string   // break 目标标签栈
	continueLabels  []string   // continue 目标标签栈
	loopDepths      []int      // 循环开始时的 scopeStack 深度栈
	visitedImports  map[string]bool
	declaredGlobals map[string]bool
}

func NewLLVMCompiler(program *ast.Program) *LLVMCompiler {
	c := &LLVMCompiler{
		program:         program,
		symbolTable:     make(map[string]SymbolInfo),
		strings:         make(map[string]string),
		classes:         make(map[string]*ClassInfo),
		filePath:        program.FilePath,
		visitedImports:  make(map[string]bool),
		declaredGlobals: make(map[string]bool),
	}

	// 注入内置全局符号
	c.symbolTable["文件.读"] = SymbolInfo{AddrReg: "@\"xt_file_read\"", IsGlobal: true}
	c.declaredGlobals["文件.读"] = true
	c.symbolTable["文件.写"] = SymbolInfo{AddrReg: "@\"xt_file_write\"", IsGlobal: true}
	c.declaredGlobals["文件.写"] = true
	c.symbolTable["文件.存在?"] = SymbolInfo{AddrReg: "@\"xt_file_exists\"", IsGlobal: true}
	c.declaredGlobals["文件.存在?"] = true
	c.symbolTable["数学.随机"] = SymbolInfo{AddrReg: "@\"xt_math_random\"", IsGlobal: true}
	c.declaredGlobals["数学.随机"] = true
	c.symbolTable["时.现"] = SymbolInfo{AddrReg: "@\"xt_time_now\"", IsGlobal: true}
	c.declaredGlobals["时.现"] = true
	c.symbolTable["时.毫秒"] = SymbolInfo{AddrReg: "@\"xt_time_ms\"", IsGlobal: true}
	c.declaredGlobals["时.毫秒"] = true
	c.symbolTable["时.微秒"] = SymbolInfo{AddrReg: "@\"xt_time_micro\"", IsGlobal: true}
	c.declaredGlobals["时.微秒"] = true
	c.symbolTable["时.睡"] = SymbolInfo{AddrReg: "@\"xt_time_sleep\"", IsGlobal: true}
	c.declaredGlobals["时.睡"] = true
	c.symbolTable["执"] = SymbolInfo{AddrReg: "@\"xt_execute\"", IsGlobal: true}
	c.declaredGlobals["执"] = true
	c.symbolTable["化"] = SymbolInfo{AddrReg: "@\"xt_json_serialize\"", IsGlobal: true}
	c.declaredGlobals["化"] = true
	c.symbolTable["解"] = SymbolInfo{AddrReg: "@\"xt_json_deserialize\"", IsGlobal: true}
	c.declaredGlobals["解"] = true
	c.symbolTable["求"] = SymbolInfo{AddrReg: "@\"xt_http_request\"", IsGlobal: true}
	c.declaredGlobals["求"] = true
	c.symbolTable["输"] = SymbolInfo{AddrReg: "@\"xt_input\"", IsGlobal: true}
	c.declaredGlobals["输"] = true
	c.symbolTable["听"] = SymbolInfo{AddrReg: "@\"xt_listen\"", IsGlobal: true}
	c.declaredGlobals["听"] = true
	c.symbolTable["连"] = SymbolInfo{AddrReg: "@\"xt_connect\"", IsGlobal: true}
	c.declaredGlobals["连"] = true
	c.symbolTable["等待"] = SymbolInfo{AddrReg: "@\"xt_wait\"", IsGlobal: true}
	c.declaredGlobals["等待"] = true

	return c
}

func (c *LLVMCompiler) Compile() string {
	var body bytes.Buffer
	oldOutput := c.output
	c.output = body

	// 进入全局作用域
	c.enterScope()

	// 转译主体语句
	for _, stmt := range c.program.Statements {
		c.compileStatement(stmt)
	}

	// 退出全局作用域
	c.exitScope(false)

	mainBody := c.output.String()
	mainAllocas := c.allocaOutput.String()
	c.output = oldOutput
	c.allocaOutput = bytes.Buffer{}

	// 1. 写入模块头
	c.emit("; XuanTie v0.15.5 LLVM Backend")
	c.emit("target datalayout = \"e-m:e-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128\"")
	c.emit("target triple = \"x86_64-w64-windows-gnu\"")
	c.emit("")

	// 2. 写入全局字符串常量
	for content, alias := range c.strings {
		escaped := ""
		for i := 0; i < len(content); i++ {
			b := content[i]
			if b >= 32 && b <= 126 && b != '\\' && b != '"' {
				escaped += string(b)
			} else {
				escaped += fmt.Sprintf("\\%02X", b)
			}
		}
		c.emit("@%s = private unnamed_addr constant [%d x i8] c\"%s\\00\", align 1", alias, len(content)+1, escaped)
	}
	c.emit("")

	// 3. 外部运行时函数声明
	c.emit("%%XTObject = type { i32, i32 }")
	c.emit("%%XTString = type { i32, i32, i8*, i64, i32 }")
	c.emit("%%XTArray = type { i32, i32, i8**, i64, i64 }")
	c.emit("%%XTDict = type { i32, i32, i8***, i64, i64 }")
	c.emit("%%XTFunction = type { i32, i32, i8* }")
	c.emit("%%XTInstance = type { i32, i32, i8*, i64*, i64 }")
	c.emit("%%XTResult = type { i32, i32, i32, i32, i64, i64 }")
	c.emit("declare %%XTArray* @xt_dict_keys(%%XTDict*)")
	c.emit("declare void @xt_init()")
	c.emit("declare void @xt_print_int(i64)")
	c.emit("declare void @xt_print_string(%%XTString*)")
	c.emit("declare void @xt_print_bool(i1)")
	c.emit("declare void @xt_print_float(double)")
	c.emit("declare void @xt_print_value(i64)")
	c.emit("declare i64 @xt_convert_to_int(i64)")
	c.emit("declare i64 @xt_convert_to_float(i64)")
	c.emit("declare i64 @xt_convert_to_string(i64)")
	c.emit("declare i64 @xt_int_new(i64)")
	c.emit("declare i8* @xt_float_new(double)")
	c.emit("declare i64 @xt_bool_new(i1)")
	c.emit("declare i64 @xt_func_new(i8*)")
	c.emit("declare %%XTString* @xt_string_new(i8*)")
	c.emit("declare i64 @xt_string_get_char(i64, i64)")
	c.emit("declare i64 @xt_string_get_byte(i64, i64)")
	c.emit("declare i64 @xt_string_byte_length(i64)")
	c.emit("declare i64 @xt_string_char_count(i64)")
	c.emit("declare i64 @xt_string_to_hex_string(i64)")
	c.emit("declare %%XTString* @xt_string_from_char(i8)")
	c.emit("declare %%XTString* @xt_string_next_char(%%XTString*, i64*)")
	c.emit("declare i64 @xt_array_new(i64)")
	c.emit("declare void @xt_array_append(i64, i64)")
	c.emit("declare i64 @xt_array_pop(%%XTArray*)")
	c.emit("declare i64 @xt_array_slice(i64, i64)")
	c.emit("declare i64 @xt_array_range(i64, i64)")
	c.emit("declare i64 @xt_array_get(i64, i64)")
	c.emit("declare %%XTString* @xt_array_join(i64, %%XTString*)")
	c.emit("declare i64 @xt_dict_new(i64)")
	c.emit("declare void @xt_dict_set(i64, i64, i64)")
	c.emit("declare i64 @xt_dict_get(i64, i64)")
	c.emit("declare i32 @xt_dict_contains(i64, i64)")
	c.emit("declare i8* @xt_result_new(i32, i8*, i8*)")
	c.emit("declare i32 @__mingw_printf(i8*, ...)")
	c.emit("declare %%XTString* @xt_string_concat(%%XTString*, %%XTString*)")
	c.emit("declare %%XTString* @xt_string_substring(%%XTString*, i64, i64)")
	c.emit("declare i32 @xt_string_contains(%%XTString*, %%XTString*)")
	c.emit("declare i64 @xt_string_replace(i64, i64, i64)")
	c.emit("declare i64 @xt_string_split(i64, i64)")
	c.emit("declare %%XTString* @xt_int_to_string(i64)")
	c.emit("declare %%XTString* @xt_obj_to_string(i64)")
	c.emit("declare void @xt_retain(i64)")
	c.emit("declare void @xt_release(i64)")
	c.emit("declare i64 @xt_to_int(i64)")
	c.emit("declare i32 @xt_compare(i64, i64)")
	c.emit("declare void @exit(i32)")
	c.emit("declare i64 @xt_file_read(i64)")
	c.emit("declare i64 @xt_file_write(i64, i64)")
	c.emit("declare i64 @xt_file_exists(i64)")
	c.emit("declare i64 @xt_http_request(i64)")
	c.emit("declare i64 @xt_math_random(i64)")
	c.emit("declare i64 @xt_time_now()")
	c.emit("declare i64 @xt_time_ms()")
	c.emit("declare i64 @xt_time_sleep(i64)")
	c.emit("declare i64 @xt_listen(i64, i64)")
	c.emit("declare i64 @xt_connect(i64)")
	c.emit("declare i64 @xt_execute(i64)")
	c.emit("declare i64 @xt_input(i64)")
	c.emit("declare %%XTString* @xt_json_serialize(i64)")
	c.emit("declare i64 @xt_json_deserialize(%%XTString*)")
	c.emit("declare i64 @xt_wait(i64)")
	c.emit("")
	c.emit("")

	// 4. 写入全局变量定义
	c.output.Write(c.globalOutput.Bytes())
	c.emit("")

	// 5. 写入自定义函数定义
	c.output.Write(c.funcOutput.Bytes())
	c.emit("")

	// 6. 主函数入口
	c.emit("declare void @\"xt_init_args\"(i32, i8**)")
	c.emit("")
	c.emit("define i32 @main(i32 %%argc, i8** %%argv) {")
	c.emit("entry:")
	c.currentLabel = "entry"
	c.emit("  call void @xt_init()")
	c.emit("  call void @xt_init_args(i32 %%argc, i8** %%argv)")
	c.output.WriteString(mainAllocas)
	c.output.WriteString(mainBody)
	c.emit("  ret i32 0")
	c.emit("}")

	return c.output.String()
}

func (c *LLVMCompiler) emit(format string, args ...interface{}) {
	line := fmt.Sprintf(format, args...)
	trimmed := strings.TrimSpace(line)
	if strings.HasSuffix(trimmed, ":") {
		c.currentLabel = trimmed[:len(trimmed)-1]
	}
	c.output.WriteString(line + "\n")
}

func (c *LLVMCompiler) emitAlloca(format string, args ...interface{}) {
	line := fmt.Sprintf(format, args...)
	c.allocaOutput.WriteString("  " + line + "\n")
	// Also init with 0 for GC
	if len(args) > 0 {
		if reg, ok := args[0].(string); ok {
			c.allocaOutput.WriteString(fmt.Sprintf("  store i64 0, i64* %s\n", reg))
		}
	}
}

func (c *LLVMCompiler) isScalarType(typ string) bool {
	return typ == "raw_i64" || typ == "i1" || typ == "double"
}

func (c *LLVMCompiler) nextReg() string {
	c.regCount++
	return fmt.Sprintf("%%t%d", c.regCount)
}

func (c *LLVMCompiler) nextLabel(prefix string) string {
	c.labelCount++
	return fmt.Sprintf("%s.%d", prefix, c.labelCount)
}

func (c *LLVMCompiler) addString(content string) string {
	if alias, ok := c.strings[content]; ok {
		return alias
	}
	alias := fmt.Sprintf("str.%d", len(c.strings))
	c.strings[content] = alias
	return alias
}

func (c *LLVMCompiler) enterScope() {
	c.scopeStack = append(c.scopeStack, []string{})
}

func (c *LLVMCompiler) trackObject(addrReg string) {
	if len(c.scopeStack) > 0 {
		top := len(c.scopeStack) - 1
		c.scopeStack[top] = append(c.scopeStack[top], addrReg)
	}
}

func (c *LLVMCompiler) exitScope(isReturn bool) {
	if len(c.scopeStack) == 0 {
		return
	}

	// 如果是 return，需要退出所有作用域
	start := len(c.scopeStack) - 1
	end := start
	if isReturn {
		end = 0
	}

	for i := start; i >= end; i-- {
		for _, addrReg := range c.scopeStack[i] {
			valReg := c.nextReg()
			c.emit("  %s = load i64, i64* %s", valReg, addrReg)
			c.emit("  call void @xt_release(i64 %s)", valReg)
		}
	}

	if !isReturn {
		c.scopeStack = c.scopeStack[:start]
	}
}

func (c *LLVMCompiler) exitScopesUntil(depth int) {
	if len(c.scopeStack) == 0 {
		return
	}
	for i := len(c.scopeStack) - 1; i >= depth; i-- {
		for _, addrReg := range c.scopeStack[i] {
			valReg := c.nextReg()
			c.emit("  %s = load i64, i64* %s", valReg, addrReg)
			c.emit("  call void @xt_release(i64 %s)", valReg)
		}
	}
}

func (c *LLVMCompiler) convertToObj(valReg, valType string) (string, string) {
	if valType == "raw_i64" {
		xtVal := c.ensureI64(valReg, valType)
		reg := c.nextReg()
		c.emit("  %s = inttoptr i64 %s to i8*", reg, xtVal)
		return reg, "i8*"
	}
	if strings.HasSuffix(valType, "*") || valType == "ptr" || valType == "i8*" {
		if valType != "i8*" {
			reg := c.nextReg()
			c.emit("  %s = bitcast %s %s to i8*", reg, valType, valReg)
			return reg, "i8*"
		}
		return valReg, "i8*"
	}
	if valType == "i1" {
		reg := c.nextReg()
		c.emit("  %s = select i1 %s, i64 4, i64 2", reg, valReg)
		resReg := c.nextReg()
		c.emit("  %s = inttoptr i64 %s to i8*", resReg, reg)
		return resReg, "i8*"
	}
	if valType == "函数名" {
		reg := c.nextReg()
		c.emit("  %s = bitcast i64 (...)* @\"%s\" to i8*", reg, valReg)
		return reg, "i8*"
	}
	if valType == "double" {
		reg := c.nextReg()
		c.emit("  %s = call i8* @xt_float_new(double %s)", reg, valReg)
		return reg, "i8*"
	}
	reg := c.nextReg()
	c.emit("  %s = inttoptr i64 %s to i8*", reg, valReg)
	return reg, "i8*"
}

func (c *LLVMCompiler) ensureI64(reg, typ string) string {
	if typ == "i64" {
		return reg
	}
	if typ == "raw_i64" {
		shifted := c.nextReg()
		c.emit("  %s = shl i64 %s, 1", shifted, reg)
		newReg := c.nextReg()
		c.emit("  %s = or i64 %s, 1", newReg, shifted)
		return newReg
	}
	if typ == "i1" {
		newReg := c.nextReg()
		c.emit("  %s = select i1 %s, i64 4, i64 2", newReg, reg)
		return newReg
	}
	if typ == "函数名" {
		newReg := c.nextReg()
		c.emit("  %s = ptrtoint i64 (...)* @\"%s\" to i64", newReg, reg)
		return newReg
	}
	if typ == "double" {
		newReg := c.nextReg()
		c.emit("  %s = call i8* @xt_float_new(double %s)", newReg, reg)
		ptrI64 := c.nextReg()
		c.emit("  %s = ptrtoint i8* %s to i64", ptrI64, newReg)
		return ptrI64
	}
	if strings.HasSuffix(typ, "*") || typ == "i8*" || typ == "ptr" {
		newReg := c.nextReg()
		if typ != "i8*" {
			i8Ptr := c.nextReg()
			c.emit("  %s = bitcast %s %s to i8*", i8Ptr, typ, reg)
			c.emit("  %s = ptrtoint i8* %s to i64", newReg, i8Ptr)
		} else {
			c.emit("  %s = ptrtoint %s %s to i64", newReg, typ, reg)
		}
		return newReg
	}
	if strings.HasPrefix(typ, "型:") {
		return reg
	}
	return reg
}

func (c *LLVMCompiler) ensureRawI64(reg, typ string) string {
	if typ == "raw_i64" {
		return reg
	}
	if typ == "i64" {
		newReg := c.nextReg()
		c.emit("  %s = ashr i64 %s, 1", newReg, reg)
		return newReg
	}
	xtVal := c.ensureI64(reg, typ)
	newReg := c.nextReg()
	c.emit("  %s = ashr i64 %s, 1", newReg, xtVal)
	return newReg
}

func (c *LLVMCompiler) compileStatement(stmt ast.Statement) {
	if stmt == nil || reflect.ValueOf(stmt).IsNil() {
		return
	}
	switch s := stmt.(type) {
	case *ast.PrintStatement:
		valReg, valType, _ := c.compileExpression(s.Value)
		xtValReg := c.ensureI64(valReg, valType)
		c.emit("  call void @xt_print_value(i64 %s)", xtValReg)
		c.emit("  call void @xt_release(i64 %s)", xtValReg)
	case *ast.VarStatement:
		valReg, valType, valClass := c.compileExpression(s.Value)
		// 只有局部变量且初始值为标量时，才尝试优化
		isScalar := c.isScalarType(valType) && (c.currentFunc != "" || c.currentClass != "")

		var xtVal string
		if isScalar {
			xtVal = valReg
		} else {
			xtVal = c.ensureI64(valReg, valType)
		}

		if c.currentFunc == "" && c.currentClass == "" {
			addrReg := "@\"" + s.Name.Value + "\""
			if !c.declaredGlobals[s.Name.Value] {
				c.globalOutput.WriteString(fmt.Sprintf("%s = global i64 0\n", addrReg))
				c.declaredGlobals[s.Name.Value] = true
			}
			c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64", ClassName: valClass, IsGlobal: true}
		} else {
			if sym, ok := c.symbolTable[s.Name.Value]; ok && !sym.IsGlobal {
				// 如果已经存在且是标量类型，则不需要 release
				if !c.isScalarType(sym.Type) {
					oldVal := c.nextReg()
					c.emit("  %s = load i64, i64* %s", oldVal, sym.AddrReg)
					c.emit("  call void @xt_release(i64 %s)", oldVal)
				}
				// 变量类型跟随赋值走
				actualVal := xtVal
				newType := "i64"
				if isScalar {
					newType = valType
				}
				c.emit("  store i64 %s, i64* %s", actualVal, sym.AddrReg)
				sym.Type = newType
				sym.ClassName = valClass
				c.symbolTable[s.Name.Value] = sym
			} else {
				addrReg := "%\"" + s.Name.Value + "\""
				c.emitAlloca("%s = alloca i64", addrReg)
				c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
				newType := "i64"
				if isScalar {
					newType = valType
				} else {
					c.trackObject(addrReg)
				}
				c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: newType, ClassName: valClass, IsGlobal: false}
			}
		}
	case *ast.AssignStatement:
		valReg, valType, className := c.compileExpression(s.Value)

		if sym, ok := c.symbolTable[s.Name]; ok {
			// 只有局部变量且新值为标量时，才尝试优化
			isScalar := c.isScalarType(valType) && (c.currentFunc != "" || c.currentClass != "") && !sym.IsGlobal

			var xtVal string
			if isScalar {
				xtVal = valReg
			} else {
				xtVal = c.ensureI64(valReg, valType)
			}

			// 如果旧变量不是标量类型，需要 release
			if !c.isScalarType(sym.Type) {
				oldVal := c.nextReg()
				c.emit("  %s = load i64, i64* %s", oldVal, sym.AddrReg)
				c.emit("  call void @xt_release(i64 %s)", oldVal)
			}

			c.emit("  store i64 %s, i64* %s", xtVal, sym.AddrReg)
			sym.Type = "i64"
			if isScalar {
				sym.Type = valType
			}
			sym.ClassName = className
			c.symbolTable[s.Name] = sym
		} else {
			xtVal := c.ensureI64(valReg, valType)
			addrReg := "@\"" + s.Name + "\""
			if !c.declaredGlobals[s.Name] {
				c.globalOutput.WriteString(fmt.Sprintf("%s = global i64 0\n", addrReg))
				c.declaredGlobals[s.Name] = true
			}
			c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
		}
	case *ast.ComplexAssignStatement:
		c.compileComplexAssignStatement(s)
	case *ast.IfStatement:
		c.compileIfStatement(s)
	case *ast.WhileStatement:
		c.compileWhileStatement(s)
	case *ast.LoopStatement:
		c.compileLoopStatement(s)
	case *ast.ForStatement:
		c.compileForStatement(s)
	case *ast.FunctionStatement:
		c.compileFunctionStatement(s)
	case *ast.TypeDefinitionStatement:
		c.compileTypeDefinitionStatement(s)
	case *ast.InterfaceStatement:
		// 接口在 LLVM 后端仅作为元数据，不生成代码
		return
	case *ast.ExternalFunctionStatement:
		c.compileExternalFunctionStatement(s)
	case *ast.ReturnStatement:
		valReg, valType, _ := c.compileExpression(s.ReturnValue)
		retVal := valReg
		if valType == "i1" {
			reg := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, valReg)
			retVal = reg
		} else if valType == "raw_i64" {
			retVal = c.ensureI64(valReg, valType)
		} else if strings.HasSuffix(valType, "*") || valType == "i8*" || valType == "ptr" {
			reg := c.nextReg()
			c.emit("  %s = ptrtoint %s %s to i64", reg, valType, valReg)
			retVal = reg
		}
		c.emit("  call void @xt_retain(i64 %s)", retVal)
		c.exitScope(true)
		c.emit("  ret i64 %s", retVal)
		deadLabel := c.nextLabel("deadcode")
		c.emit("%s:", deadLabel)
	case *ast.MatchStatement:
		c.compileMatchStatement(s)
	case *ast.TerminateStatement:
		c.compileTerminateStatement(s)
	case *ast.ExpressionStatement:
		valReg, valType, _ := c.compileExpression(s.Expression)
		if valType != "raw_i64" {
			xtVal := c.ensureI64(valReg, valType)
			c.emit("  call void @xt_release(i64 %s)", xtVal)
		}
	case *ast.BreakStatement:
		if len(c.breakLabels) > 0 {
			target := c.breakLabels[len(c.breakLabels)-1]
			depth := c.loopDepths[len(c.loopDepths)-1]
			c.exitScopesUntil(depth)
			c.emit("  br label %%%s", target)
			deadLabel := c.nextLabel("deadcode")
			c.emit("%s:", deadLabel)
		}
	case *ast.ContinueStatement:
		if len(c.continueLabels) > 0 {
			target := c.continueLabels[len(c.continueLabels)-1]
			depth := c.loopDepths[len(c.loopDepths)-1]
			c.exitScopesUntil(depth)
			c.emit("  br label %%%s", target)
			deadLabel := c.nextLabel("deadcode")
			c.emit("%s:", deadLabel)
		}
	}
}

func (c *LLVMCompiler) compileTerminateStatement(s *ast.TerminateStatement) {
	if s.StatusCode != nil {
		reg, typ, _ := c.compileExpression(s.StatusCode)
		raw := c.ensureRawI64(reg, typ)
		i32Reg := c.nextReg()
		c.emit("  %s = trunc i64 %s to i32", i32Reg, raw)
		c.emit("  call void @exit(i32 %s)", i32Reg)
	} else {
		c.emit("  call void @exit(i32 0)")
	}
	c.emit("  unreachable")
	deadLabel := c.nextLabel("deadcode")
	c.emit("%s:", deadLabel)
}

func (c *LLVMCompiler) compileIfStatement(s *ast.IfStatement) {
	condReg, condType, _ := c.compileExpression(s.Condition)
	condI1 := condReg
	if condType == "i64" {
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condReg)
		c.emit("  call void @xt_release(i64 %s)", condReg)
	} else if condType != "raw_i64" && condType != "i1" {
		condI64 := c.ensureI64(condReg, condType)
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condI64)
		c.emit("  call void @xt_release(i64 %s)", condI64)
	} else if condType == "raw_i64" {
		condI1 = c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", condI1, condReg)
	}
	thenLabel := c.nextLabel("if.then")
	mergeLabel := c.nextLabel("if.merge")
	var nextLabel string
	if len(s.ElseIfs) > 0 {
		nextLabel = c.nextLabel("if.elseif")
	} else if len(s.ElseBlock) > 0 {
		nextLabel = c.nextLabel("if.else")
	} else {
		nextLabel = mergeLabel
	}
	c.emit("  br i1 %s, label %%%s, label %%%s", condI1, thenLabel, nextLabel)
	c.emit("%s:", thenLabel)
	c.enterScope()
	for _, stmt := range s.ThenBlock {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", mergeLabel)
	for i, eif := range s.ElseIfs {
		c.emit("%s:", nextLabel)
		eifCondReg, eifCondType, _ := c.compileExpression(eif.Condition)
		if eifCondType == "i64" {
			reg := c.nextReg()
			c.emit("  %s = icmp eq i64 %s, 4", reg, eifCondReg)
			c.emit("  call void @xt_release(i64 %s)", eifCondReg)
			eifCondReg = reg
		} else if eifCondType != "raw_i64" && eifCondType != "i1" {
			condI64 := c.ensureI64(eifCondReg, eifCondType)
			reg := c.nextReg()
			c.emit("  %s = icmp eq i64 %s, 4", reg, condI64)
			c.emit("  call void @xt_release(i64 %s)", condI64)
			eifCondReg = reg
		} else if eifCondType == "raw_i64" {
			reg := c.nextReg()
			c.emit("  %s = icmp ne i64 %s, 0", reg, eifCondReg)
			eifCondReg = reg
		}
		eifThenLabel := c.nextLabel("if.elseif_then")
		if i < len(s.ElseIfs)-1 {
			nextLabel = c.nextLabel("if.elseif")
		} else if len(s.ElseBlock) > 0 {
			nextLabel = c.nextLabel("if.else")
		} else {
			nextLabel = mergeLabel
		}
		c.emit("  br i1 %s, label %%%s, label %%%s", eifCondReg, eifThenLabel, nextLabel)
		c.emit("%s:", eifThenLabel)
		c.enterScope()
		for _, stmt := range eif.Block {
			c.compileStatement(stmt)
		}
		c.exitScope(false)
		c.emit("  br label %%%s", mergeLabel)
	}
	if len(s.ElseBlock) > 0 {
		c.emit("%s:", nextLabel)
		c.enterScope()
		for _, stmt := range s.ElseBlock {
			c.compileStatement(stmt)
		}
		c.exitScope(false)
		c.emit("  br label %%%s", mergeLabel)
	}
	c.emit("%s:", mergeLabel)
}

func (c *LLVMCompiler) compileWhileStatement(s *ast.WhileStatement) {
	condLabel := c.nextLabel("while.cond")
	bodyLabel := c.nextLabel("while.body")
	endLabel := c.nextLabel("while.end")
	c.emit("  br label %%%s", condLabel)
	c.emit("%s:", condLabel)
	condReg, condType, _ := c.compileExpression(s.Condition)
	condI1 := condReg
	if condType == "i64" {
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condReg)
		c.emit("  call void @xt_release(i64 %s)", condReg)
	} else if condType != "raw_i64" && condType != "i1" {
		condI64 := c.ensureI64(condReg, condType)
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condI64)
		c.emit("  call void @xt_release(i64 %s)", condI64)
	} else if condType == "raw_i64" {
		condI1 = c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", condI1, condReg)
	}
	c.emit("  br i1 %s, label %%%s, label %%%s", condI1, bodyLabel, endLabel)
	c.breakLabels = append(c.breakLabels, endLabel)
	c.continueLabels = append(c.continueLabels, condLabel)
	c.loopDepths = append(c.loopDepths, len(c.scopeStack))
	c.emit("%s:", bodyLabel)
	c.enterScope()
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", condLabel)
	c.emit("%s:", endLabel)
	c.breakLabels = c.breakLabels[:len(c.breakLabels)-1]
	c.continueLabels = c.continueLabels[:len(c.continueLabels)-1]
	c.loopDepths = c.loopDepths[:len(c.loopDepths)-1]
}

func (c *LLVMCompiler) compileLoopStatement(s *ast.LoopStatement) {
	bodyLabel := c.nextLabel("loop.body")
	c.emit("  br label %%%s", bodyLabel)
	c.emit("%s:", bodyLabel)
	endLabel := "loop.end." + bodyLabel
	c.breakLabels = append(c.breakLabels, endLabel)
	c.continueLabels = append(c.continueLabels, bodyLabel)
	c.loopDepths = append(c.loopDepths, len(c.scopeStack))
	c.enterScope()
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", bodyLabel)
	c.emit("%s:", endLabel)
	c.breakLabels = c.breakLabels[:len(c.breakLabels)-1]
	c.continueLabels = c.continueLabels[:len(c.continueLabels)-1]
	c.loopDepths = c.loopDepths[:len(c.loopDepths)-1]
}

func (c *LLVMCompiler) compileFunctionStatement(s *ast.FunctionStatement) {
	oldOutput := c.output
	c.output = bytes.Buffer{}
	oldAllocaOutput := c.allocaOutput
	c.allocaOutput = bytes.Buffer{}
	oldFunc := c.currentFunc
	c.currentFunc = s.Name.Value
	oldTable := make(map[string]SymbolInfo)
	for k, v := range c.symbolTable {
		oldTable[k] = v
	}
	oldScopeStack := c.scopeStack
	c.scopeStack = [][]string{}
	funcName := "@\"" + s.Name.Value + "\""
	params := []string{}
	for _, p := range s.Parameters {
		params = append(params, "i64 %\""+p.Name.Value+"_arg\"")
	}
	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")
	c.currentLabel = "entry"
	c.enterScope()
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emitAlloca("%s = alloca i64", addrReg)
		c.emit("  store i64 %%\"%s_arg\", i64* %s", p.Name.Value, addrReg)
		c.emit("  call void @xt_retain(i64 %%\"%s_arg\")", p.Name.Value)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64"}
		c.trackObject(addrReg)
	}
	for _, stmt := range s.Body {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  ret i64 0")
	c.emit("}")
	funcBody := c.output.String()
	funcAllocas := c.allocaOutput.String()
	parts := strings.SplitN(funcBody, "entry:\n", 2)
	if len(parts) == 2 {
		c.funcOutput.WriteString(parts[0] + "entry:\n" + funcAllocas + parts[1])
	} else {
		c.funcOutput.WriteString(funcBody)
	}
	c.output = oldOutput
	c.allocaOutput = oldAllocaOutput
	c.currentFunc = oldFunc
	c.symbolTable = oldTable
	c.scopeStack = oldScopeStack
}

func (c *LLVMCompiler) compileExpression(expr ast.Expression) (string, string, string) {
	if expr == nil {
		return "0", "i64", ""
	}
	switch e := expr.(type) {
	case *ast.IntegerLiteral:
		return fmt.Sprintf("%d", e.Value), "raw_i64", ""
	case *ast.FloatLiteral:
		return fmt.Sprintf("%f", e.Value), "double", ""
	case *ast.BooleanLiteral:
		if e.Value {
			return "4", "i64", ""
		}
		return "2", "i64", ""
	case *ast.ImportExpression:
		importPath := e.Path
		if !filepath.IsAbs(importPath) {
			dir := filepath.Dir(c.filePath)
			importPath = filepath.Join(dir, importPath)
		}
		absPath, _ := filepath.Abs(importPath)
		if c.visitedImports[absPath] {
			return "0", "i64", ""
		}
		c.visitedImports[absPath] = true
		data, err := ioutil.ReadFile(absPath)
		if err != nil {
			return "0", "i64", ""
		}
		l := lexer.New(string(data))
		p := parser.New(l)
		importProgram := p.ParseProgram()
		importProgram.FilePath = absPath
		oldPath := c.filePath
		c.filePath = absPath
		for _, stmt := range importProgram.Statements {
			c.compileStatement(stmt)
		}
		c.filePath = oldPath
		return "0", "i64", ""
	case *ast.StringLiteral:
		alias := c.addString(e.Value)
		rawReg := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", rawReg, len(e.Value)+1, len(e.Value)+1, alias)
		objReg := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", objReg, rawReg)
		resReg := c.nextReg()
		c.emit("  %s = ptrtoint %%XTString* %s to i64", resReg, objReg)
		return resReg, "i64", ""
	case *ast.Identifier:
		if e.Value == "空" {
			return "0", "i64", ""
		}
		if e.Value == "真" {
			return "4", "i64", ""
		}
		if e.Value == "假" {
			return "2", "i64", ""
		}
		if info, ok := c.symbolTable[e.Value]; ok {
			reg := c.nextReg()
			llvmType := "i64"
			if info.Type != "raw_i64" && info.Type != "i64" {
				llvmType = info.Type
			}
			c.emit("  %s = load %s, %s* %s", reg, llvmType, llvmType, info.AddrReg)
			if c.isScalarType(info.Type) {
				return reg, info.Type, info.ClassName
			}
			xtVal := c.ensureI64(reg, info.Type)
			c.emit("  call void @xt_retain(i64 %s)", xtVal)
			return xtVal, "i64", info.ClassName
		}
		// 类型关键字处理 (返回其类型 ID 的标记整数)
		switch e.Value {
		case "字":
			return "7", "i64", "" // 3 * 2 + 1 = 7
		case "整":
			return "3", "i64", "" // 1 * 2 + 1 = 3
		case "小数":
			return "5", "i64", "" // 2 * 2 + 1 = 5
		case "逻":
			return "9", "i64", "" // 4 * 2 + 1 = 9
		case "数组":
			return "11", "i64", "" // 5 * 2 + 1 = 11
		case "字典":
			return "13", "i64", "" // 6 * 2 + 1 = 13
		case "结果":
			return "17", "i64", "" // 8 * 2 + 1 = 17
		case "字节":
			return "19", "i64", "" // 9 * 2 + 1 = 19
		case "任务":
			return "21", "i64", "" // 10 * 2 + 1 = 21
		case "道":
			return "23", "i64", "" // 11 * 2 + 1 = 23
		}
		reg := c.nextReg()
		ptrReg := c.nextReg()
		c.emit("  %s = bitcast i64 (...)* @\"%s\" to i8*", ptrReg, e.Value)
		c.emit("  %s = ptrtoint i8* %s to i64", reg, ptrReg)
		return reg, "i64", ""
	case *ast.PrefixExpression:
		rightReg, rightType, _ := c.compileExpression(e.Right)
		reg := c.nextReg()
		if e.Operator == "非" {
			cond := c.nextReg()
			if rightType == "i64" {
				c.emit("  %s = icmp ne i64 %s, 2", cond, rightReg)
			} else {
				c.emit("  %s = icmp ne %s %s, 0", cond, rightType, rightReg)
			}
			resI1 := c.nextReg()
			c.emit("  %s = xor i1 %s, 1", resI1, cond)
			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, resI1)
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
			return reg, "i64", ""
		}
		if e.Operator == "-" {
			if rightType == "raw_i64" {
				c.emit("  %s = sub i64 0, %s", reg, rightReg)
				return reg, "raw_i64", ""
			}
			val := c.ensureI64(rightReg, rightType)
			// 强度削减优化：对于标记指针，-(x>>1<<1|1) 等价于 (2 - x) | 1
			neg := c.nextReg()
			c.emit("  %s = sub i64 2, %s", neg, val)
			c.emit("  %s = or i64 %s, 1", reg, neg)
			c.emit("  call void @xt_release(i64 %s)", val)
			return reg, "i64", ""
		}
		return "0", "i64", ""
	case *ast.CallExpression:
		rawFuncName := ""
		if ident, ok := e.Function.(*ast.Identifier); ok {
			rawFuncName = ident.Value
		}

		if rawFuncName == "整" && len(e.Arguments) == 1 {
			valReg, valType, _ := c.compileExpression(e.Arguments[0])
			if valType == "raw_i64" {
				return valReg, "raw_i64", ""
			}
			// 如果是 tagged i64，脱壳
			res := c.ensureRawI64(valReg, valType)
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(valReg, valType))
			return res, "raw_i64", ""
		}

		if rawFuncName == "成功" || rawFuncName == "失败" {
			isSuccess := "1"
			if rawFuncName == "失败" {
				isSuccess = "0"
			}
			valReg, valType, _ := c.compileExpression(e.Arguments[0])
			objReg, _ := c.convertToObj(valReg, valType)
			reg := c.nextReg()
			if rawFuncName == "成功" {
				c.emit("  %s = call i8* @xt_result_new(i32 %s, i8* %s, i8* null)", reg, isSuccess, objReg)
			} else {
				c.emit("  %s = call i8* @xt_result_new(i32 %s, i8* null, i8* %s)", reg, isSuccess, objReg)
			}
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(valReg, valType))

			resReg := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", resReg, reg)
			return resReg, "i64", ""
		}

		funcName := ""
		if ident, ok := e.Function.(*ast.Identifier); ok {
			switch ident.Value {
			case "整":
				funcName = "@xt_convert_to_int"
			case "小数":
				funcName = "@xt_convert_to_float"
			case "字":
				funcName = "@xt_convert_to_string"
			default:
				funcName = "@\"" + ident.Value + "\""
			}
		} else {
			fReg, _, _ := c.compileExpression(e.Function)
			funcName = fReg
		}
		isBuiltin := false
		if strings.HasPrefix(funcName, "@\"xt_") || strings.HasPrefix(funcName, "@xt_") {
			isBuiltin = true
		}
		args := []string{}
		argRegs := []string{}
		for _, a := range e.Arguments {
			valReg, valType, _ := c.compileExpression(a)
			xtVal := c.ensureI64(valReg, valType)
			argRegs = append(argRegs, xtVal)
			if isBuiltin {
				objReg2, _ := c.convertToObj(valReg, valType)
				args = append(args, "i8* "+objReg2)
			} else {
				args = append(args, "i64 "+xtVal)
			}
		}

		// 针对 printf 同步自举编译器的特殊处理逻辑
		if rawFuncName == "printf" && len(args) > 0 {
			reg := c.nextReg()
			// 在 MinGW 环境下，直接通过 IR 加载指针极其不稳定
			// 改为调用运行时包装器，由 C 编译器处理 ABI 细节
			fmtObjReg := argRegs[0]
			resI32 := c.nextReg()

			// 准备参数：第一个是 XTString*，第二个是变参 (目前仅演示支持一个)
			sPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTString*", sPtr, fmtObjReg)

			valReg := "i64 0"
			if len(argRegs) > 1 {
				valReg = "i64 " + argRegs[1]
			}

			c.emit("  %s = call i32 (%%XTString*, ...) @xt_ffi_printf(%%XTString* %s, %s)", resI32, sPtr, valReg)
			c.emit("  %s = sext i32 %s to i64", reg, resI32)

			for _, r := range argRegs {
				c.emit("  call void @xt_release(i64 %s)", r)
			}
			return reg, "i64", ""
		}

		reg := c.nextReg()
		if !strings.HasPrefix(funcName, "@") {
			funcName = "@" + funcName
		}
		if strings.HasPrefix(funcName, "@%") {
			funcName = strings.TrimPrefix(funcName, "@")
			funcPtrReg := c.nextReg()
			argTypes := make([]string, len(args))
			for i, a := range args {
				argTypes[i] = strings.Split(a, " ")[0]
			}
			c.emit("  %s = inttoptr i64 %s to i64 (%s)*", funcPtrReg, funcName, strings.Join(argTypes, ", "))
			c.emit("  %s = call i64 %s(%s)", reg, funcPtrReg, strings.Join(args, ", "))
		} else if strings.HasPrefix(funcName, "%") {
			funcPtrReg := c.nextReg()
			argTypes := make([]string, len(args))
			for i, a := range args {
				argTypes[i] = strings.Split(a, " ")[0]
			}
			c.emit("  %s = inttoptr i64 %s to i64 (%s)*", funcPtrReg, funcName, strings.Join(argTypes, ", "))
			c.emit("  %s = call i64 %s(%s)", reg, funcPtrReg, strings.Join(args, ", "))
		} else {
			if isBuiltin {
				if strings.Contains(funcName, "xt_to_int") {
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
				} else {
					c.emit("  %s = call i8* %s(%s)", reg, funcName, strings.Join(args, ", "))
				}
			} else {
				c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
			}
		}
		for _, argReg := range argRegs {
			c.emit("  call void @xt_release(i64 %s)", argReg)
		}
		if isBuiltin && !strings.Contains(funcName, "xt_to_int") {
			return reg, "i8*", ""
		}
		return reg, "i64", ""
	case *ast.NewExpression:
		reg := c.nextReg()
		c.emit("  %s = call i64 @xt_dict_new(i64 16)", reg)
		className := ""
		if ident, ok := e.Type.(*ast.Identifier); ok {
			className = ident.Value
		}
		keyAlias := c.addString("__类型__")
		keyRaw := c.nextReg()
		c.emit("  %s = getelementptr inbounds [11 x i8], [11 x i8]* @%s, i64 0, i64 0", keyRaw, keyAlias)
		keyObj := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", keyObj, keyRaw)
		keyXt := c.nextReg()
		c.emit("  %s = ptrtoint %%XTString* %s to i64", keyXt, keyObj)
		valAlias := c.addString(className)
		valRaw := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", valRaw, len(className)+1, len(className)+1, valAlias)
		valObj := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", valObj, valRaw)
		valXt := c.nextReg()
		c.emit("  %s = ptrtoint %%XTString* %s to i64", valXt, valObj)

		c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", reg, keyXt, valXt)
		c.emit("  call void @xt_release(i64 %s)", keyXt)
		c.emit("  call void @xt_release(i64 %s)", valXt)

		classInfo, ok := c.classes[className]
		if ok {
			for _, field := range classInfo.Fields {
				fKeyAlias := c.addString(field)
				fKeyRaw := c.nextReg()
				c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", fKeyRaw, len(field)+1, len(field)+1, fKeyAlias)
				fKeyObj := c.nextReg()
				c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", fKeyObj, fKeyRaw)
				fKeyXt := c.nextReg()
				c.emit("  %s = ptrtoint %%XTString* %s to i64", fKeyXt, fKeyObj)
				c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 0)", reg, fKeyXt)
				c.emit("  call void @xt_release(i64 %s)", fKeyXt)
			}

			for methodName, funcName := range classInfo.Methods {
				if methodName == "造" {
					continue
				}
				mKeyAlias := c.addString(methodName)
				mKeyRaw := c.nextReg()
				c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", mKeyRaw, len(methodName)+1, len(methodName)+1, mKeyAlias)
				mKeyObj := c.nextReg()
				c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", mKeyObj, mKeyRaw)
				mKeyXt := c.nextReg()
				c.emit("  %s = ptrtoint %%XTString* %s to i64", mKeyXt, mKeyObj)

				fRawReg := c.nextReg()

				argCount := classInfo.MethodArgsCount[methodName]
				sig := "i64 (i64"
				for i := 0; i < argCount; i++ {
					sig += ", i64"
				}
				sig += ")*"

				c.emit("  %s = bitcast %s %s to i8*", fRawReg, sig, funcName)
				fObjReg := c.nextReg()
				c.emit("  %s = call i64 @xt_func_new(i8* %s)", fObjReg, fRawReg)
				c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", reg, mKeyXt, fObjReg)
				c.emit("  call void @xt_release(i64 %s)", fObjReg)
				c.emit("  call void @xt_release(i64 %s)", mKeyXt)
			}

			if constr, ok := classInfo.Methods["造"]; ok {
				args := []string{"i64 " + reg}
				argRegs := []string{}
				for _, a := range e.Arguments {
					valReg, valType, _ := c.compileExpression(a)
					xtVal := c.ensureI64(valReg, valType)
					argRegs = append(argRegs, xtVal)
					args = append(args, "i64 "+xtVal)
				}
				c.emit("  call i64 %s(%s)", constr, strings.Join(args, ", "))
				for _, r := range argRegs {
					c.emit("  call void @xt_release(i64 %s)", r)
				}
			}
		}

		return reg, "i64", className
	case *ast.ArrayLiteral:
		reg := c.nextReg()
		c.emit("  %s = call i64 @xt_array_new(i64 %d)", reg, len(e.Elements))
		for _, el := range e.Elements {
			valReg, valType, _ := c.compileExpression(el)
			xtValReg := c.ensureI64(valReg, valType)
			c.emit("  call void @xt_array_append(i64 %s, i64 %s)", reg, xtValReg)
			c.emit("  call void @xt_release(i64 %s)", xtValReg)
		}
		return reg, "i64", ""
	case *ast.DictLiteral:
		reg := c.nextReg()
		c.emit("  %s = call i64 @xt_dict_new(i64 %d)", reg, len(e.Pairs)*2)
		for k, v := range e.Pairs {
			kReg, kType, _ := c.compileExpression(k)
			kXtVal := c.ensureI64(kReg, kType)

			vReg, vType, _ := c.compileExpression(v)
			vXtVal := c.ensureI64(vReg, vType)

			c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", reg, kXtVal, vXtVal)
			c.emit("  call void @xt_release(i64 %s)", kXtVal)
			c.emit("  call void @xt_release(i64 %s)", vXtVal)
		}
		return reg, "i64", ""
	case *ast.IndexExpression:
		leftReg, leftType, _ := c.compileExpression(e.Left)
		idxReg, idxType, _ := c.compileExpression(e.Index)

		leftXt := c.ensureI64(leftReg, leftType)
		idxXt := c.ensureI64(idxReg, idxType)

		isNotNull := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", isNotNull, leftXt)
		notNullLabel := c.nextLabel("idx.notnull")
		mergeLabel := c.nextLabel("idx.merge")
		resAddr := c.nextReg()
		c.emitAlloca("%s = alloca i64", resAddr)
		c.emit("  store i64 0, i64* %s", resAddr)
		c.emit("  br i1 %s, label %%%s, label %%%s", isNotNull, notNullLabel, mergeLabel)

		c.emit("%s:", notNullLabel)
		newReg := c.nextReg()
		c.emit("  %s = inttoptr i64 %s to %%XTObject*", newReg, leftXt)

		typeIdPtr := c.nextReg()
		c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, newReg)
		typeId := c.nextReg()
		c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)
		isDict := c.nextReg()
		c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId)
		isString := c.nextReg()
		c.emit("  %s = icmp eq i32 %s, 3", isString, typeId)
		dictLabel := c.nextLabel("idx.dict")
		stringLabel := c.nextLabel("idx.string")
		arrayLabel := c.nextLabel("idx.array")
		c.emit("  br i1 %s, label %%%s, label %%%s", isDict, dictLabel, stringLabel)
		c.emit("%s:", dictLabel)
		dPtr := c.nextReg()
		c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtr, newReg)
		idxObj, _ := c.convertToObj(idxXt, "i64")
		idxXtVal := c.nextReg()
		c.emit("  %s = ptrtoint i8* %s to i64", idxXtVal, idxObj)
		dRes := c.nextReg()
		c.emit("  %s = call i64 @xt_dict_get(i64 %s, i64 %s)", dRes, leftXt, idxXtVal)
		c.emit("  call void @xt_retain(i64 %s)", dRes)
		c.emit("  store i64 %s, i64* %s", dRes, resAddr)
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", stringLabel)
		c.emit("  br i1 %s, label %%%s, label %%%s", isString, stringLabel+".true", arrayLabel)
		c.emit("%s.true:", stringLabel)
		sIdxUntag := c.nextReg()
		c.emit("  %s = call i64 @xt_to_int(i64 %s)", sIdxUntag, idxXt)
		sRes := c.nextReg()
		c.emit("  %s = call i64 @xt_string_get_char(i64 %s, i64 %s)", sRes, leftXt, sIdxUntag)
		c.emit("  store i64 %s, i64* %s", sRes, resAddr)
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", arrayLabel)
		aPtr := c.nextReg()
		c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtr, newReg)
		idxUntag := c.nextReg()
		c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, idxXt)
		elemPtrPtr := c.nextReg()
		c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, aPtr)
		elemsPtr := c.nextReg()
		c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
		elemPtr := c.nextReg()
		c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxUntag)
		elemPtrTyped := c.nextReg()
		c.emit("  %s = bitcast i8** %s to i64*", elemPtrTyped, elemPtr)
		aXtVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", aXtVal, elemPtrTyped)
		c.emit("  call void @xt_retain(i64 %s)", aXtVal)
		c.emit("  store i64 %s, i64* %s", aXtVal, resAddr)
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", mergeLabel)
		finalVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", finalVal, resAddr)
		c.emit("  call void @xt_release(i64 %s)", leftXt)
		if idxType != "raw_i64" {
			c.emit("  call void @xt_release(i64 %s)", idxXt)
		}
		return finalVal, "i64", ""
	case *ast.MemberCallExpression:
		// 优先检查是否是类名静态调用 (如 按钮.渲染(此))
		if ident, ok := e.Object.(*ast.Identifier); ok {
			if classInfo, ok := c.classes[ident.Value]; ok {
				if funcName, ok := classInfo.Methods[e.Member.Value]; ok {
					args := []string{}
					argRegs := []string{}
					for _, a := range e.Arguments {
						valReg, valType, _ := c.compileExpression(a)
						xtVal := c.ensureI64(valReg, valType)
						argRegs = append(argRegs, xtVal)
						args = append(args, "i64 "+xtVal)
					}
					callRes := c.nextReg()
					c.emit("  %s = call i64 %s(%s)", callRes, funcName, strings.Join(args, ", "))
					for _, r := range argRegs {
						c.emit("  call void @xt_release(i64 %s)", r)
					}
					return callRes, "i64", ""
				}
			}

			if ident.Value == "文件" {
				if e.Member.Value == "读" {
					valReg, valType, _ := c.compileExpression(e.Arguments[0])
					objReg, _ := c.convertToObj(valReg, valType)
					xtVal := c.nextReg()
					c.emit("  %s = ptrtoint i8* %s to i64", xtVal, objReg)
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_file_read(i64 %s)", res, xtVal)
					c.emit("  call void @xt_release(i64 %s)", xtVal)
					return res, "i64", ""
				} else if e.Member.Value == "写" {
					pathReg, pathType, _ := c.compileExpression(e.Arguments[0])
					pathObj, _ := c.convertToObj(pathReg, pathType)
					pathXtVal := c.nextReg()
					c.emit("  %s = ptrtoint i8* %s to i64", pathXtVal, pathObj)
					contReg, contType, _ := c.compileExpression(e.Arguments[1])
					contObj, _ := c.convertToObj(contReg, contType)
					contXtVal := c.nextReg()
					c.emit("  %s = ptrtoint i8* %s to i64", contXtVal, contObj)
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_file_write(i64 %s, i64 %s)", res, pathXtVal, contXtVal)
					c.emit("  call void @xt_release(i64 %s)", pathXtVal)
					c.emit("  call void @xt_release(i64 %s)", contXtVal)
					return res, "i64", ""
				} else if e.Member.Value == "存在?" {
					pathReg, pathType, _ := c.compileExpression(e.Arguments[0])
					xtVal := c.ensureI64(pathReg, pathType)
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_file_exists(i64 %s)", res, xtVal)
					c.emit("  call void @xt_release(i64 %s)", xtVal)
					return res, "i64", ""
				}
			} else if ident.Value == "时" {
				if e.Member.Value == "现" {
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_time_now()", res)
					return res, "i64", ""
				} else if e.Member.Value == "毫秒" {
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_time_ms()", res)
					return res, "i64", ""
				} else if e.Member.Value == "睡" {
					valReg, valType, _ := c.compileExpression(e.Arguments[0])
					xtVal := c.ensureI64(valReg, valType)
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_time_sleep(i64 %s)", res, xtVal)
					c.emit("  call void @xt_release(i64 %s)", xtVal)
					return res, "i64", ""
				}
			} else if ident.Value == "数学" {
				if e.Member.Value == "随机" {
					valReg, valType, _ := c.compileExpression(e.Arguments[0])
					xtVal := c.ensureI64(valReg, valType)
					res := c.nextReg()
					c.emit("  %s = call i64 @xt_math_random(i64 %s)", res, xtVal)
					c.emit("  call void @xt_release(i64 %s)", xtVal)
					return res, "i64", ""
				}
			}
		}
		objReg, objType, objClass := c.compileExpression(e.Object)
		objXt := c.ensureI64(objReg, objType)

		isNotNull := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", isNotNull, objXt)
		notNullLabel := c.nextLabel("method.notnull")
		mergeLabel := c.nextLabel("method.merge")
		resAddr := c.nextReg()
		c.emitAlloca("%s = alloca i64", resAddr)
		c.emit("  store i64 0, i64* %s", resAddr)
		c.emit("  br i1 %s, label %%%s, label %%%s", isNotNull, notNullLabel, mergeLabel)

		c.emit("%s:", notNullLabel)

		// Built-in method handling
		if e.Member.Value == "解包" {
			resPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTResult*", resPtr, objXt)
			isSuccPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 2", isSuccPtr, resPtr)
			isSucc := c.nextReg()
			c.emit("  %s = load i32, i32* %s", isSucc, isSuccPtr)
			cond := c.nextReg()
			c.emit("  %s = icmp ne i32 %s, 0", cond, isSucc)
			valReg := c.nextReg()
			errReg := c.nextReg()
			resReg := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 4", valReg, resPtr)
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 5", errReg, resPtr)
			vPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", vPtr, valReg)
			ePtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", ePtr, errReg)
			c.emit("  %s = select i1 %s, i8* %s, i8* %s", resReg, cond, vPtr, ePtr)
			resXt := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", resXt, resReg)
			c.emit("  call void @xt_retain(i64 %s)", resXt)
			c.emit("  store i64 %s, i64* %s", resXt, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "成功" {
			resPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTResult*", resPtr, objXt)
			isSuccPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 2", isSuccPtr, resPtr)
			isSucc := c.nextReg()
			c.emit("  %s = load i32, i32* %s", isSucc, isSuccPtr)
			cond := c.nextReg()
			c.emit("  %s = icmp ne i32 %s, 0", cond, isSucc)
			resI64 := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", resI64, cond)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "值" {
			resPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTResult*", resPtr, objXt)
			valPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 4", valPtrPtr, resPtr)
			valPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", valPtr, valPtrPtr)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", resI64, valPtr)
			c.emit("  call void @xt_retain(i64 %s)", resI64)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "错误" {
			resPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTResult*", resPtr, objXt)
			errPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 5", errPtrPtr, resPtr)
			errPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", errPtr, errPtrPtr)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", resI64, errPtr)
			c.emit("  call void @xt_retain(i64 %s)", resI64)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "长度" || e.Member.Value == "大小" {
			objPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, objXt)
			typeIdPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
			typeId := c.nextReg()
			c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)

			isArr := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 5", isArr, typeId)
			isDict := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId)

			lenArrLabel := c.nextLabel("len.arr")
			lenDictLabel := c.nextLabel("len.dict")
			lenStrLabel := c.nextLabel("len.str")

			c.emit("  br i1 %s, label %%%s, label %%%s", isArr, lenArrLabel, lenDictLabel)
			c.emit("%s:", lenArrLabel)
			aPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtr, objPtr)
			alPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 3", alPtr, aPtr)
			alVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", alVal, alPtr)
			c.emit("  store i64 %s, i64* %s", c.ensureI64(alVal, "raw_i64"), resAddr)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", lenDictLabel)
			c.emit("  br i1 %s, label %%%s, label %%%s", isDict, lenDictLabel+".true", lenStrLabel)
			c.emit("%s.true:", lenDictLabel)
			dPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtr, objPtr)
			dlPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTDict, %%XTDict* %s, i32 0, i32 3", dlPtr, dPtr)
			dlVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", dlVal, dlPtr)
			c.emit("  store i64 %s, i64* %s", c.ensureI64(dlVal, "raw_i64"), resAddr)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", lenStrLabel)
			sPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", sPtr, objPtr)
			slPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", slPtr, sPtr)
			slVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", slVal, slPtr)
			c.emit("  store i64 %s, i64* %s", c.ensureI64(slVal, "raw_i64"), resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "取字节" {
			argReg, argType, _ := c.compileExpression(e.Arguments[0])
			idxXt := c.ensureI64(argReg, argType)
			idxUntag := c.nextReg()
			c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, idxXt)
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_get_byte(i64 %s, i64 %s)", resI64, objXt, idxUntag)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  call void @xt_release(i64 %s)", idxXt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "字节数" {
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_byte_length(i64 %s)", resI64, objXt)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "字符数" {
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_char_count(i64 %s)", resI64, objXt)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "替换" {
			arg1Reg, arg1Type, _ := c.compileExpression(e.Arguments[0])
			arg1Xt := c.ensureI64(arg1Reg, arg1Type)
			arg2Reg, arg2Type, _ := c.compileExpression(e.Arguments[1])
			arg2Xt := c.ensureI64(arg2Reg, arg2Type)
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_replace(i64 %s, i64 %s, i64 %s)", resI64, objXt, arg1Xt, arg2Xt)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  call void @xt_release(i64 %s)", arg1Xt)
			c.emit("  call void @xt_release(i64 %s)", arg2Xt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "分割" {
			arg1Reg, arg1Type, _ := c.compileExpression(e.Arguments[0])
			arg1Xt := c.ensureI64(arg1Reg, arg1Type)
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_split(i64 %s, i64 %s)", resI64, objXt, arg1Xt)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  call void @xt_release(i64 %s)", arg1Xt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "转为十六进制" {
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_to_hex_string(i64 %s)", resI64, objXt)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "字符" {
			argReg, argType, _ := c.compileExpression(e.Arguments[0])
			idxXt := c.ensureI64(argReg, argType)
			idxUntag := c.nextReg()
			c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, idxXt)
			resI64 := c.nextReg()
			c.emit("  %s = call i64 @xt_string_get_char(i64 %s, i64 %s)", resI64, objXt, idxUntag)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  call void @xt_release(i64 %s)", idxXt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "包含?" || e.Member.Value == "含?" {
			argReg, argType, _ := c.compileExpression(e.Arguments[0])
			argXt := c.ensureI64(argReg, argType)
			objPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, objXt)
			typeIdPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
			typeId := c.nextReg()
			c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)
			isStr := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 3", isStr, typeId)
			strLabel := c.nextLabel("contains.str")
			dictLabel := c.nextLabel("contains.dict")
			c.emit("  br i1 %s, label %%%s, label %%%s", isStr, strLabel, dictLabel)
			c.emit("%s:", strLabel)
			s1Ptr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", s1Ptr, objPtr)
			argObj, _ := c.convertToObj(argXt, "i64")
			s2Ptr := c.nextReg()
			c.emit("  %s = bitcast i8* %s to %%XTString*", s2Ptr, argObj)
			sRes := c.nextReg()
			c.emit("  %s = call i32 @xt_string_contains(%%XTString* %s, %%XTString* %s)", sRes, s1Ptr, s2Ptr)
			sCond := c.nextReg()
			c.emit("  %s = icmp ne i32 %s, 0", sCond, sRes)
			sFinal := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", sFinal, sCond)
			c.emit("  store i64 %s, i64* %s", sFinal, resAddr)
			c.emit("  br label %%%s", mergeLabel)
			c.emit("%s:", dictLabel)
			dRes := c.nextReg()
			c.emit("  %s = call i32 @xt_dict_contains(i64 %s, i64 %s)", dRes, objXt, argXt)
			dCond := c.nextReg()
			c.emit("  %s = icmp ne i32 %s, 0", dCond, dRes)
			dFinal := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", dFinal, dCond)
			c.emit("  store i64 %s, i64* %s", dFinal, resAddr)
			c.emit("  call void @xt_release(i64 %s)", argXt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "追加" {
			argReg, argType, _ := c.compileExpression(e.Arguments[0])
			argXt := c.ensureI64(argReg, argType)
			c.emit("  call void @xt_array_append(i64 %s, i64 %s)", objXt, argXt)
			c.emit("  call void @xt_release(i64 %s)", argXt)
			c.emit("  store i64 0, i64* %s", resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "弹出" {
			objPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTArray*", objPtr, objXt)
			popRes := c.nextReg()
			c.emit("  %s = call i64 @xt_array_pop(%%XTArray* %s)", popRes, objPtr)
			c.emit("  store i64 %s, i64* %s", popRes, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "连接" {
			sepReg, sepType, _ := c.compileExpression(e.Arguments[0])
			sepXt := c.ensureI64(sepReg, sepType)
			sepPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTString*", sepPtr, sepXt)
			joinRes := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_array_join(i64 %s, %%XTString* %s)", joinRes, objXt, sepPtr)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resI64, joinRes)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  call void @xt_release(i64 %s)", sepXt)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "截取" {
			startReg, startType, _ := c.compileExpression(e.Arguments[0])
			startRaw := c.ensureRawI64(startReg, startType)
			endRaw := c.nextReg()
			if len(e.Arguments) > 1 {
				er, et, _ := c.compileExpression(e.Arguments[1])
				endRaw = c.ensureRawI64(er, et)
			} else {
				strPtr := c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objXt)
				lenPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", lenPtr, strPtr)
				c.emit("  %s = load i64, i64* %s", endRaw, lenPtr)
			}
			strPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objXt)
			subRes := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_substring(%%XTString* %s, i64 %s, i64 %s)", subRes, strPtr, startRaw, endRaw)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resI64, subRes)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else if e.Member.Value == "截取" {
			startReg, startType, _ := c.compileExpression(e.Arguments[0])
			startRaw := c.ensureRawI64(startReg, startType)
			endRaw := c.nextReg()
			if len(e.Arguments) > 1 {
				er, et, _ := c.compileExpression(e.Arguments[1])
				endRaw = c.ensureRawI64(er, et)
			} else {
				strPtr := c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objXt)
				lenPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", lenPtr, strPtr)
				c.emit("  %s = load i64, i64* %s", endRaw, lenPtr)
			}
			strPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objXt)
			subRes := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_substring(%%XTString* %s, i64 %s, i64 %s)", subRes, strPtr, startRaw, endRaw)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resI64, subRes)
			c.emit("  store i64 %s, i64* %s", resI64, resAddr)
			c.emit("  br label %%%s", mergeLabel)
		} else {
			// Class method or dynamic call
			if objClass != "" {
				if classInfo, ok := c.classes[objClass]; ok {
					if funcName, ok := classInfo.Methods[e.Member.Value]; ok {
						args := []string{"i64 " + objXt}
						argRegs := []string{}
						for _, a := range e.Arguments {
							valReg, valType, _ := c.compileExpression(a)
							xtVal := c.ensureI64(valReg, valType)
							argRegs = append(argRegs, xtVal)
							args = append(args, "i64 "+xtVal)
						}
						callRes := c.nextReg()
						c.emit("  %s = call i64 %s(%s)", callRes, funcName, strings.Join(args, ", "))
						for _, r := range argRegs {
							c.emit("  call void @xt_release(i64 %s)", r)
						}
						c.emit("  store i64 %s, i64* %s", callRes, resAddr)
						c.emit("  br label %%%s", mergeLabel)
					}
				}
			}

			// Dynamic dictionary-based call
			keyAlias := c.addString(e.Member.Value)
			keyRaw := c.nextReg()
			c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", keyRaw, len(e.Member.Value)+1, len(e.Member.Value)+1, keyAlias)
			keyObj := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", keyObj, keyRaw)
			keyXt := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", keyXt, keyObj)

			dynRes := c.nextReg()
			c.emit("  %s = call i64 @xt_dict_get(i64 %s, i64 %s)", dynRes, objXt, keyXt)
			c.emit("  call void @xt_retain(i64 %s)", dynRes)
			if e.Arguments != nil {
				isNotNullCall := c.nextReg()
				c.emit("  %s = icmp ne i64 %s, 0", isNotNullCall, dynRes)
				callLabel := c.nextLabel("method.call")
				c.emit("  br i1 %s, label %%%s, label %%%s", isNotNullCall, callLabel, mergeLabel)
				c.emit("%s:", callLabel)
				fPtrObj := c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTFunction*", fPtrObj, dynRes)
				fRawPtrPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTFunction, %%XTFunction* %s, i32 0, i32 2", fRawPtrPtr, fPtrObj)
				fRawPtr := c.nextReg()
				c.emit("  %s = load i8*, i8** %s", fRawPtr, fRawPtrPtr)
				args := []string{"i64 " + objXt}
				argRegs := []string{}
				for _, a := range e.Arguments {
					valReg, valType, _ := c.compileExpression(a)
					xtVal := c.ensureI64(valReg, valType)
					argRegs = append(argRegs, xtVal)
					args = append(args, "i64 "+xtVal)
				}
				fTyped := c.nextReg()
				argTypes := make([]string, len(args))
				for i := range args {
					argTypes[i] = "i64"
				}
				c.emit("  %s = bitcast i8* %s to i64 (%s)*", fTyped, fRawPtr, strings.Join(argTypes, ", "))
				callRes := c.nextReg()
				c.emit("  %s = call i64 %s(%s)", callRes, fTyped, strings.Join(args, ", "))
				for _, r := range argRegs {
					c.emit("  call void @xt_release(i64 %s)", r)
				}
				c.emit("  store i64 %s, i64* %s", callRes, resAddr)
				c.emit("  call void @xt_release(i64 %s)", dynRes)
				c.emit("  call void @xt_release(i64 %s)", keyXt)
				c.emit("  br label %%%s", mergeLabel)
			} else {
				c.emit("  store i64 %s, i64* %s", dynRes, resAddr)
				c.emit("  call void @xt_release(i64 %s)", dynRes)
				c.emit("  call void @xt_release(i64 %s)", keyXt)
				c.emit("  br label %%%s", mergeLabel)
			}
		}

		c.emit("%s:", mergeLabel)
		final := c.nextReg()
		c.emit("  %s = load i64, i64* %s", final, resAddr)
		c.emit("  call void @xt_release(i64 %s)", objXt)
		return final, "i64", objClass
	case *ast.ExecuteExpression:
		valReg, valType, _ := c.compileExpression(e.Command)
		xtVal := c.ensureI64(valReg, valType)
		res := c.nextReg()
		c.emit("  %s = call i64 @xt_execute(i64 %s)", res, xtVal)
		c.emit("  call void @xt_release(i64 %s)", xtVal)
		return res, "i64", ""
	case *ast.InputExpression:
		var xtVal string
		if e.Prompt != nil {
			valReg, valType, _ := c.compileExpression(e.Prompt)
			xtVal = c.ensureI64(valReg, valType)
		} else {
			xtVal = "0"
		}
		res := c.nextReg()
		c.emit("  %s = call i64 @xt_input(i64 %s)", res, xtVal)
		if xtVal != "0" {
			c.emit("  call void @xt_release(i64 %s)", xtVal)
		}
		return res, "i64", ""
	case *ast.ListenExpression:
		portReg, portType, _ := c.compileExpression(e.Address)
		portXt := c.ensureI64(portReg, portType)
		cbReg, cbType, _ := c.compileExpression(e.Callback)
		cbXt := c.ensureI64(cbReg, cbType)
		res := c.nextReg()
		c.emit("  %s = call i64 @xt_listen(i64 %s, i64 %s)", res, portXt, cbXt)
		c.emit("  call void @xt_release(i64 %s)", portXt)
		c.emit("  call void @xt_release(i64 %s)", cbXt)
		return res, "i64", ""
	case *ast.ConnectExpression:
		addrReg, addrType, _ := c.compileExpression(e.Address)
		addrXt := c.ensureI64(addrReg, addrType)
		res := c.nextReg()
		c.emit("  %s = call i64 @xt_connect(i64 %s)", res, addrXt)
		c.emit("  call void @xt_release(i64 %s)", addrXt)
		return res, "i64", ""
	case *ast.AwaitExpression:
		taskReg, taskType, _ := c.compileExpression(e.Value)
		taskXt := c.ensureI64(taskReg, taskType)
		res := c.nextReg()
		c.emit("  %s = call i64 @xt_wait(i64 %s)", res, taskXt)
		c.emit("  call void @xt_release(i64 %s)", taskXt)
		return res, "i64", ""
	case *ast.InfixExpression:
		if e.Operator == "且" || e.Operator == "&&" {
			return c.compileLogicalAnd(e)
		}
		if e.Operator == "或" || e.Operator == "||" {
			return c.compileLogicalOr(e)
		}
		leftReg, leftType, _ := c.compileExpression(e.Left)
		rightReg, rightType, _ := c.compileExpression(e.Right)

		if e.Operator == "是" {
			lXt := c.ensureI64(leftReg, leftType)
			rRaw := c.ensureRawI64(rightReg, rightType)

			// 获取左侧类型 ID
			isTagged := c.nextReg()
			tagBit := c.nextReg()
			c.emit("  %s = and i64 %s, 1", tagBit, lXt)
			c.emit("  %s = icmp ne i64 %s, 0", isTagged, tagBit)

			taggedTypeLabel := c.nextLabel("is.tagged")
			ptrTypeLabel := c.nextLabel("is.ptr")
			mergeTypeLabel := c.nextLabel("is.merge")

			c.emit("  br i1 %s, label %%%s, label %%%s", isTagged, taggedTypeLabel, ptrTypeLabel)

			c.emit("%s:", taggedTypeLabel)
			// 对于标记整数，目前全是 XT_TYPE_INT (1)
			typeIdTagged := "1"
			c.emit("  br label %%%s", mergeTypeLabel)

			c.emit("%s:", ptrTypeLabel)
			// 对于指针对象，从 header 读取 type_id
			// 但首先要排除特殊常量 XT_NULL (0), XT_FALSE (2), XT_TRUE (4)
			isRealPtr := c.nextReg()
			c.emit("  %s = icmp ugt i64 %s, 4", isRealPtr, lXt)

			realPtrLabel := c.nextLabel("is.real_ptr")
			specialConstLabel := c.nextLabel("is.special_const")

			c.emit("  br i1 %s, label %%%s, label %%%s", isRealPtr, realPtrLabel, specialConstLabel)

			c.emit("%s:", specialConstLabel)
			// 处理特殊常量
			isNull := c.nextReg()
			c.emit("  %s = icmp eq i64 %s, 0", isNull, lXt)
			isBoolSpecial := c.nextReg()
			c.emit("  %s = icmp ugt i64 %s, 0", isBoolSpecial, lXt)
			typeIdSpecial := c.nextReg()
			// 如果是 0 -> 0 (NULL), 如果是 2 或 4 -> 4 (BOOL)
			c.emit("  %s = select i1 %s, i64 4, i64 0", typeIdSpecial, isBoolSpecial)
			c.emit("  br label %%%s", mergeTypeLabel)

			c.emit("%s:", realPtrLabel)
			objPtr := c.nextReg()
			c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, lXt)
			typeIdPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
			typeIdPtrVal := c.nextReg()
			c.emit("  %s = load i32, i32* %s", typeIdPtrVal, typeIdPtr)
			typeIdPtrValI64 := c.nextReg()
			c.emit("  %s = zext i32 %s to i64", typeIdPtrValI64, typeIdPtrVal)
			c.emit("  br label %%%s", mergeTypeLabel)

			c.emit("%s:", mergeTypeLabel)
			actualTypeId := c.nextReg()
			c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ], [ %s, %%%s ]", actualTypeId, typeIdTagged, taggedTypeLabel, typeIdSpecial, specialConstLabel, typeIdPtrValI64, realPtrLabel)

			cond := c.nextReg()
			c.emit("  %s = icmp eq i64 %s, %s", cond, actualTypeId, rRaw)
			c.emit("  call void @xt_release(i64 %s)", lXt)
			if rightType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
			}
			reg := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, cond)
			return reg, "i64", ""
		}

		isArithmeticOrCompare := false
		switch e.Operator {
		case "+", "-", "*", "/", "%", "==", "!=", "<", ">", "<=", ">=":
			isArithmeticOrCompare = true
		}
		if isArithmeticOrCompare {
			// P1: 整数算术快速路径 (避免脱壳/装壳和 ARC)
			if leftType == "raw_i64" && rightType == "raw_i64" {
				switch e.Operator {
				case "+", "-", "*", "/", "%":
					var op string
					switch e.Operator {
					case "+":
						op = "add"
					case "-":
						op = "sub"
					case "*":
						op = "mul"
					case "/":
						op = "sdiv"
					case "%":
						op = "srem"
					}
					res := c.nextReg()
					c.emit("  %s = %s i64 %s, %s", res, op, leftReg, rightReg)
					return res, "raw_i64", ""
				case "==", "!=", "<", ">", "<=", ">=":
					var cond string
					switch e.Operator {
					case "==", "是":
						cond = "eq"
					case "!=":
						cond = "ne"
					case "<":
						cond = "slt"
					case ">":
						cond = "sgt"
					case "<=":
						cond = "sle"
					case ">=":
						cond = "sge"
					}
					resI1 := c.nextReg()
					c.emit("  %s = icmp %s i64 %s, %s", resI1, cond, leftReg, rightReg)
					res := c.nextReg()
					c.emit("  %s = select i1 %s, i64 4, i64 2", res, resI1)
					return res, "i64", ""
				}
			}

			magicMethod := ""
			switch e.Operator {
			case "+":
				magicMethod = "_加_"
			case "-":
				magicMethod = "_减_"
			case "*":
				magicMethod = "_乘_"
			case "/":
				magicMethod = "_除_"
			case "%":
				magicMethod = "_模_"
			case "==":
				magicMethod = "_等_"
			case "是":
				magicMethod = "_是_"
			}
			if magicMethod != "" {
				keyAlias := c.addString(magicMethod)
				keyRaw := c.nextReg()
				c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", keyRaw, len(magicMethod)+1, len(magicMethod)+1, keyAlias)
				keyObj := c.nextReg()
				c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", keyObj, keyRaw)
				keyXt := c.nextReg()
				c.emit("  %s = ptrtoint %%XTString* %s to i64", keyXt, keyObj)
				objXt := c.ensureI64(leftReg, leftType)
				funcObj := c.nextReg()
				c.emit("  %s = call i64 @xt_dict_get(i64 %s, i64 %s)", funcObj, objXt, keyXt)
				isFunc := c.nextReg()
				c.emit("  %s = icmp ne i64 %s, 0", isFunc, funcObj)
				overloadLabel := c.nextLabel("op.overload")
				fallbackLabel := c.nextLabel("op.fallback")
				mergeLabel := c.nextLabel("op.merge")
				resAddr := c.nextReg()
				c.emitAlloca("%s = alloca i64", resAddr)
				c.emit("  br i1 %s, label %%%s, label %%%s", isFunc, overloadLabel, fallbackLabel)
				c.emit("%s:", overloadLabel)
				fPtrObj := c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTFunction*", fPtrObj, funcObj)
				fRawPtrPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTFunction, %%XTFunction* %s, i32 0, i32 2", fRawPtrPtr, fPtrObj)
				fRawPtr := c.nextReg()
				c.emit("  %s = load i8*, i8** %s", fRawPtr, fRawPtrPtr)
				fTyped := c.nextReg()
				c.emit("  %s = bitcast i8* %s to i64 (i64, i64)*", fTyped, fRawPtr)
				rightXt := c.ensureI64(rightReg, rightType)
				ovRes := c.nextReg()
				c.emit("  %s = call i64 %s(i64 %s, i64 %s)", ovRes, fTyped, objXt, rightXt)
				c.emit("  store i64 %s, i64* %s", ovRes, resAddr)
				c.emit("  br label %%%s", mergeLabel)
				c.emit("%s:", fallbackLabel)

				// Fallback to built-in logic
				var fbRes string
				if e.Operator == "==" || e.Operator == "!=" || e.Operator == "是" {
					fbCond := c.nextReg()
					if leftType == "raw_i64" && rightType == "raw_i64" {
						if e.Operator == "==" || e.Operator == "是" {
							c.emit("  %s = icmp eq i64 %s, %s", fbCond, leftReg, rightReg)
						} else {
							c.emit("  %s = icmp ne i64 %s, %s", fbCond, leftReg, rightReg)
						}
					} else {
						lXt := c.ensureI64(leftReg, leftType)
						rXt := c.ensureI64(rightReg, rightType)
						cmpRes := c.nextReg()
						c.emit("  %s = call i32 @xt_compare(i64 %s, i64 %s)", cmpRes, lXt, rXt)
						if e.Operator == "==" || e.Operator == "是" {
							c.emit("  %s = icmp eq i32 %s, 0", fbCond, cmpRes)
						} else {
							c.emit("  %s = icmp ne i32 %s, 0", fbCond, cmpRes)
						}
					}
					fbRes = c.nextReg()
					c.emit("  %s = select i1 %s, i64 4, i64 2", fbRes, fbCond)
				} else {
					// Arithmetic operators
					lRaw := c.ensureRawI64(leftReg, leftType)
					rRaw := c.ensureRawI64(rightReg, rightType)
					var op string
					switch e.Operator {
					case "+":
						op = "add"
					case "-":
						op = "sub"
					case "*":
						op = "mul"
					case "/":
						op = "sdiv"
					case "%":
						op = "srem"
					}
					fbRaw := c.nextReg()
					c.emit("  %s = %s i64 %s, %s", fbRaw, op, lRaw, rRaw)
					fbRes = c.ensureI64(fbRaw, "raw_i64")
				}
				c.emit("  store i64 %s, i64* %s", fbRes, resAddr)
				c.emit("  br label %%%s", mergeLabel)

				c.emit("%s:", mergeLabel)
				finalRes := c.nextReg()
				c.emit("  %s = load i64, i64* %s", finalRes, resAddr)
				c.emit("  call void @xt_release(i64 %s)", keyXt)
				if !c.isScalarType(leftType) {
					c.emit("  call void @xt_release(i64 %s)", objXt)
				}
				return finalRes, "i64", ""
			}
		}
		if e.Operator == "&" {
			lXt := c.ensureI64(leftReg, leftType)
			rXt := c.ensureI64(rightReg, rightType)
			lStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i64 %s)", lStr, lXt)
			rStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i64 %s)", rStr, rXt)
			res := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_concat(%%XTString* %s, %%XTString* %s)", res, lStr, rStr)
			if !c.isScalarType(leftType) {
				c.emit("  call void @xt_release(i64 %s)", lXt)
			}
			if !c.isScalarType(rightType) {
				c.emit("  call void @xt_release(i64 %s)", rXt)
			}
			lI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", lI64, lStr)
			c.emit("  call void @xt_release(i64 %s)", lI64)
			rI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", rI64, rStr)
			c.emit("  call void @xt_release(i64 %s)", rI64)
			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resI64, res)
			return resI64, "i64", ""
		}
		leftRaw := c.ensureRawI64(leftReg, leftType)
		rightRaw := c.ensureRawI64(rightReg, rightType)
		var op string
		switch e.Operator {
		case "+":
			op = "add"
		case "-":
			op = "sub"
		case "*":
			op = "mul"
		case "/":
			op = "sdiv"
		case "%":
			op = "srem"
		case "..":
			lXt := c.ensureI64(leftReg, leftType)
			rXt := c.ensureI64(rightReg, rightType)
			res := c.nextReg()
			c.emit("  %s = call i64 @xt_array_range(i64 %s, i64 %s)", res, lXt, rXt)
			if !c.isScalarType(leftType) {
				c.emit("  call void @xt_release(i64 %s)", lXt)
			}
			if !c.isScalarType(rightType) {
				c.emit("  call void @xt_release(i64 %s)", rXt)
			}
			return res, "i64", ""
		}
		if op != "" {
			reg := c.nextReg()
			c.emit("  %s = %s i64 %s, %s", reg, op, leftRaw, rightRaw)
			if !c.isScalarType(leftType) {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
			}
			if !c.isScalarType(rightType) {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
			}
			return reg, "raw_i64", ""
		}
		cond := c.nextReg()
		switch e.Operator {
		case "==", "!=":
			if leftType == "raw_i64" && rightType == "raw_i64" {
				if e.Operator == "==" {
					c.emit("  %s = icmp eq i64 %s, %s", cond, leftReg, rightReg)
				} else {
					c.emit("  %s = icmp ne i64 %s, %s", cond, leftReg, rightReg)
				}
			} else {
				lXt := c.ensureI64(leftReg, leftType)
				rXt := c.ensureI64(rightReg, rightType)
				cmpRes := c.nextReg()
				c.emit("  %s = call i32 @xt_compare(i64 %s, i64 %s)", cmpRes, lXt, rXt)
				if e.Operator == "==" {
					c.emit("  %s = icmp eq i32 %s, 0", cond, cmpRes)
				} else {
					c.emit("  %s = icmp ne i32 %s, 0", cond, cmpRes)
				}
			}
		case "<", ">", "<=", ">=":
			if leftType == "raw_i64" && rightType == "raw_i64" {
				var cmpOp string
				switch e.Operator {
				case "<":
					cmpOp = "slt"
				case ">":
					cmpOp = "sgt"
				case "<=":
					cmpOp = "sle"
				case ">=":
					cmpOp = "sge"
				}
				c.emit("  %s = icmp %s i64 %s, %s", cond, cmpOp, leftReg, rightReg)
			} else {
				lXt := c.ensureI64(leftReg, leftType)
				rXt := c.ensureI64(rightReg, rightType)
				cmpRes := c.nextReg()
				c.emit("  %s = call i32 @xt_compare(i64 %s, i64 %s)", cmpRes, lXt, rXt)
				var cmpOp string
				switch e.Operator {
				case "<":
					cmpOp = "slt"
				case ">":
					cmpOp = "sgt"
				case "<=":
					cmpOp = "sle"
				case ">=":
					cmpOp = "sge"
				}
				c.emit("  %s = icmp %s i32 %s, 0", cond, cmpOp, cmpRes)
			}
		}
		reg := c.nextReg()
		c.emit("  %s = select i1 %s, i64 4, i64 2", reg, cond)
		if !c.isScalarType(leftType) {
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
		}
		if !c.isScalarType(rightType) {
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
		}
		return reg, "i64", ""
	}
	return "0", "i64", ""
}

func (c *LLVMCompiler) compileLogicalAnd(e *ast.InfixExpression) (string, string, string) {
	leftReg, leftType, _ := c.compileExpression(e.Left)
	lI1 := leftReg
	if leftType == "i64" {
		lI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", lI1, leftReg)
	}
	rhsLabel := c.nextLabel("and.rhs")
	falseLabel := c.nextLabel("and.false")
	endLabel := c.nextLabel("and.end")
	c.emit("  br i1 %s, label %%%s, label %%%s", lI1, rhsLabel, falseLabel)
	c.emit("%s:", falseLabel)
	if !c.isScalarType(leftType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
	}
	c.emit("  br label %%%s", endLabel)
	c.emit("%s:", rhsLabel)
	if !c.isScalarType(leftType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
	}
	rightReg, rightType, _ := c.compileExpression(e.Right)
	rI1 := rightReg
	if rightType == "i64" {
		rI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", rI1, rightReg)
	}
	rhsBlock := c.currentLabel
	if !c.isScalarType(rightType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
	}
	c.emit("  br label %%%s", endLabel)
	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = phi i1 [ false, %%%s ], [ %s, %%%s ]", resReg, falseLabel, rI1, rhsBlock)
	reg := c.nextReg()
	c.emit("  %s = select i1 %s, i64 4, i64 2", reg, resReg)
	return reg, "i64", ""
}

func (c *LLVMCompiler) compileLogicalOr(e *ast.InfixExpression) (string, string, string) {
	leftReg, leftType, _ := c.compileExpression(e.Left)
	lI1 := leftReg
	if leftType == "i64" {
		lI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", lI1, leftReg)
	}
	rhsLabel := c.nextLabel("or.rhs")
	trueLabel := c.nextLabel("or.true")
	endLabel := c.nextLabel("or.end")
	c.emit("  br i1 %s, label %%%s, label %%%s", lI1, trueLabel, rhsLabel)
	c.emit("%s:", trueLabel)
	if !c.isScalarType(leftType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
	}
	c.emit("  br label %%%s", endLabel)
	c.emit("%s:", rhsLabel)
	if !c.isScalarType(leftType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(leftReg, leftType))
	}
	rightReg, rightType, _ := c.compileExpression(e.Right)
	rI1 := rightReg
	if rightType == "i64" {
		rI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", rI1, rightReg)
	}
	rhsBlock := c.currentLabel
	if !c.isScalarType(rightType) {
		c.emit("  call void @xt_release(i64 %s)", c.ensureI64(rightReg, rightType))
	}
	c.emit("  br label %%%s", endLabel)
	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = phi i1 [ true, %%%s ], [ %s, %%%s ]", resReg, trueLabel, rI1, rhsBlock)
	reg := c.nextReg()
	c.emit("  %s = select i1 %s, i64 4, i64 2", reg, resReg)
	return reg, "i64", ""
}

func (c *LLVMCompiler) compileMatchStatement(s *ast.MatchStatement) {
	c.enterScope()
	defer c.exitScope(false)
	valReg, valType, _ := c.compileExpression(s.Value)
	vI64 := c.ensureI64(valReg, valType)
	mergeLabel := c.nextLabel("match.merge")
	for _, cas := range s.Cases {
		nextCaseLabel := c.nextLabel("match.next")
		bodyLabel := c.nextLabel("match.body")
		if ident, ok := cas.Pattern.(*ast.Identifier); ok && ident.Value == "_" {
			c.emit("  br label %%%s", bodyLabel)
			c.emit("%s:", bodyLabel)
		} else if prefix, ok := cas.Pattern.(*ast.PrefixExpression); ok && prefix.Operator == "是" {
			if ident, ok := prefix.Right.(*ast.Identifier); ok {
				if ident.Value == "成功" || ident.Value == "失败" {
					objPtr := c.nextReg()
					c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, vI64)
					typeIdPtr := c.nextReg()
					c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
					typeId := c.nextReg()
					c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)
					isResult := c.nextReg()
					c.emit("  %s = icmp eq i32 %s, 8", isResult, typeId)
					resLabel := c.nextLabel("match.is_result")
					c.emit("  br i1 %s, label %%%s, label %%%s", isResult, resLabel, nextCaseLabel)
					c.emit("%s:", resLabel)
					resPtr := c.nextReg()
					c.emit("  %s = bitcast %%XTObject* %s to %%XTResult*", resPtr, objPtr)
					isSuccPtr := c.nextReg()
					c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 2", isSuccPtr, resPtr)
					isSucc := c.nextReg()
					c.emit("  %s = load i1, i1* %s", isSucc, isSuccPtr)
					condReg := c.nextReg()
					if ident.Value == "成功" {
						c.emit("  %s = icmp eq i1 %s, 1", condReg, isSucc)
					} else {
						c.emit("  %s = icmp eq i1 %s, 0", condReg, isSucc)
					}
					c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, nextCaseLabel)
					c.emit("%s:", bodyLabel)
				} else {
					c.emit("  br label %%%s", nextCaseLabel)
					c.emit("%s:", bodyLabel)
				}
			} else {
				c.emit("  br label %%%s", nextCaseLabel)
				c.emit("%s:", bodyLabel)
			}
		} else {
			patReg, patType, _ := c.compileExpression(cas.Pattern)
			condReg := c.nextReg()
			if valType != "raw_i64" || patType != "raw_i64" {
				lXt := vI64
				pXt := c.ensureI64(patReg, patType)
				cmpRes := c.nextReg()
				c.emit("  %s = call i32 @xt_compare(i64 %s, i64 %s)", cmpRes, lXt, pXt)
				c.emit("  %s = icmp eq i32 %s, 0", condReg, cmpRes)
			} else {
				c.emit("  %s = icmp eq i64 %s, %s", condReg, vI64, patReg)
			}
			cleanupLabel := c.nextLabel("match.cleanup")
			c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, cleanupLabel)
			c.emit("%s:", cleanupLabel)
			if patType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(patReg, patType))
			}
			c.emit("  br label %%%s", nextCaseLabel)
			c.emit("%s:", bodyLabel)
			if patType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(patReg, patType))
			}
		}
		for _, stmt := range cas.Body {
			c.compileStatement(stmt)
		}
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", nextCaseLabel)
	}
	c.emit("  br label %%%s", mergeLabel)
	c.emit("%s:", mergeLabel)
}

func (c *LLVMCompiler) compileForStatement(s *ast.ForStatement) {
	c.enterScope()
	defer c.exitScope(false)
	iterReg, iterType, _ := c.compileExpression(s.Iterable)
	iI64 := c.ensureI64(iterReg, iterType)
	objPtr := c.nextReg()
	c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, iI64)
	typeIdPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
	typeId := c.nextReg()
	c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)
	isDict := c.nextReg()
	c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId)

	dictCheckBlock := c.currentLabel
	dictConvLabel := c.nextLabel("for.dict_conv")
	dictMergeLabel := c.nextLabel("for.dict_merge")
	c.emit("  br i1 %s, label %%%s, label %%%s", isDict, dictConvLabel, dictMergeLabel)
	c.emit("%s:", dictConvLabel)
	dPtrConv := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtrConv, objPtr)
	keysArr := c.nextReg()
	c.emit("  %s = call %%XTArray* @xt_dict_keys(%%XTDict* %s)", keysArr, dPtrConv)
	keysI64 := c.nextReg()
	c.emit("  %s = ptrtoint %%XTArray* %s to i64", keysI64, keysArr)
	dictConvEndBlock := c.currentLabel
	c.emit("  br label %%%s", dictMergeLabel)
	c.emit("%s:", dictMergeLabel)
	actualIterI64 := c.nextReg()
	c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ]", actualIterI64, keysI64, dictConvEndBlock, iI64, dictCheckBlock)
	actualObjPtr := c.nextReg()
	c.emit("  %s = inttoptr i64 %s to %%XTObject*", actualObjPtr, actualIterI64)
	actualTypeIdPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", actualTypeIdPtr, actualObjPtr)
	actualTypeId := c.nextReg()
	c.emit("  %s = load i32, i32* %s", actualTypeId, actualTypeIdPtr)
	for _, v := range s.Variables {
		varAddr := "%\"" + v.Value + "\""
		c.emitAlloca("%s = alloca i64", varAddr)
		c.emit("  store i64 0, i64* %s", varAddr) // 显式初始化为 0 (空)
		c.symbolTable[v.Value] = SymbolInfo{AddrReg: varAddr, Type: "i64"}
		c.trackObject(varAddr)
	}
	condLabel := c.nextLabel("for.cond")
	bodyLabel := c.nextLabel("for.body")
	endLabel := c.nextLabel("for.end")
	idxAddr := c.nextReg()
	c.emitAlloca("%s = alloca i64", idxAddr)
	c.emit("  store i64 0, i64* %s", idxAddr)
	c.emit("  br label %%%s", condLabel)
	c.emit("%s:", condLabel)
	idxReg := c.nextReg()
	c.emit("  %s = load i64, i64* %s", idxReg, idxAddr)
	lenArrLabel := c.nextLabel("for.len_arr")
	lenStrLabel := c.nextLabel("for.len_str")
	lenMergeLabel := c.nextLabel("for.len_merge")
	isArrForLen := c.nextReg()
	c.emit("  %s = icmp eq i32 %s, 5", isArrForLen, actualTypeId)
	c.emit("  br i1 %s, label %%%s, label %%%s", isArrForLen, lenArrLabel, lenStrLabel)
	c.emit("%s:", lenArrLabel)
	aPtrLen := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtrLen, actualObjPtr)
	lenPtrArr := c.nextReg()
	c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 3", lenPtrArr, aPtrLen)
	lenValArrRaw := c.nextReg()
	c.emit("  %s = load i64, i64* %s", lenValArrRaw, lenPtrArr)
	c.emit("  br label %%%s", lenMergeLabel)
	c.emit("%s:", lenStrLabel)
	sPtrLen := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", sPtrLen, actualObjPtr)
	lenPtrStr := c.nextReg()
	c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", lenPtrStr, sPtrLen)
	lenValStrRaw := c.nextReg()
	c.emit("  %s = load i64, i64* %s", lenValStrRaw, lenPtrStr)
	c.emit("  br label %%%s", lenMergeLabel)
	c.emit("%s:", lenMergeLabel)
	lenReg := c.nextReg()
	c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ]", lenReg, lenValArrRaw, lenArrLabel, lenValStrRaw, lenStrLabel)
	condReg := c.nextReg()
	c.emit("  %s = icmp slt i64 %s, %s", condReg, idxReg, lenReg)
	c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, endLabel)
	c.emit("%s:", bodyLabel)
	c.enterScope()
	elemArrLabel := c.nextLabel("for.elem_arr")
	elemStrLabel := c.nextLabel("for.elem_str")
	elemMergeLabel := c.nextLabel("for.elem_merge")
	c.emit("  br i1 %s, label %%%s, label %%%s", isArrForLen, elemArrLabel, elemStrLabel)
	c.emit("%s:", elemArrLabel)
	aPtrElem := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtrElem, actualObjPtr)
	elemPtrPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, aPtrElem)
	elemsPtr := c.nextReg()
	c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
	elemPtr := c.nextReg()
	c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
	valArr := c.nextReg()
	c.emit("  %s = load i8*, i8** %s", valArr, elemPtr)
	xtValArr := c.nextReg()
	c.emit("  %s = ptrtoint i8* %s to i64", xtValArr, valArr)
	c.emit("  call void @xt_retain(i64 %s)", xtValArr)
	c.emit("  br label %%%s", elemMergeLabel)
	c.emit("%s:", elemStrLabel)
	sPtrElem := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", sPtrElem, actualObjPtr)
	strFromChar := c.nextReg()
	c.emit("  %s = call %%XTString* @xt_string_next_char(%%XTString* %s, i64* %s)", strFromChar, sPtrElem, idxAddr)
	xtValStr := c.nextReg()
	c.emit("  %s = ptrtoint %%XTString* %s to i64", xtValStr, strFromChar)
	c.emit("  br label %%%s", elemMergeLabel)
	c.emit("%s:", elemMergeLabel)
	valPtr := c.nextReg()
	c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ]", valPtr, xtValArr, elemArrLabel, xtValStr, elemStrLabel)
	if len(s.Variables) == 1 {
		varAddr := "%\"" + s.Variables[0].Value + "\""
		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, varAddr)
		c.emit("  call void @xt_release(i64 %s)", oldVal)
		c.emit("  store i64 %s, i64* %s", valPtr, varAddr)
	} else if len(s.Variables) >= 2 {
		valAddrVar := "%\"" + s.Variables[0].Value + "\""
		idxAddrVar := "%\"" + s.Variables[1].Value + "\""
		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, valAddrVar)
		c.emit("  call void @xt_release(i64 %s)", oldVal)
		oldIdx := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldIdx, idxAddrVar)
		c.emit("  call void @xt_release(i64 %s)", oldIdx)
		c.emit("  store i64 %s, i64* %s", valPtr, valAddrVar)
		c.emit("  store i64 %s, i64* %s", c.ensureI64(idxReg, "raw_i64"), idxAddrVar)
	}
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.exitScope(false)

	incrArrLabel := c.nextLabel("for.incr_arr")
	c.emit("  br i1 %s, label %%%s, label %%%s", isArrForLen, incrArrLabel, condLabel)
	c.emit("%s:", incrArrLabel)
	newIdx := c.nextReg()
	c.emit("  %s = add i64 %s, 1", newIdx, idxReg)
	c.emit("  store i64 %s, i64* %s", newIdx, idxAddr)
	c.emit("  br label %%%s", condLabel)
	c.emit("%s:", endLabel)
}

func (c *LLVMCompiler) compileComplexAssignStatement(s *ast.ComplexAssignStatement) {
	valReg, valType, _ := c.compileExpression(s.Right)
	switch left := s.Left.(type) {
	case *ast.Identifier:
		if sym, ok := c.symbolTable[left.Value]; ok {
			// 只有局部变量且新值为标量时，才尝试优化
			isScalar := c.isScalarType(valType) && (c.currentFunc != "" || c.currentClass != "") && !sym.IsGlobal

			var xtVal string
			if isScalar {
				xtVal = valReg
			} else {
				xtVal = c.ensureI64(valReg, valType)
			}

			// 如果旧变量不是标量类型，需要 release
			if !c.isScalarType(sym.Type) {
				oldVal := c.nextReg()
				c.emit("  %s = load i64, i64* %s", oldVal, sym.AddrReg)
				c.emit("  call void @xt_release(i64 %s)", oldVal)
			}

			c.emit("  store i64 %s, i64* %s", xtVal, sym.AddrReg)
			sym.Type = "i64"
			if isScalar {
				sym.Type = valType
			}
			c.symbolTable[left.Value] = sym
		} else {
			xtVal := c.ensureI64(valReg, valType)
			addrReg := "@\"" + left.Value + "\""
			if !c.declaredGlobals[left.Value] {
				c.globalOutput.WriteString(fmt.Sprintf("%s = global i64 0\n", addrReg))
				c.declaredGlobals[left.Value] = true
			}
			c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
		}
	case *ast.IndexExpression:
		xtVal := c.ensureI64(valReg, valType)
		leftReg, leftType, _ := c.compileExpression(left.Left)
		idxReg, idxType, _ := c.compileExpression(left.Index)
		objPtr := c.nextReg()
		if leftType == "i64" {
			c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, leftReg)
		} else {
			c.emit("  %s = bitcast %s %s to %%XTObject*", objPtr, leftType, leftReg)
		}
		typeIdPtr := c.nextReg()
		c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
		typeId := c.nextReg()
		c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)
		isDict := c.nextReg()
		c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId)
		dictLabel := c.nextLabel("idx_asg.dict")
		arrayLabel := c.nextLabel("idx_asg.arr")
		mergeLabel := c.nextLabel("idx_asg.m")
		c.emit("  br i1 %s, label %%%s, label %%%s", isDict, dictLabel, arrayLabel)
		c.emit("%s:", dictLabel)
		idxXt := c.ensureI64(idxReg, idxType)
		c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", leftReg, idxXt, xtVal)
		c.emit("  call void @xt_release(i64 %s)", leftReg)
		c.emit("  call void @xt_release(i64 %s)", idxXt)
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", arrayLabel)
		aPtr := c.nextReg()
		c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtr, objPtr)
		idxUntag := c.nextReg()
		c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, c.ensureI64(idxReg, idxType))
		elemPtrPtr := c.nextReg()
		c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, aPtr)
		elemsPtr := c.nextReg()
		c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
		elemPtr := c.nextReg()
		c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxUntag)
		elemPtrTyped := c.nextReg()
		c.emit("  %s = bitcast i8** %s to i64*", elemPtrTyped, elemPtr)
		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, elemPtrTyped)
		c.emit("  call void @xt_release(i64 %s)", oldVal)
		c.emit("  store i64 %s, i64* %s", xtVal, elemPtrTyped)
		c.emit("  br label %%%s", mergeLabel)
		c.emit("%s:", mergeLabel)
		c.emit("  call void @xt_release(i64 %s)", leftReg)
	case *ast.MemberCallExpression:
		xtVal := c.ensureI64(valReg, valType)
		objReg, objType, _ := c.compileExpression(left.Object)
		objXt := c.ensureI64(objReg, objType)
		keyAlias := c.addString(left.Member.Value)
		keyRaw := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0", keyRaw, len(left.Member.Value)+1, len(left.Member.Value)+1, keyAlias)
		keyObj := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", keyObj, keyRaw)
		keyXt := c.nextReg()
		c.emit("  %s = ptrtoint %%XTString* %s to i64", keyXt, keyObj)
		c.emit("  call void @xt_dict_set(i64 %s, i64 %s, i64 %s)", objXt, keyXt, xtVal)
		c.emit("  call void @xt_release(i64 %s)", objXt)
		c.emit("  call void @xt_release(i64 %s)", keyXt)
	}
}

func (c *LLVMCompiler) compileExternalFunctionStatement(s *ast.ExternalFunctionStatement) {
	retType := "i64"
	switch s.ReturnType {
	case "整", "整数":
		retType = "i64"
	case "小数":
		retType = "double"
	case "逻", "逻辑":
		retType = "i1"
	case "字", "字符串":
		retType = "i8*"
	case "空":
		retType = "void"
	}

	params := []string{}
	for range s.Parameters {
		params = append(params, "i64")
	}
	paramStr := strings.Join(params, ", ")

	c.globalOutput.WriteString(fmt.Sprintf("declare %s @\"%s\"(%s)\n", retType, s.Name.Value, paramStr))
}

func (c *LLVMCompiler) compileTypeDefinitionStatement(s *ast.TypeDefinitionStatement) {
	classInfo := &ClassInfo{Name: s.Name.Value, Methods: make(map[string]string), MethodArgsCount: make(map[string]int)}
	if s.Parent != nil {
		classInfo.Parent = s.Parent.Value
		if pInfo, ok := c.classes[s.Parent.Value]; ok {
			classInfo.Fields = append(classInfo.Fields, pInfo.Fields...)
			for name, fn := range pInfo.Methods {
				classInfo.Methods[name] = fn
				classInfo.MethodArgsCount[name] = pInfo.MethodArgsCount[name]
			}
		}
	}
	c.classes[s.Name.Value] = classInfo
	oldClass := c.currentClass
	c.currentClass = s.Name.Value
	for _, stmt := range s.Block {
		if v, ok := stmt.(*ast.VarStatement); ok && v != nil {
			classInfo.Fields = append(classInfo.Fields, v.Name.Value)
		}
		if m, ok := stmt.(*ast.FunctionStatement); ok && m != nil {
			funcName := fmt.Sprintf("@\"%s_%s\"", s.Name.Value, m.Name.Value)
			classInfo.Methods[m.Name.Value] = funcName
			classInfo.MethodArgsCount[m.Name.Value] = len(m.Parameters)
		}
	}
	for _, stmt := range s.Block {
		if m, ok := stmt.(*ast.FunctionStatement); ok && m != nil {
			c.compileMethodStatement(s.Name.Value, m)
		}
	}
	c.currentClass = oldClass
}

func (c *LLVMCompiler) compileMethodStatement(className string, s *ast.FunctionStatement) {
	oldOutput := c.output
	c.output = bytes.Buffer{}
	oldAllocaOutput := c.allocaOutput
	c.allocaOutput = bytes.Buffer{}
	oldFunc := c.currentFunc
	c.currentFunc = s.Name.Value
	oldTable := make(map[string]SymbolInfo)
	for k, v := range c.symbolTable {
		oldTable[k] = v
	}
	oldScopeStack := c.scopeStack
	c.scopeStack = [][]string{}
	funcName := fmt.Sprintf("@\"%s_%s\"", className, s.Name.Value)
	params := []string{"i64 %\"this_arg\""}
	for _, p := range s.Parameters {
		params = append(params, "i64 %\""+p.Name.Value+"_arg\"")
	}
	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")
	c.currentLabel = "entry"
	c.enterScope()
	thisAddr := "%\"此\""
	c.emitAlloca("%s = alloca i64", thisAddr)
	c.emit("  store i64 %%\"this_arg\", i64* %s", thisAddr)
	c.emit("  call void @xt_retain(i64 %%\"this_arg\")")
	c.symbolTable["此"] = SymbolInfo{AddrReg: thisAddr, Type: "i64", ClassName: className}
	c.trackObject(thisAddr)
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emitAlloca("%s = alloca i64", addrReg)
		c.emit("  store i64 %%\"%s_arg\", i64* %s", p.Name.Value, addrReg)
		c.emit("  call void @xt_retain(i64 %%\"%s_arg\")", p.Name.Value)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64"}
		c.trackObject(addrReg)
	}
	for _, stmt := range s.Body {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  ret i64 0")
	c.emit("}")
	funcBody := c.output.String()
	funcAllocas := c.allocaOutput.String()
	parts := strings.SplitN(funcBody, "entry:\n", 2)
	if len(parts) == 2 {
		c.funcOutput.WriteString(parts[0] + "entry:\n" + funcAllocas + parts[1])
	} else {
		c.funcOutput.WriteString(funcBody)
	}
	c.output = oldOutput
	c.allocaOutput = oldAllocaOutput
	c.currentFunc = oldFunc
	c.symbolTable = oldTable
	c.scopeStack = oldScopeStack
}
