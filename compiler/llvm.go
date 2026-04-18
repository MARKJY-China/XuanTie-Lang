package compiler

import (
	"bytes"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
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
	Name    string
	Fields  map[string]int
	Methods map[string]string // 映射方法名到 LLVM 函数名
	Parent  string
}

type LLVMCompiler struct {
	program        *ast.Program
	output         bytes.Buffer
	allocaOutput   bytes.Buffer // 存储当前函数的所有 alloca
	funcOutput     bytes.Buffer
	globalOutput   bytes.Buffer // 存储全局变量定义的 IR
	regCount       int
	labelCount     int
	symbolTable    map[string]SymbolInfo
	strings        map[string]string
	classes        map[string]*ClassInfo
	scopeStack     [][]string // 每层作用域需要 release 的寄存器列表
	currentFunc    string     // 为空表示在 main 中
	currentClass   string     // 当前正在转译的类名
	currentLabel   string     // 最近一个基本块标签
	filePath       string     // 当前正在转译的文件路径
	breakLabels    []string   // break 目标标签栈
	continueLabels []string   // continue 目标标签栈
	loopDepths     []int      // 循环开始时的 scopeStack 深度栈
	visitedImports map[string]bool
}

func NewLLVMCompiler(program *ast.Program) *LLVMCompiler {
	return &LLVMCompiler{
		program:        program,
		symbolTable:    make(map[string]SymbolInfo),
		strings:        make(map[string]string),
		classes:        make(map[string]*ClassInfo),
		filePath:       program.FilePath,
		visitedImports: make(map[string]bool),
	}
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
	c.emit("; XuanTie v0.13.3 LLVM Backend")
	c.emit("target datalayout = \"e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128\"")
	c.emit("target triple = \"x86_64-pc-windows-msvc\"")
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
	c.emit("%%XTString = type { i32, i32, i8*, i64 }")
	c.emit("%%XTArray = type { i32, i32, i8**, i64, i64 }")
	c.emit("%%XTDict = type { i32, i32, i8***, i64, i64 }")
	c.emit("declare %%XTArray* @xt_dict_keys(%%XTDict*)")
	c.emit("%%XTInstance = type { i32, i32, i8*, i64*, i64 }")
	c.emit("%%XTResult = type { i32, i32, i1, i64, i64 }")
	c.emit("declare void @xt_init()")
	c.emit("declare void @xt_print_int(i64)")
	c.emit("declare void @xt_print_string(%%XTString*)")
	c.emit("declare void @xt_print_bool(i1)")
	c.emit("declare void @xt_print_float(double)")
	c.emit("declare void @xt_print_value(i64)")
	c.emit("declare i64 @xt_int_new(i64)")
	c.emit("declare i8* @xt_float_new(double)")
	c.emit("declare i64 @xt_bool_new(i1)")
	c.emit("declare i64 @xt_func_new(i8*)")
	c.emit("declare %%XTString* @xt_string_new(i8*)")
	c.emit("declare i64 @xt_string_get_char(i64, i64)")
	c.emit("declare %%XTString* @xt_string_from_char(i8)")
	c.emit("declare %%XTString* @xt_string_next_char(%%XTString*, i64*)")
	c.emit("declare %%XTArray* @xt_array_new(i64)")
	c.emit("declare void @xt_array_append(%%XTArray*, i64)")
	c.emit("declare %%XTString* @xt_array_join(%%XTArray*, %%XTString*)")
	c.emit("declare %%XTDict* @xt_dict_new(i64)")
	c.emit("declare void @xt_dict_set(%%XTDict*, i64, i64)")
	c.emit("declare i64 @xt_dict_get(%%XTDict*, i64)")
	c.emit("declare %%XTInstance* @xt_instance_new(i8*, i64)")
	c.emit("declare i8* @xt_result_new(i1, i8*, i8*)")
	c.emit("declare %%XTString* @xt_string_concat(%%XTString*, %%XTString*)")
	c.emit("declare %%XTString* @xt_string_substring(%%XTString*, i64, i64)")
	c.emit("declare i32 @xt_string_contains(%%XTString*, %%XTString*)")
	c.emit("declare %%XTString* @xt_int_to_string(i64)")
	c.emit("declare %%XTString* @xt_obj_to_string(i64)")
	c.emit("declare void @xt_retain(i64)")
	c.emit("declare void @xt_release(i64)")
	c.emit("declare i64 @xt_to_int(i64)")
	c.emit("declare i32 @xt_eq(i8*, i8*)")
	c.emit("declare i32 @xt_compare(i8*, i8*)")
	c.emit("declare i64 @xt_file_read(i64)")
	c.emit("declare i64 @xt_file_write(i64, i64)")
	c.emit("")

	// 4. 写入全局变量定义
	c.output.Write(c.globalOutput.Bytes())
	c.emit("")

	// 5. 写入自定义函数定义
	c.output.Write(c.funcOutput.Bytes())
	c.emit("")

	// 6. 主函数入口
	c.emit("define i32 @main() {")
	c.emit("entry:")
	c.currentLabel = "entry"
	c.emit("  call void @xt_init()")
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
			// 加载并 release
			// 我们需要知道变量类型，暂时假设都是 XTValue (i64)
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
	// 在 Tagged Pointer 架构下，i64 已经是 XTValue (可能是 tagged int/bool/null)
	// 指针类型需要 bitcast 为 i8* (即 XTValue)
	if strings.HasSuffix(valType, "*") || valType == "ptr" || valType == "i8*" {
		if valType != "i8*" {
			reg := c.nextReg()
			c.emit("  %s = bitcast %s %s to i8*", reg, valType, valReg)
			return reg, "i8*"
		}
		return valReg, "i8*"
	}

	// 如果是 i1 (LLVM 的布尔)，转为 XTValue (4 或 2)
	if valType == "i1" {
		reg := c.nextReg()
		c.emit("  %s = select i1 %s, i64 4, i64 2", reg, valReg)
		// 注意：XTValue 目前在 LLVM 中是用 i64 表示的 tagged pointer，
		// 但 convertToObj 期望返回 i8*
		resReg := c.nextReg()
		c.emit("  %s = inttoptr i64 %s to i8*", resReg, reg)
		return resReg, "i8*"
	}

	// 如果是函数名，作为函数指针处理
	if valType == "函数名" {
		reg := c.nextReg()
		// 假设所有玄铁函数签名都是 i64 (...)
		c.emit("  %s = bitcast i64 (...)* @\"%s\" to i8*", reg, valReg)
		return reg, "i8*"
	}

	// 如果是 double，仍需要装箱 (目前暂时不支持 Tagged Float)
	if valType == "double" {
		reg := c.nextReg()
		c.emit("  %s = call i8* @xt_float_new(double %s)", reg, valReg)
		return reg, "i8*"
	}

	// 其他情况 (主要是 i64)，它已经是 XTValue，直接 bitcast 即可
	reg := c.nextReg()
	c.emit("  %s = inttoptr i64 %s to i8*", reg, valReg)
	return reg, "i8*"
}

func (c *LLVMCompiler) ensureI64(reg, typ string) string {
	if typ == "i64" {
		return reg
	}
	if typ == "raw_i64" {
		newReg := c.nextReg()
		// Box raw integer: (val << 1) | 1
		shifted := c.nextReg()
		c.emit("  %s = shl i64 %s, 1", shifted, reg)
		c.emit("  %s = or i64 %s, 1", newReg, shifted)
		return newReg
	}
	if typ == "i1" {
		newReg := c.nextReg()
		// LLVM i1 -> XuanTie Bool (4 for True, 2 for False)
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
		// 在这里统一将 ptr 转为 i64
		// 但是旧版 LLVM 可能不能直接 ptrtoint i8** 这种，先转 i8* 再转 i64
		if typ != "i8*" {
			i8Ptr := c.nextReg()
			c.emit("  %s = bitcast %s %s to i8*", i8Ptr, typ, reg)
			c.emit("  %s = ptrtoint i8* %s to i64", newReg, i8Ptr)
		} else {
			c.emit("  %s = ptrtoint %s %s to i64", newReg, typ, reg)
		}
		return newReg
	}
	return reg
}

func (c *LLVMCompiler) ensureRawI64(reg, typ string) string {
	if typ == "raw_i64" {
		return reg
	}
	if typ == "i64" {
		newReg := c.nextReg()
		// Unbox tagged integer: val >> 1
		c.emit("  %s = ashr i64 %s, 1", newReg, reg)
		return newReg
	}
	// For other types like ptr, fallback to converting them to i64 then unboxing
	xtVal := c.ensureI64(reg, typ)
	newReg := c.nextReg()
	c.emit("  %s = ashr i64 %s, 1", newReg, xtVal)
	return newReg
}

func (c *LLVMCompiler) compileStatement(stmt ast.Statement) {
	if stmt == nil {
		return
	}

	switch s := stmt.(type) {
	case *ast.PrintStatement:
		if s == nil {
			return
		}
		valReg, valType, _ := c.compileExpression(s.Value)
		// 统一转换为 XTValue (i64) 并调用 xt_print_value
		xtValReg := c.ensureI64(valReg, valType)
		c.emit("  call void @xt_print_value(i64 %s)", xtValReg)

		// 打印后释放该临时对象
		c.emit("  call void @xt_release(i64 %s)", xtValReg)
	case *ast.VarStatement:
		if s == nil {
			return
		}
		valReg, valType, valClass := c.compileExpression(s.Value)
		xtVal := c.ensureI64(valReg, valType)

		if c.currentFunc == "" && c.currentClass == "" {
			// 全局变量
			addrReg := "@\"" + s.Name.Value + "\""
			if _, exists := c.symbolTable[s.Name.Value]; !exists {
				c.globalOutput.WriteString(fmt.Sprintf("%s = global i64 0\n", addrReg))
			}
			c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64", ClassName: valClass, IsGlobal: true}
		} else {
			if sym, ok := c.symbolTable[s.Name.Value]; ok && !sym.IsGlobal {
				// 已经被声明过，当作赋值处理（避免 LLVM multiple definition）
				oldVal := c.nextReg()
				c.emit("  %s = load i64, i64* %s", oldVal, sym.AddrReg)
				c.emit("  call void @xt_release(i64 %s)", oldVal)
				c.emit("  store i64 %s, i64* %s", xtVal, sym.AddrReg)
				// 不需要重新 alloca 和 trackObject
			} else {
				addrReg := "%\"" + s.Name.Value + "\""
				c.emitAlloca("%s = alloca i64", addrReg)
				c.emit("  store i64 %s, i64* %s", xtVal, addrReg)
				c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64", ClassName: valClass, IsGlobal: false}
				c.trackObject(addrReg)
			}
		}
		// 变量声明作为局部变量时，我们接管了 xtVal 这个 +1 引用，所以不需要手动 retain/release
	case *ast.AssignStatement:
		if s == nil {
			return
		}
		valReg, valType, className := c.compileExpression(s.Value)
		xtVal := c.ensureI64(valReg, valType)

		// 简单变量赋值
		if sym, ok := c.symbolTable[s.Name]; ok {
			// 先 load 旧值并释放
			oldVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", oldVal, sym.AddrReg)
			c.emit("  call void @xt_release(i64 %s)", oldVal)

			// 存入新值
			c.emit("  store i64 %s, i64* %s", xtVal, sym.AddrReg)
			sym.Type = "i64" // 始终存为 tagged object
			sym.ClassName = className
			c.symbolTable[s.Name] = sym
		} else {
			// 全局变量赋值
			c.emit("  store i64 %s, i64* @%s", xtVal, s.Name)
		}

	case *ast.ComplexAssignStatement:
		if s == nil {
			return
		}
		c.compileComplexAssignStatement(s)
	case *ast.IfStatement:
		if s == nil {
			return
		}
		c.compileIfStatement(s)
	case *ast.WhileStatement:
		if s == nil {
			return
		}
		c.compileWhileStatement(s)
	case *ast.LoopStatement:
		if s == nil {
			return
		}
		c.compileLoopStatement(s)
	case *ast.ForStatement:
		if s == nil {
			return
		}
		c.compileForStatement(s)
	case *ast.FunctionStatement:
		if s == nil {
			return
		}
		c.compileFunctionStatement(s)
	case *ast.TypeDefinitionStatement:
		if s == nil {
			return
		}
		c.compileTypeDefinitionStatement(s)
	case *ast.ReturnStatement:
		if s == nil {
			return
		}
		valReg, valType, _ := c.compileExpression(s.ReturnValue)

		// 转换返回值为 i64
		retVal := valReg
		if valType == "i1" {
			reg := c.nextReg()
			// LLVM i1 -> XuanTie Bool (4 for True, 2 for False)
			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, valReg)
			retVal = reg
		} else if valType == "raw_i64" {
			retVal = c.ensureI64(valReg, valType)
		} else if strings.HasSuffix(valType, "*") || valType == "i8*" || valType == "ptr" {
			reg := c.nextReg()
			c.emit("  %s = ptrtoint %s %s to i64", reg, valType, valReg)
			retVal = reg
		}

		// 重要：在 release 局部变量前，先 retain 返回值
		c.emit("  call void @xt_retain(i64 %s)", retVal)

		// 在返回前 release 所有局部变量
		c.exitScope(true)

		c.emit("  ret i64 %s", retVal)

		// 开启一个不可达的新块以防止后续的指令 (如 br) 导致 LLVM 结构错误
		deadLabel := c.nextLabel("deadcode")
		c.emit("%s:", deadLabel)
	case *ast.MatchStatement:
		if s == nil {
			return
		}
		c.compileMatchStatement(s)
	case *ast.ExpressionStatement:
		if s == nil {
			return
		}
		valReg, valType, _ := c.compileExpression(s.Expression)
		// 释放表达式产生的临时对象
		if valType != "raw_i64" {
			xtVal := c.ensureI64(valReg, valType)
			c.emit("  call void @xt_release(i64 %s)", xtVal)
		}
	case *ast.BreakStatement:
		if len(c.breakLabels) > 0 {
			target := c.breakLabels[len(c.breakLabels)-1]
			depth := c.loopDepths[len(c.loopDepths)-1]
			// break/continue 需要清空循环体内部开启的所有 scope
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

func (c *LLVMCompiler) compileIfStatement(s *ast.IfStatement) {
	condReg, condType, _ := c.compileExpression(s.Condition)
	condI1 := condReg
	if condType == "i64" {
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condReg)
		// 获得布尔值后立即释放条件表达式产生的临时对象
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

	// 计算后续分支的起始标签
	var nextLabel string
	if len(s.ElseIfs) > 0 {
		nextLabel = c.nextLabel("if.elseif")
	} else if len(s.ElseBlock) > 0 {
		nextLabel = c.nextLabel("if.else")
	} else {
		nextLabel = mergeLabel
	}

	c.emit("  br i1 %s, label %%%s, label %%%s", condI1, thenLabel, nextLabel)

	// Then block
	c.emit("%s:", thenLabel)
	c.enterScope()
	for _, stmt := range s.ThenBlock {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", mergeLabel)

	// ElseIf branches
	for i, eif := range s.ElseIfs {
		c.emit("%s:", nextLabel)

		eifCondReg, eifCondType, _ := c.compileExpression(eif.Condition)
		if eifCondType == "i64" {
			reg := c.nextReg()
			c.emit("  %s = icmp eq i64 %s, 4", reg, eifCondReg)
			// 释放
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
		// 决定下一个 elseif 或 else 或 merge 标签
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

	// Else block
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
		// 获得布尔值后立即释放条件表达式产生的临时对象
		c.emit("  call void @xt_release(i64 %s)", condReg)
	} else if condType != "raw_i64" && condType != "i1" {
		// condType is probably i8* or ptr, but the boolean is represented as tagged 4 or 2
		condI64 := c.ensureI64(condReg, condType)
		condI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", condI1, condI64)
		c.emit("  call void @xt_release(i64 %s)", condI64)
	} else if condType == "raw_i64" {
		// shouldn't normally be raw_i64 but just in case
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
	c.breakLabels = append(c.breakLabels, "loop.end."+bodyLabel)
	c.continueLabels = append(c.continueLabels, bodyLabel)
	c.loopDepths = append(c.loopDepths, len(c.scopeStack))

	c.enterScope()
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.exitScope(false)

	c.emit("  br label %%%s", bodyLabel)

	endLabel := "loop.end." + bodyLabel
	c.emit("%s:", endLabel)
	c.breakLabels = c.breakLabels[:len(c.breakLabels)-1]
	c.continueLabels = c.continueLabels[:len(c.continueLabels)-1]
	c.loopDepths = c.loopDepths[:len(c.loopDepths)-1]
}

func (c *LLVMCompiler) compileFunctionStatement(s *ast.FunctionStatement) {
	// 切换到函数输出缓冲区
	oldOutput := c.output
	c.output = bytes.Buffer{}
	oldAllocaOutput := c.allocaOutput
	c.allocaOutput = bytes.Buffer{}
	oldFunc := c.currentFunc
	c.currentFunc = s.Name.Value

	// 保存旧符号表和作用域栈
	oldTable := make(map[string]SymbolInfo)
	for k, v := range c.symbolTable {
		oldTable[k] = v
	}
	oldScopeStack := c.scopeStack
	c.scopeStack = [][]string{}

	funcName := "@\"" + s.Name.Value + "\""
	params := []string{}
	for _, p := range s.Parameters {
		// 统一使用 i64
		params = append(params, "i64 %\""+p.Name.Value+"_arg\"")
	}

	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")
	c.currentLabel = "entry"
	fmt.Fprintf(&c.output, "  ; METHOD ENTRY: %s\n", funcName)
	fmt.Fprintf(&c.output, "  ; FUNCTION ENTRY: %s\n", funcName)

	// 进入函数作用域
	c.enterScope()

	// 为参数分配本地内存
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emitAlloca("%s = alloca i64", addrReg)
		// 直接存储传入的 i64 寄存器
		c.emit("  store i64 %%\"%s_arg\", i64* %s", p.Name.Value, addrReg)
		// 参数作为局部变量，需要 retain 并加入作用域追踪
		c.emit("  call void @xt_retain(i64 %%\"%s_arg\")", p.Name.Value)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64"}
		c.trackObject(addrReg)
	}

	for _, stmt := range s.Body {
		c.compileStatement(stmt)
	}

	// 退出函数作用域
	c.exitScope(false)

	// 确保函数总是有返回
	c.emit("  ret i64 0")
	c.emit("}")

	funcBody := c.output.String()
	funcAllocas := c.allocaOutput.String()
	// 在 entry: 之后插入 alloca
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
		// 直接返回原生类型，不再提前装箱
		return fmt.Sprintf("%d", e.Value), "raw_i64", ""
	case *ast.FloatLiteral:
		return fmt.Sprintf("%f", e.Value), "double", ""
	case *ast.BooleanLiteral:
		// Tagged Boolean: True=4, False=2
		if e.Value {
			return "4", "i64", ""
		}
		return "2", "i64", ""
	case *ast.ImportExpression:
		// 解析导入的文件
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
			fmt.Fprintf(os.Stderr, "无法读取导入的文件 %s: %v\n", absPath, err)
			return "0", "i64", ""
		}

		l := lexer.New(string(data))
		p := parser.New(l)
		importProgram := p.ParseProgram()
		importProgram.FilePath = absPath

		if len(p.Errors()) > 0 {
			fmt.Fprintf(os.Stderr, "导入文件 %s 存在解析错误:\n", absPath)
			for _, msg := range p.Errors() {
				fmt.Fprintf(os.Stderr, "\t%s\n", msg)
			}
			os.Exit(1)
		}

		// 递归转译导入程序中的语句
		// 注意：我们需要保存并恢复当前的 filePath
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
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0",
			rawReg, len(e.Value)+1, len(e.Value)+1, alias)
		objReg := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", objReg, rawReg)

		// 产生的临时字符串对象需要由调用者负责释放
		return objReg, "%XTString*", ""
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
			c.emit("  %s = load %s, %s* %s", reg, info.Type, info.Type, info.AddrReg)

			// 检查是否全局变量（它存储的是未经 retain 的 i64）
			// 我们本地变量存的虽然也是拷贝，但是加载后作为表达式结果返回，需要 +1
			xtVal := c.ensureI64(reg, info.Type)
			c.emit("  call void @xt_retain(i64 %s)", xtVal)
			return xtVal, "i64", info.ClassName
		}

		// 尝试兜底作为全局函数名查找（函数指针支持，或者全局常量等）
		// 如果没找到，发出警告并返回空
		c.emit("  ; WARNING: 找不到变量: %s", e.Value)
		// 作为兜底返回一个以该标识符命名的全局函数指针，以便后面的 CallExpression 能够使用
		reg := c.nextReg()
		// 由于是在旧版 LLVM 环境中运行，我们返回 ptr/i8* 兼容类型
		// 实际上 ensureI64 里有对 ptr 的转换。为了绝对安全，我们在这里将其声明为 i64
		// 但是旧版 LLVM 中如果将 @xxx(函数指针) 用 ptrtoint 转成 i64, 必须知道具体函数签名
		// 但我们作为兜底并不知道，因此先转为通用的 i8* 然后转为 i64
		// 但是因为玄铁目前所有全局函数的签名都是 i64 返回值，且参数都是 i64
		// 我们可以假定它是一个接受任意多个 i64 参数的变长函数，或者简单地定义为一个最通用的类型
		// 由于我们在后面 CallExpression 中会根据实际参数列表重新强制转换签名，所以这里转换成 i8* 然后 ptrtoint 到 i64 是安全的
		ptrReg := c.nextReg()
		c.emit("  %s = bitcast i64 (...)* @\"%s\" to i8*", ptrReg, e.Value)
		c.emit("  %s = ptrtoint i8* %s to i64", reg, ptrReg)
		// 不管怎样兜底，统一按 raw_i64 处理，因为函数指针在玄铁不是 tagged obj
		// 但由于我们在很多地方直接假定 i64 是 tagged (通过 ensureI64 等)，这里将其标记为 raw_i64 以避免被当做对象处理
		// Wait, no, we need to pass it as a function pointer later. Let's mark it as raw_i64 so it won't be unboxed/boxed
		return reg, "i64", ""
	case *ast.PrefixExpression:
		rightReg, rightType, _ := c.compileExpression(e.Right)
		reg := c.nextReg()
		if e.Operator == "!" || e.Operator == "非" {
			// 先转为 i1
			cond := c.nextReg()
			if rightType == "i64" {
				// 对于 Tagged Boolean: True=4, False=2. 只有 4 是真。
				// 但通常约定 非零即真。
				c.emit("  %s = icmp ne i64 %s, 2", cond, rightReg) // 2 is False
			} else if strings.HasSuffix(rightType, "*") || rightType == "i8*" || rightType == "ptr" {
				c.emit("  %s = icmp ne %s %s, null", cond, rightType, rightReg)
			} else {
				c.emit("  %s = icmp ne %s %s, 0", cond, rightType, rightReg)
			}

			resI1 := c.nextReg()
			c.emit("  %s = xor i1 %s, 1", resI1, cond)

			// 转回 tagged i64 (True=4, False=2)
			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, resI1)

			// 释放计算用的 rightReg (+1)
			rightFinal := c.ensureI64(rightReg, rightType)
			c.emit("  call void @xt_release(i64 %s)", rightFinal)

			return reg, "i64", ""
		}
		if e.Operator == "-" {
			// Untag, negate, retag
			val := c.ensureI64(rightReg, rightType)
			untagged := c.nextReg()
			c.emit("  %s = ashr i64 %s, 1", untagged, val)
			neg := c.nextReg()
			c.emit("  %s = sub i64 0, %s", neg, untagged)
			shifted := c.nextReg()
			c.emit("  %s = shl i64 %s, 1", shifted, neg)
			c.emit("  %s = or i64 %s, 1", reg, shifted)

			// 释放
			c.emit("  call void @xt_release(i64 %s)", val)

			return reg, "i64", ""
		}
		return "0", "i64", ""
	case *ast.CallExpression:
		// 特殊处理内建的 "成功" 和 "失败"
		if ident, ok := e.Function.(*ast.Identifier); ok {
			if ident.Value == "成功" || ident.Value == "失败" {
				isSuccess := "1"
				if ident.Value == "失败" {
					isSuccess = "0"
				}
				valReg, valType, _ := c.compileExpression(e.Arguments[0])
				objReg, _ := c.convertToObj(valReg, valType)

				reg := c.nextReg()
				if ident.Value == "成功" {
					c.emit("  %s = call i8* @xt_result_new(i1 %s, i8* %s, i8* null)", reg, isSuccess, objReg)
				} else {
					c.emit("  %s = call i8* @xt_result_new(i1 %s, i8* null, i8* %s)", reg, isSuccess, objReg)
				}

				// xt_result_new 内部已经 retain，这里释放传递进入时的临时 +1 引用
				valXtVal := c.ensureI64(valReg, valType)
				c.emit("  call void @xt_release(i64 %s)", valXtVal)

				return reg, "i8*", ""
			}
		}

		funcName := ""
		fType := ""
		if ident, ok := e.Function.(*ast.Identifier); ok {
			funcName = "@\"" + ident.Value + "\""
		} else {
			// e.Function 不是 Identifier，可能是兜底返回的函数指针表达式
			fReg, fTypeOut, _ := c.compileExpression(e.Function)
			fType = fTypeOut
			if fType == "i8*" || fType == "ptr" || fType == "i64" || fType == "raw_i64" {
				funcName = fReg // 直接使用 ptr 或 i64，不需要再加 @
			} else {
				// 正常函数调用编译
				funcName = fReg
			}
		}

		// 检查是否为内置函数（以 xt_ 开头且没有 @ 前缀的，通常是在内置模块或者底层实现中）
		// 在我们的 AST 里，普通的函数调用会加上 @"名称"，如果是内建或者底层方法可能不会
		// 但是玄铁的全局函数目前编译后名字是 @"名字"
		isBuiltin := false
		if strings.HasPrefix(funcName, "@\"xt_") || strings.HasPrefix(funcName, "@xt_") || strings.HasPrefix(funcName, "xt_") || strings.HasPrefix(funcName, "%") {
			if !strings.HasPrefix(funcName, "%") {
				isBuiltin = true
			}
		}

		args := []string{}
		argRegs := []string{}
		for _, a := range e.Arguments {
			valReg, valType, _ := c.compileExpression(a)
			// 与方法调用对齐：我们将参数统一下降为 i64，然后传递
			xtVal := c.ensureI64(valReg, valType)
			argRegs = append(argRegs, xtVal)

			// 检查是否是内置的特殊函数调用，比如底层调用可能需要 i8*
			if isBuiltin {
				// 如果是内置函数，使用 convertToObj 因为底层期待 i8* 对象指针
				objReg2, _ := c.convertToObj(valReg, valType)
				args = append(args, "i8* "+objReg2)
			} else {
				// 普通的玄铁全局函数签名现在已经统一为 i64 参数
				args = append(args, "i64 "+xtVal)
			}
		}
		reg := c.nextReg()
		// 全局函数调用统一返回 i64
		// 修复可能产生的 @@ 前缀问题
		if !strings.HasPrefix(funcName, "@") {
			funcName = "@" + funcName
		}

		// 如果是通过函数指针调用的（兜底生成的），funcName 不会有 @" 前缀，而是像 %t123 或者只是个指针寄存器
		if strings.HasPrefix(funcName, "@%") {
			// 说明之前兜底成全局变量返回了 %t123
			funcName = strings.TrimPrefix(funcName, "@")

			// 将 i64 转回函数指针类型
			funcPtrReg := c.nextReg()
			// 修正类型：从 i64 强转为函数指针类型，且参数类型应该是 args 列表
			// args 中的内容如 "i64 %t123", 我们需要提取出类型部分
			argTypes := make([]string, len(args))
			for i, a := range args {
				argTypes[i] = strings.Split(a, " ")[0]
			}
			c.emit("  %s = inttoptr i64 %s to i64 (%s)*", funcPtrReg, funcName, strings.Join(argTypes, ", "))

			c.emit("  %s = call i64 %s(%s)", reg, funcPtrReg, strings.Join(args, ", "))
		} else if strings.HasPrefix(funcName, "%") {
			// 如果已经是寄存器了（比如 ptr 类型），不需要去掉 @
			// 直接使用寄存器调用（兼容 LLVM 15 ptr）
			// 在旧版 LLVM 中，函数指针调用必须提供显式的函数类型
			funcPtrReg := c.nextReg()
			argTypes := make([]string, len(args))
			for i, a := range args {
				argTypes[i] = strings.Split(a, " ")[0]
			}

			// 如果 funcName 本身就是 ptr 或者 i8*
			// 我们需要 bitcast 它
			// 但因为之前兜底统一返回了 i64，这里我们当做 i64 处理
			// 不过为了容错，如果前面的 compileExpression 意外返回了 ptr，我们需要 bitcast
			// 简单起见，我们统一处理：如果是函数调用返回寄存器，且它前面是被转成 i64 了的，就用 inttoptr
			// 由于目前编译器架构，兜底返回的确实是 i64，我们需要 inttoptr 到函数指针
			// 但是如果返回的是 i8*，就用 bitcast
			// 根据之前的修改，我们已经把兜底返回值改成 i64 了，这里用 inttoptr 就行

			// 修改：直接将返回的寄存器当作函数指针签名
			// 注意返回值类型，为了保持玄铁的特性，默认它是返回 i64 的函数
			c.emit("  %s = inttoptr i64 %s to i64 (%s)*", funcPtrReg, funcName, strings.Join(argTypes, ", "))

			// 修正对通过寄存器传递过来的兜底函数的调用。
			// 这里有个大坑：如果是动态函数调用，且它是普通的玄铁函数，它返回的一定是 i64，这是没问题的
			c.emit("  %s = call i64 %s(%s)", reg, funcPtrReg, strings.Join(args, ", "))
		} else {
			// 如果是内置函数，并且 funcName 已经被去掉了 @，我们需要检查
			if isBuiltin && !strings.HasPrefix(funcName, "@") {
				funcName = "@" + funcName
			}
			// 修正：确保内置函数（非指针调用）被调用时参数签名与声明一致
			// 对于内置函数，由于声明可能是 i8*，如果是 isBuiltin 并且不是指针寄存器
			if isBuiltin {
				// argTypes 在前面内置函数检查时被设置为 i8*，这里我们用 strings.Join(args) 直接传就可以
				// 但要注意我们刚才对 funcName 判断内置函数的逻辑
				// 因为旧版 LLVM 要求类型精确匹配，比如 @xt_string_new(i8* %t)
				// 我们刚才在组装 args 时已经将 isBuiltin 的参数类型设置为了 i8*

				// 针对像 `xt_to_int` 这样的情况，虽然是内置，但返回的是 i64，所以还是使用 i64 接收
				if strings.Contains(funcName, "xt_to_int") || strings.Contains(funcName, "xt_string_length") {
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
				} else {
					c.emit("  %s = call i8* %s(%s)", reg, funcName, strings.Join(args, ", "))
				}
			} else {
				c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
			}
		}

		// 调用结束后释放参数引用
		for _, argReg := range argRegs {
			c.emit("  call void @xt_release(i64 %s)", argReg)
		}

		if isBuiltin && !strings.Contains(funcName, "xt_to_int") && !strings.Contains(funcName, "xt_string_length") && !strings.Contains(funcName, "xt_dict_get") && !strings.Contains(funcName, "xt_dict_contains") {
			return reg, "i8*", ""
		}
		if fType == "raw_i64" {
			// If it's a dynamic function call that was passed via pointer, and we marked it raw_i64,
			// actually the function returns a normal tagged object, so it should be i64
			return reg, "i64", ""
		}
		return reg, "i64", ""
	case *ast.NewExpression:
		className := ""
		if ident, ok := e.Type.(*ast.Identifier); ok {
			className = ident.Value
		}

		fieldCount := 10
		if info, ok := c.classes[className]; ok {
			fieldCount = len(info.Fields)
		}

		reg := c.nextReg()
		// 传递类名字符串作为第一个参数 (用于类型识别)
		nameAlias := c.addString(className)
		nameReg := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0",
			nameReg, len(className)+1, len(className)+1, nameAlias)

		c.emit("  %s = call %%XTInstance* @xt_instance_new(i8* %s, i64 %d)", reg, nameReg, fieldCount)

		// 调用构造函数 "造"
		if info, ok := c.classes[className]; ok {
			if constr, ok := info.Methods["造"]; ok {
				args := []string{}
				thisObj, thisType := c.convertToObj(reg, "%XTInstance*")
				// 统一下降为 i64
				thisXtVal := c.nextReg()
				c.emit("  %s = ptrtoint %s %s to i64", thisXtVal, thisType, thisObj)
				args = append(args, "i64 "+thisXtVal)

				argRegs := []string{}
				for _, a := range e.Arguments {
					valReg, valType, _ := c.compileExpression(a)
					xtVal := c.ensureI64(valReg, valType)
					argRegs = append(argRegs, xtVal)

					args = append(args, "i64 "+xtVal)
				}
				c.emit("  call i64 %s(%s)", constr, strings.Join(args, ", "))

				// 释放构造函数参数
				for _, argReg := range argRegs {
					c.emit("  call void @xt_release(i64 %s)", argReg)
				}
			}
		}

		return reg, "%XTInstance*", className
	case *ast.ArrayLiteral:
		reg := c.nextReg()
		c.emit("  %s = call %%XTArray* @xt_array_new(i64 %d)", reg, len(e.Elements))
		for _, el := range e.Elements {
			valReg, valType, _ := c.compileExpression(el)
			// 注意：不需要转换 objReg，直接确保是 i64 即可
			xtValReg := c.ensureI64(valReg, valType)
			c.emit("  call void @xt_array_append(%%XTArray* %s, i64 %s)", reg, xtValReg)
			c.emit("  call void @xt_release(i64 %s)", xtValReg)
		}
		resReg := c.nextReg()
		c.emit("  %s = ptrtoint %%XTArray* %s to i64", resReg, reg)
		return resReg, "i64", ""
	case *ast.DictLiteral:
		reg := c.nextReg()
		c.emit("  %s = call %%XTDict* @xt_dict_new(i64 %d)", reg, len(e.Pairs)*2)
		for k, v := range e.Pairs {
			kReg, kType, _ := c.compileExpression(k)
			kXtVal := c.ensureI64(kReg, kType)

			vReg, vType, _ := c.compileExpression(v)
			vXtVal := c.ensureI64(vReg, vType)

			c.emit("  call void @xt_dict_set(%%XTDict* %s, i64 %s, i64 %s)", reg, kXtVal, vXtVal)
			c.emit("  call void @xt_release(i64 %s)", kXtVal)
			c.emit("  call void @xt_release(i64 %s)", vXtVal)
		}
		resReg := c.nextReg()
		c.emit("  %s = ptrtoint %%XTDict* %s to i64", resReg, reg)
		return resReg, "i64", ""
	case *ast.IndexExpression:
		leftReg, leftType, _ := c.compileExpression(e.Left)
		idxReg, idxType, _ := c.compileExpression(e.Index)

		// 统一处理左侧为 i64, i8*, ptr 等指针类型的情况
		if leftType == "i64" || leftType == "i8*" || leftType == "ptr" || strings.HasSuffix(leftType, "*") {
			// 尝试判断是数组还是字典 (运行时动态检查)
			newReg := c.nextReg()
			if leftType == "i64" {
				c.emit("  %s = inttoptr i64 %s to %%XTObject*", newReg, leftReg)
			} else {
				c.emit("  %s = bitcast %s %s to %%XTObject*", newReg, leftType, leftReg)
			}

			// 检查类型
			typeIdPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, newReg)
			typeId := c.nextReg()
			c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)

			isDict := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId) // XT_TYPE_DICT = 6

			isString := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 3", isString, typeId) // XT_TYPE_STRING = 3

			resAddr := c.nextReg()
			c.emitAlloca("%s = alloca i64", resAddr)

			dictLabel := c.nextLabel("idx.dict")
			stringLabel := c.nextLabel("idx.string")
			arrayLabel := c.nextLabel("idx.array")
			mergeLabel := c.nextLabel("idx.merge")

			c.emit("  br i1 %s, label %%%s, label %%%s", isDict, dictLabel, stringLabel)

			c.emit("%s:", dictLabel)
			dPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtr, newReg)
			idxObj, _ := c.convertToObj(idxReg, idxType)
			idxXtVal := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", idxXtVal, idxObj)
			dRes := c.nextReg()
			c.emit("  %s = call i64 @xt_dict_get(%%XTDict* %s, i64 %s)", dRes, dPtr, idxXtVal)
			// 重要：从字典加载需要 retain，以返回 +1 引用
			c.emit("  call void @xt_retain(i64 %s)", dRes)
			c.emit("  store i64 %s, i64* %s", dRes, resAddr)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", stringLabel)
			c.emit("  br i1 %s, label %%%s, label %%%s", isString, stringLabel+".true", arrayLabel)

			c.emit("%s.true:", stringLabel)
			sIdxUntag := c.nextReg()
			xtSIdx := c.ensureI64(idxReg, idxType)
			c.emit("  %s = call i64 @xt_to_int(i64 %s)", sIdxUntag, xtSIdx)
			sRes := c.nextReg()
			c.emit("  %s = call i64 @xt_string_get_char(i64 %s, i64 %s)", sRes, leftReg, sIdxUntag)
			c.emit("  store i64 %s, i64* %s", sRes, resAddr)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", arrayLabel)
			aPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtr, newReg)

			idxUntag := c.nextReg()
			xtIdx := c.ensureI64(idxReg, idxType)
			c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, xtIdx)

			elemPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, aPtr)
			elemsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
			elemPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxUntag)
			aValPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", aValPtr, elemPtr)
			aXtVal := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", aXtVal, aValPtr)
			// 重要：从容器加载需要 retain，以返回 +1 引用
			c.emit("  call void @xt_retain(i64 %s)", aXtVal)
			c.emit("  store i64 %s, i64* %s", aXtVal, resAddr)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", mergeLabel)
			finalVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", finalVal, resAddr)

			c.emit("  call void @xt_release(i64 %s)", leftReg)
			if idxType != "raw_i64" {
				xtIdxRel := c.ensureI64(idxReg, idxType)
				c.emit("  call void @xt_release(i64 %s)", xtIdxRel)
			}
			return finalVal, "i64", ""
		}

		c.emit("  call void @xt_release(i64 %s)", leftReg)
		if idxType != "raw_i64" {
			xtIdxRel := c.ensureI64(idxReg, idxType)
			c.emit("  call void @xt_release(i64 %s)", xtIdxRel)
		}
		return "0", "i64", ""
	case *ast.MemberCallExpression:
		// 特殊处理内置对象 文件
		if ident, ok := e.Object.(*ast.Identifier); ok && ident.Value == "文件" {
			if e.Member.Value == "读" {
				valReg, valType, _ := c.compileExpression(e.Arguments[0])
				objReg, _ := c.convertToObj(valReg, valType)
				xtVal := c.nextReg()
				c.emit("  %s = ptrtoint i8* %s to i64", xtVal, objReg)
				res := c.nextReg()
				c.emit("  %s = call i64 @xt_file_read(i64 %s)", res, xtVal)

				// 释放 +1
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
			}
		}

		objReg, objType, objClass := c.compileExpression(e.Object)

		// 优先处理已知类型的成员 (如 Result.解包, Array.长度, Dict.大小)
		if e.Member.Value == "解包" {
			resPtr := c.nextReg()
			if objType == "i64" {
				c.emit("  %s = inttoptr i64 %s to %%XTResult*", resPtr, objReg)
			} else {
				c.emit("  %s = bitcast %s %s to %%XTResult*", resPtr, objType, objReg)
			}

			isSuccPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 2", isSuccPtr, resPtr)
			isSucc := c.nextReg()
			c.emit("  %s = load i1, i1* %s", isSucc, isSuccPtr)

			valReg := c.nextReg()
			errReg := c.nextReg()
			resReg := c.nextReg()

			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 3", valReg, resPtr)
			c.emit("  %s = getelementptr %%XTResult, %%XTResult* %s, i32 0, i32 4", errReg, resPtr)

			vPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", vPtr, valReg)
			ePtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", ePtr, errReg)

			c.emit("  %s = select i1 %s, i8* %s, i8* %s", resReg, isSucc, vPtr, ePtr)

			// 从实例提取出来的字段对象，作为独立的 +1 引用返回
			resXt := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", resXt, resReg)
			c.emit("  call void @xt_retain(i64 %s)", resXt)

			// 释放基对象 (+1)
			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			return resReg, "i8*", ""
		} else if e.Member.Value == "追加" {
			// 可能是数组追加
			arrPtr := objReg
			if objType == "i64" {
				arrPtr = c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTArray*", arrPtr, objReg)
			} else if objType != "%XTArray*" {
				arrPtr = c.nextReg()
				c.emit("  %s = bitcast %s %s to %%XTArray*", arrPtr, objType, objReg)
			}
			valReg, valType, _ := c.compileExpression(e.Arguments[0])
			valObj, _ := c.convertToObj(valReg, valType)
			valXtVal := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", valXtVal, valObj)
			c.emit("  call void @xt_array_append(%%XTArray* %s, i64 %s)", arrPtr, valXtVal)

			c.emit("  call void @xt_release(i64 %s)", valXtVal)
			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			return "0", "i64", ""
		} else if e.Member.Value == "长度" {
			// 先确定类型，数组的长度在 offset 3，字符串的长度在 offset 3，但是它们结构体定义可能不同，
			// 在 LLVM 中 XTArray={i32, i32, i8**, i64, i64} 和 XTString={i32, i32, i8*, i64}
			// 我们统一把它当做 XTString 或 XTArray，两者的 length 都在第3个字段 (index 3)
			// 为了安全起见，统一 bitcast 到 XTString 获取
			strPtr := objReg
			if objType == "i64" {
				strPtr = c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objReg)
			} else if objType != "%XTString*" {
				strPtr = c.nextReg()
				c.emit("  %s = bitcast %s %s to %%XTString*", strPtr, objType, objReg)
			}
			lenPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", lenPtr, strPtr)
			lenVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", lenVal, lenPtr)

			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			return lenVal, "raw_i64", ""
		} else if e.Member.Value == "连接" {
			// 数组连接
			arrPtr := objReg
			if objType == "i64" {
				arrPtr = c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTArray*", arrPtr, objReg)
			} else if objType != "%XTArray*" {
				arrPtr = c.nextReg()
				c.emit("  %s = bitcast %s %s to %%XTArray*", arrPtr, objType, objReg)
			}

			sepReg, sepType, _ := c.compileExpression(e.Arguments[0])
			sepPtr, _ := c.convertToObj(sepReg, sepType)
			sepStrPtr := c.nextReg()
			c.emit("  %s = bitcast i8* %s to %%XTString*", sepStrPtr, sepPtr)

			res := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_array_join(%%XTArray* %s, %%XTString* %s)", res, arrPtr, sepStrPtr)

			// 释放
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(sepReg, sepType))
			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			resXt := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resXt, res)
			return resXt, "i64", ""
		} else if e.Member.Value == "大小" {
			dictPtr := objReg
			if objType == "i64" {
				dictPtr = c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTDict*", dictPtr, objReg)
			} else if objType != "%XTDict*" {
				dictPtr = c.nextReg()
				c.emit("  %s = bitcast %s %s to %%XTDict*", dictPtr, objType, objReg)
			}
			sizePtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTDict, %%XTDict* %s, i32 0, i32 3", sizePtr, dictPtr)
			sizeVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", sizeVal, sizePtr)

			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			return sizeVal, "raw_i64", ""
		} else if e.Member.Value == "截取" {
			// 字符串截取
			strPtr := objReg
			if objType == "i64" {
				strPtr = c.nextReg()
				c.emit("  %s = inttoptr i64 %s to %%XTString*", strPtr, objReg)
			} else if objType != "%XTString*" {
				strPtr = c.nextReg()
				c.emit("  %s = bitcast %s %s to %%XTString*", strPtr, objType, objReg)
			}

			startReg, startType, _ := c.compileExpression(e.Arguments[0])
			startI64 := c.ensureRawI64(startReg, startType)

			endReg := c.nextReg()
			if len(e.Arguments) > 1 {
				er, et, _ := c.compileExpression(e.Arguments[1])
				endI64 := c.ensureRawI64(er, et)
				c.emit("  %s = add i64 0, %s", endReg, endI64)
				if et != "raw_i64" {
					c.emit("  call void @xt_release(i64 %s)", c.ensureI64(er, et))
				}
			} else {
				// 默认到末尾
				lenPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTString, %%XTString* %s, i32 0, i32 3", lenPtr, strPtr)
				c.emit("  %s = load i64, i64* %s", endReg, lenPtr)
			}

			res := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_substring(%%XTString* %s, i64 %s, i64 %s)", res, strPtr, startI64, endReg)

			// 释放
			if startType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", c.ensureI64(startReg, startType))
			}
			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)

			resXt := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resXt, res)
			return resXt, "i64", ""
		} else if e.Member.Value == "含?" || e.Member.Value == "包含" || e.Member.Value == "包含?" {
			// 可能是字典含? 或者是 字符串包含?

			// 检查类型
			newReg := c.nextReg()
			if objType == "i64" {
				c.emit("  %s = inttoptr i64 %s to %%XTObject*", newReg, objReg)
			} else {
				c.emit("  %s = bitcast %s %s to %%XTObject*", newReg, objType, objReg)
			}

			typeIdPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, newReg)
			typeId := c.nextReg()
			c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)

			isStr := c.nextReg()
			c.emit("  %s = icmp eq i32 %s, 3", isStr, typeId) // XT_TYPE_STRING = 3

			resAddr := c.nextReg()
			c.emitAlloca("%s = alloca i64", resAddr)

			strLabel := c.nextLabel("contains.str")
			dictLabel := c.nextLabel("contains.dict")
			mergeLabel := c.nextLabel("contains.merge")

			c.emit("  br i1 %s, label %%%s, label %%%s", isStr, strLabel, dictLabel)

			c.emit("%s:", strLabel)
			sPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", sPtr, newReg)
			argReg, argType, _ := c.compileExpression(e.Arguments[0])
			argStr, _ := c.convertToObj(argReg, argType)
			argStrPtr := c.nextReg()
			c.emit("  %s = bitcast i8* %s to %%XTString*", argStrPtr, argStr)
			sRes := c.nextReg()
			c.emit("  %s = call i32 @xt_string_contains(%%XTString* %s, %%XTString* %s)", sRes, sPtr, argStrPtr)
			sCond := c.nextReg()
			c.emit("  %s = icmp ne i32 %s, 0", sCond, sRes)
			sFinal := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", sFinal, sCond)
			c.emit("  store i64 %s, i64* %s", sFinal, resAddr)
			c.emit("  call void @xt_release(i64 %s)", c.ensureI64(argReg, argType))
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", dictLabel)
			dPtr := c.nextReg()
			c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtr, newReg)
			kReg, kType, _ := c.compileExpression(e.Arguments[0])
			kXtVal := c.ensureI64(kReg, kType)
			dRes := c.nextReg()
			c.emit("  %s = call i64 @xt_dict_get(%%XTDict* %s, i64 %s)", dRes, dPtr, kXtVal)
			dCond := c.nextReg()
			c.emit("  %s = icmp ne i64 %s, 0", dCond, dRes)
			dFinal := c.nextReg()
			c.emit("  %s = select i1 %s, i64 4, i64 2", dFinal, dCond)
			c.emit("  store i64 %s, i64* %s", dFinal, resAddr)
			c.emit("  call void @xt_release(i64 %s)", kXtVal)
			c.emit("  br label %%%s", mergeLabel)

			c.emit("%s:", mergeLabel)
			finalVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", finalVal, resAddr)

			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)
			return finalVal, "i64", ""
		}

		// 如果是 i8* 或 i64，尝试转为 %XTInstance*
		if objType == "i8*" || objType == "ptr" || objType == "i64" {
			newReg := c.nextReg()
			if objType == "i64" {
				c.emit("  %s = inttoptr i64 %s to %%XTInstance*", newReg, objReg)
			} else {
				c.emit("  %s = bitcast %s %s to %%XTInstance*", newReg, objType, objReg)
			}
			objReg = newReg
			objType = "%XTInstance*"
		}

		if objType == "%XTInstance*" {
			// 如果没有 Arguments，则是字段访问
			if e.Arguments == nil {
				// 查找字段索引
				fieldIdx := -1
				if info, ok := c.classes[objClass]; ok {
					if idx, ok := info.Fields[e.Member.Value]; ok {
						fieldIdx = idx
					}
				}

				if fieldIdx == -1 {
					// 兜底方案：在所有类中查找该字段名
					for _, cls := range c.classes {
						if idx, ok := cls.Fields[e.Member.Value]; ok {
							fieldIdx = idx
							break
						}
					}
				}

				if fieldIdx != -1 {
					fieldsPtrPtr := c.nextReg()
					c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
					fieldsPtr := c.nextReg()
					c.emit("  %s = load i64*, i64** %s", fieldsPtr, fieldsPtrPtr)
					fieldPtr := c.nextReg()
					c.emit("  %s = getelementptr i64, i64* %s, i64 %d", fieldPtr, fieldsPtr, fieldIdx)
					valPtr := c.nextReg()
					c.emit("  %s = load i64, i64* %s", valPtr, fieldPtr)
					// 重要：从实例加载字段需要 retain，以返回 +1 引用
					c.emit("  call void @xt_retain(i64 %s)", valPtr)

					// 尝试确定字段的类名 (如果有记录)
					fClassName := ""
					if _, ok := c.classes[objClass]; ok {
						// 暂时没有记录字段的类型
					}

					// 释放基对象 (+1)
					objXt := c.ensureI64(objReg, objType)
					c.emit("  call void @xt_release(i64 %s)", objXt)

					return valPtr, "i64", fClassName
				} else {
					// 改为编译警告并返回空值兜底，不要直接 panic
					c.emit("  ; WARNING: 未找到成员变量 %s", e.Member.Value)

					// 释放基对象
					objXt := c.ensureI64(objReg, objType)
					c.emit("  call void @xt_release(i64 %s)", objXt)

					return "0", "i64", ""
				}
			} else {
				// 方法调用
				funcName := ""
				if info, ok := c.classes[objClass]; ok {
					if fn, ok := info.Methods[e.Member.Value]; ok {
						funcName = fn
					}
				}

				if funcName == "" {
					// 兜底方案：搜索所有类
					for _, cls := range c.classes {
						if fn, ok := cls.Methods[e.Member.Value]; ok {
							funcName = fn
							break
						}
					}
				}

				if funcName != "" {
					args := []string{}
					thisObj, thisType := c.convertToObj(objReg, objType)
					// thisType 是 i8* 或 %XTInstance*，但所有方法调用参数必须是 i64
					thisXtVal := c.nextReg()
					c.emit("  %s = ptrtoint %s %s to i64", thisXtVal, thisType, thisObj)
					args = append(args, "i64 "+thisXtVal)

					argRegs := []string{}
					for _, a := range e.Arguments {
						valReg, valType, _ := c.compileExpression(a)
						// 为了消除调用歧义和双重释放嫌疑，我们将参数统一下降为 i64，然后传递
						xtVal := c.ensureI64(valReg, valType)
						argRegs = append(argRegs, xtVal)

						// 传递给方法的参数必须是 i64（XTValue），因为玄铁的所有方法参数都是 i64
						args = append(args, "i64 "+xtVal)
					}
					reg := c.nextReg()
					// 修复 @@ 前缀问题，去除重复的 @
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))

					// 释放方法参数
					for _, argReg := range argRegs {
						c.emit("  call void @xt_release(i64 %s)", argReg)
					}

					// 释放基对象 (+1)
					objXt := c.ensureI64(objReg, objType)
					c.emit("  call void @xt_release(i64 %s)", objXt)

					// 确定返回类型（如果能推导出来）
					// 暂时我们可以返回 objClass 以便支持链式调用，或者如果是特定方法返回特定类型
					return reg, "i64", objClass
				}

				// 兜底：如果是方法调用但没找到方法
				c.emit("  ; WARNING: 未找到方法 %s", e.Member.Value)
				objXt := c.ensureI64(objReg, objType)
				c.emit("  call void @xt_release(i64 %s)", objXt)
				return "0", "i64", ""
			}
		}
		return "0", "i64", ""
	case *ast.InfixExpression:
		if e.Operator == "且" || e.Operator == "&&" {
			return c.compileLogicalAnd(e)
		}
		if e.Operator == "或" || e.Operator == "||" {
			return c.compileLogicalOr(e)
		}

		leftReg, leftType, leftClass := c.compileExpression(e.Left)
		rightReg, rightType, _ := c.compileExpression(e.Right)

		// 检查运算符重载
		isArithmeticOrCompare := false
		switch e.Operator {
		case "+", "-", "*", "/", "==", "!=", "<", ">", "<=", ">=":
			isArithmeticOrCompare = true
		}

		if isArithmeticOrCompare {
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
			case "==":
				magicMethod = "_等_"
			}

			foundMagic := false
			if magicMethod != "" {
				if _, ok := c.classes[leftClass]; ok {
					foundMagic = true
				} else if leftClass != "" || leftType == "%XTInstance*" {
					foundMagic = true
				}
			}

			if foundMagic {
				// 执行运算符重载
				funcName := ""
				if info, ok := c.classes[leftClass]; ok {
					funcName = info.Methods[magicMethod]
				}

				if funcName != "" {
					args := []string{}
					thisObj, thisType := c.convertToObj(leftReg, leftType)
					thisXtVal := c.nextReg()
					c.emit("  %s = ptrtoint %s %s to i64", thisXtVal, thisType, thisObj)
					args = append(args, "i64 "+thisXtVal)

					objReg, objType := c.convertToObj(rightReg, rightType)
					rightXtVal := c.nextReg()
					c.emit("  %s = ptrtoint %s %s to i64", rightXtVal, objType, objReg)
					args = append(args, "i64 "+rightXtVal)

					reg := c.nextReg()
					// 修复 @@ 前缀问题，去除重复的 @
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
					return reg, "i64", ""
				}
			}
		}

		if e.Operator == "&" {
			// 字符串拼接，不需要也不应该转为 raw_i64
			leftXtVal := c.ensureI64(leftReg, leftType)
			rightXtVal := c.ensureI64(rightReg, rightType)

			lObj, _ := c.convertToObj(leftXtVal, "i64")
			lXtValReg := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", lXtValReg, lObj)
			lStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i64 %s)", lStr, lXtValReg)

			rObj, _ := c.convertToObj(rightXtVal, "i64")
			rXtValReg := c.nextReg()
			c.emit("  %s = ptrtoint i8* %s to i64", rXtValReg, rObj)
			rStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i64 %s)", rStr, rXtValReg)

			resReg := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_concat(%%XTString* %s, %%XTString* %s)", resReg, lStr, rStr)

			// 释放操作数
			if leftType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", leftXtVal)
			}
			if rightType != "raw_i64" {
				c.emit("  call void @xt_release(i64 %s)", rightXtVal)
			}

			// 释放 xt_obj_to_string 产生的中间字符串
			lStrI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", lStrI64, lStr)
			c.emit("  call void @xt_release(i64 %s)", lStrI64)

			rStrI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", rStrI64, rStr)
			c.emit("  call void @xt_release(i64 %s)", rStrI64)

			resI64 := c.nextReg()
			c.emit("  %s = ptrtoint %%XTString* %s to i64", resI64, resReg)
			return resI64, "i64", ""
		}

		// 对于算术运算，统一转为 raw_i64 进行运算
		// 但对于比较运算，必须判断类型
		isArithmetic := false
		switch e.Operator {
		case "+", "-", "*", "/":
			isArithmetic = true
		}

		if isArithmetic {
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
			}
			reg := c.nextReg()
			c.emit("  %s = %s i64 %s, %s", reg, op, leftRaw, rightRaw)

			if leftType != "raw_i64" {
				xt := c.ensureI64(leftReg, leftType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}
			if rightType != "raw_i64" {
				xt := c.ensureI64(rightReg, rightType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}

			return reg, "raw_i64", ""
		}

		// 比较运算
		reg := c.nextReg()
		switch e.Operator {
		case "==", "!=":
			cond := c.nextReg()
			if leftType == "raw_i64" && rightType == "raw_i64" {
				if e.Operator == "==" {
					c.emit("  %s = icmp eq i64 %s, %s", cond, leftReg, rightReg)
				} else {
					c.emit("  %s = icmp ne i64 %s, %s", cond, leftReg, rightReg)
				}
			} else {
				// 转为对象并调用 xt_eq
				leftXtVal := c.ensureI64(leftReg, leftType)
				rightXtVal := c.ensureI64(rightReg, rightType)
				lObj, _ := c.convertToObj(leftXtVal, "i64")
				rObj, _ := c.convertToObj(rightXtVal, "i64")
				res := c.nextReg()
				c.emit("  %s = call i32 @xt_eq(i8* %s, i8* %s)", res, lObj, rObj)
				if e.Operator == "==" {
					c.emit("  %s = icmp ne i32 %s, 0", cond, res)
				} else {
					c.emit("  %s = icmp eq i32 %s, 0", cond, res)
				}
			}

			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, cond)

			if leftType != "raw_i64" {
				xt := c.ensureI64(leftReg, leftType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}
			if rightType != "raw_i64" {
				xt := c.ensureI64(rightReg, rightType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}

			return reg, "i64", ""

		case "<", ">", "<=", ">=":
			cond := c.nextReg()
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
				leftXtVal := c.ensureI64(leftReg, leftType)
				rightXtVal := c.ensureI64(rightReg, rightType)
				lObj, _ := c.convertToObj(leftXtVal, "i64")
				rObj, _ := c.convertToObj(rightXtVal, "i64")
				res := c.nextReg()
				c.emit("  %s = call i32 @xt_compare(i8* %s, i8* %s)", res, lObj, rObj)
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
				c.emit("  %s = icmp %s i32 %s, 0", cond, cmpOp, res)
			}

			c.emit("  %s = select i1 %s, i64 4, i64 2", reg, cond)

			if leftType != "raw_i64" {
				xt := c.ensureI64(leftReg, leftType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}
			if rightType != "raw_i64" {
				xt := c.ensureI64(rightReg, rightType)
				c.emit("  call void @xt_release(i64 %s)", xt)
			}

			return reg, "i64", ""
		}

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

	// False path: release left (if needed) and return false
	c.emit("%s:", falseLabel)
	if leftType != "raw_i64" {
		xt := c.ensureI64(leftReg, leftType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	c.emit("  br label %%%s", endLabel)

	// RHS path
	c.emit("%s:", rhsLabel)
	if leftType != "raw_i64" {
		xt := c.ensureI64(leftReg, leftType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	rightReg, rightType, _ := c.compileExpression(e.Right)
	rI1 := rightReg
	if rightType == "i64" {
		rI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", rI1, rightReg)
	}
	rhsBlock := c.currentLabel
	if rightType != "raw_i64" {
		xt := c.ensureI64(rightReg, rightType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	c.emit("  br label %%%s", endLabel)

	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = phi i1 [ false, %%%s ], [ %s, %%%s ]", resReg, falseLabel, rI1, rhsBlock)

	// 转回 tagged i64 (True=4, False=2)
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

	// True path: release left (if needed) and return true
	c.emit("%s:", trueLabel)
	if leftType != "raw_i64" {
		xt := c.ensureI64(leftReg, leftType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	c.emit("  br label %%%s", endLabel)

	// RHS path
	c.emit("%s:", rhsLabel)
	if leftType != "raw_i64" {
		xt := c.ensureI64(leftReg, leftType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	rightReg, rightType, _ := c.compileExpression(e.Right)
	rI1 := rightReg
	if rightType == "i64" {
		rI1 = c.nextReg()
		c.emit("  %s = icmp eq i64 %s, 4", rI1, rightReg)
	}
	rhsBlock := c.currentLabel
	if rightType != "raw_i64" {
		xt := c.ensureI64(rightReg, rightType)
		c.emit("  call void @xt_release(i64 %s)", xt)
	}
	c.emit("  br label %%%s", endLabel)

	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = phi i1 [ true, %%%s ], [ %s, %%%s ]", resReg, trueLabel, rI1, rhsBlock)

	// 转回 tagged i64 (True=4, False=2)
	reg := c.nextReg()
	c.emit("  %s = select i1 %s, i64 4, i64 2", reg, resReg)
	return reg, "i64", ""
}

func (c *LLVMCompiler) compileMatchStatement(s *ast.MatchStatement) {
	c.enterScope()
	defer c.exitScope(false)

	valReg, valType, _ := c.compileExpression(s.Value)

	// 为了确保在任何退出路径（包括 return）都能正确释放被匹配对象，
	// 我们将其存入一个临时的隐藏变量并加入作用域追踪。
	matchValAddr := c.nextReg()
	c.emitAlloca("%s = alloca i64", matchValAddr)
	vI64 := c.ensureI64(valReg, valType)
	c.emit("  store i64 %s, i64* %s", vI64, matchValAddr)
	c.trackObject(matchValAddr)

	// 后续使用时从该地址加载（或者直接用 vI64，因为 entry block 支配所有 case）
	// 直接用 vI64 即可，因为它在 entry block 定义。

	mergeLabel := c.nextLabel("match.merge")

	for _, cas := range s.Cases {
		nextCaseLabel := c.nextLabel("match.next")
		bodyLabel := c.nextLabel("match.body")

		if ident, ok := cas.Pattern.(*ast.Identifier); ok && ident.Value == "_" {
			c.emit("  br label %%%s", bodyLabel)

			c.emit("%s:", bodyLabel)
		} else if prefix, ok := cas.Pattern.(*ast.PrefixExpression); ok && prefix.Operator == "是" {
			// 处理 '是 类型' 或 '是 成功/失败'
			if ident, ok := prefix.Right.(*ast.Identifier); ok {
				if ident.Value == "成功" || ident.Value == "失败" {
					// 检查是否是 Result 类型且匹配成功/失败
					// 1. 检查 type_id == XT_TYPE_RESULT
					// 2. 检查 is_success == 1 (成功) 或 0 (失败)

					objPtr := c.nextReg()
					if valType == "i64" {
						c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, valReg)
					} else {
						c.emit("  %s = bitcast %s %s to %%XTObject*", objPtr, valType, valReg)
					}

					typeIdPtr := c.nextReg()
					c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
					typeId := c.nextReg()
					c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)

					isResult := c.nextReg()
					c.emit("  %s = icmp eq i32 %s, 8", isResult, typeId) // XT_TYPE_RESULT = 8

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
					// 其他类型判断 (暂不实现)
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

			// 如果是对象，使用 xt_eq
			if valType != "raw_i64" || patType != "raw_i64" {
				vObj, _ := c.convertToObj(valReg, valType)
				pObj, _ := c.convertToObj(patReg, patType)
				res := c.nextReg()
				c.emit("  %s = call i32 @xt_eq(i8* %s, i8* %s)", res, vObj, pObj)
				c.emit("  %s = icmp ne i32 %s, 0", condReg, res)
			} else {
				vI64 := c.ensureI64(valReg, valType)
				pI64 := c.ensureI64(patReg, patType)
				c.emit("  %s = icmp eq i64 %s, %s", condReg, vI64, pI64)
			}

			// 修正 LLVM 基本块跳转结构：先在条件块中条件跳转，然后在 nextCaseLabel 释放对象，而不是混在中间
			// 这里如果需要释放 pattern，不能把释放代码直接放在 br 指令之后，因为 br 必须是基本块的终结指令

			// 我们需要创建一个专门用于清理的 label，如果匹配失败则先跳过去清理，然后再跳入下一个 case
			// 如果匹配成功，则直接跳入 bodyLabel
			cleanupLabel := c.nextLabel("match.cleanup")

			c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, cleanupLabel)

			c.emit("%s:", cleanupLabel)
			if patType != "raw_i64" && patType != "i64" {
				// 临时释放编译 pattern 产生的对象
				pFinal := c.ensureI64(patReg, patType)
				c.emit("  call void @xt_release(i64 %s)", pFinal)
			}

			c.emit("  br label %%%s", nextCaseLabel)

			c.emit("%s:", bodyLabel)
			if patType != "raw_i64" && patType != "i64" {
				pFinalBody := c.ensureI64(patReg, patType)
				c.emit("  call void @xt_release(i64 %s)", pFinalBody)
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

	// 提前分配 keysAddrTemp 以确保 ARC 安全
	keysAddrTemp := c.nextReg()
	c.emitAlloca("%s = alloca i64", keysAddrTemp)
	c.emit("  store i64 0, i64* %s", keysAddrTemp)
	c.trackObject(keysAddrTemp)

	iterReg, iterType, _ := c.compileExpression(s.Iterable)

	// 同样地，将可迭代对象存入隐藏变量以确保 ARC 安全
	iterAddr := c.nextReg()
	c.emitAlloca("%s = alloca i64", iterAddr)
	iI64 := c.ensureI64(iterReg, iterType)
	c.emit("  store i64 %s, i64* %s", iI64, iterAddr)
	c.trackObject(iterAddr)

	// 统一转为指针进行类型检查
	objPtr := c.nextReg()
	c.emit("  %s = inttoptr i64 %s to %%XTObject*", objPtr, iI64)

	typeIdPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTObject, %%XTObject* %s, i32 0, i32 1", typeIdPtr, objPtr)
	typeId := c.nextReg()
	c.emit("  %s = load i32, i32* %s", typeId, typeIdPtr)

	// 根据 typeId 决定遍历方式
	// XT_TYPE_ARRAY = 5, XT_TYPE_STRING = 3, XT_TYPE_DICT = 6
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
	// 将提取出来的 keys 数组存入提前分配好的地址
	c.emit("  store i64 %s, i64* %s", keysI64, keysAddrTemp)
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

	isArray := c.nextReg()
	c.emit("  %s = icmp eq i32 %s, 5", isArray, actualTypeId)

	// 为循环变量提前 alloca 和 track，避免在循环体内重复 track
	for _, v := range s.Variables {
		varAddr := "%\"" + v.Value + "\""
		c.emitAlloca("%s = alloca i64", varAddr)
		c.emit("  store i64 0, i64* %s", varAddr)
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

	// Since idxAddr stores raw i64, we don't need to unbox it
	idxRaw := idxReg

	lenReg := c.nextReg()

	// 获取长度
	lenArrLabel := c.nextLabel("for.len_arr")
	lenStrLabel := c.nextLabel("for.len_str")
	lenMergeLabel := c.nextLabel("for.len_merge")

	// 这里我们需要注意 isDict 的情况，它的 len 走的是 lenArrLabel，因为 keysArr 是个数组
	// 但此时 isArray 对于 keysArr 是 5，然而 isArray 判断的是 original object!
	// 我们之前将 actualObjPtr 改成了 phi (dict 则是 keys 数组)，所以 actualTypeId 也是 keys 数组的 5
	// 因此 isArray == 5 是真的，但是 isArray 寄存器是在 actualObjPtr 之前计算的！！！
	// 啊！isArray 是在 dictConvEndBlock 之前用最初的 objPtr (typeId) 算出来的！
	// 对于 dict，最初的 typeId 是 6，isArray 是 false！
	// 所以我们应该使用 actualTypeId 重新计算 isArrForLen
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
	c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ]", lenReg, lenValArrRaw, lenArrLabel, lenValStrRaw, lenStrLabel)

	condReg := c.nextReg()
	// 如果 isDict 是真，lenReg 代表 keys 数组的长度，而 keys 数组是遍历出来的 XTArray
	c.emit("  %s = icmp slt i64 %s, %s", condReg, idxRaw, lenReg)
	c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, endLabel)

	// 修复：进入循环体时应该使用 c.enterScope()
	c.emit("%s:", bodyLabel)
	c.enterScope()

	valPtr := c.nextReg()

	// 获取元素
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
	c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxRaw)
	valArr := c.nextReg()
	c.emit("  %s = load i8*, i8** %s", valArr, elemPtr)
	// 从数组加载需要 retain 以获得所有权 (+1)
	xtValArr := c.nextReg()
	c.emit("  %s = ptrtoint i8* %s to i64", xtValArr, valArr)
	c.emit("  call void @xt_retain(i64 %s)", xtValArr)
	c.emit("  br label %%%s", elemMergeLabel)

	c.emit("%s:", elemStrLabel)
	sPtrElem := c.nextReg()
	c.emit("  %s = bitcast %%XTObject* %s to %%XTString*", sPtrElem, actualObjPtr)
	strFromChar := c.nextReg()
	// 注意：这里直接传递 idxAddr 指针给运行时函数，让其内部更新偏移
	c.emit("  %s = call %%XTString* @xt_string_next_char(%%XTString* %s, i64* %s)", strFromChar, sPtrElem, idxAddr)
	// xt_string_next_char 已经返回 +1 引用
	xtValStr := c.nextReg()
	c.emit("  %s = ptrtoint %%XTString* %s to i64", xtValStr, strFromChar)
	c.emit("  br label %%%s", elemMergeLabel)

	c.emit("%s:", elemMergeLabel)
	c.emit("  %s = phi i64 [ %s, %%%s ], [ %s, %%%s ]", valPtr, xtValArr, elemArrLabel, xtValStr, elemStrLabel)

	if len(s.Variables) == 1 {
		varAddr := "%\"" + s.Variables[0].Value + "\""
		// 释放旧值
		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, varAddr)
		c.emit("  call void @xt_release(i64 %s)", oldVal)

		// 存入新值 (接管 phi 返回的 +1 引用)
		c.emit("  store i64 %s, i64* %s", valPtr, varAddr)
	} else if len(s.Variables) >= 2 {
		idxAddrVar := "%\"" + s.Variables[0].Value + "\""
		valAddrVar := "%\"" + s.Variables[1].Value + "\""

		// 释放旧值
		oldIdx := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldIdx, idxAddrVar)
		c.emit("  call void @xt_release(i64 %s)", oldIdx)

		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, valAddrVar)
		c.emit("  call void @xt_release(i64 %s)", oldVal)

		condDictAsg := c.nextLabel("for.asg_dict")
		condArrAsg := c.nextLabel("for.asg_arr")
		condAsgMerge := c.nextLabel("for.asg_merge")
		c.emit("  br i1 %s, label %%%s, label %%%s", isDict, condDictAsg, condArrAsg)

		c.emit("%s:", condDictAsg)
		c.emit("  call void @xt_retain(i64 %s)", valPtr)
		c.emit("  store i64 %s, i64* %s", valPtr, idxAddrVar) // k = key

		dictPtrGet := c.nextReg()
		// 由于 objPtr 是 %XTObject*，需要先转为 %XTDict*
		c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dictPtrGet, actualObjPtr)
		dictVal := c.nextReg()
		c.emit("  %s = call i64 @xt_dict_get(%%XTDict* %s, i64 %s)", dictVal, dictPtrGet, valPtr)
		c.emit("  call void @xt_retain(i64 %s)", dictVal)
		c.emit("  store i64 %s, i64* %s", dictVal, valAddrVar) // v = dict[k]
		c.emit("  br label %%%s", condAsgMerge)

		c.emit("%s:", condArrAsg)
		c.emit("  store i64 %s, i64* %s", idxReg, idxAddrVar) // k = index

		c.emit("  call void @xt_retain(i64 %s)", valPtr)
		c.emit("  store i64 %s, i64* %s", valPtr, valAddrVar) // v = array[index]
		c.emit("  br label %%%s", condAsgMerge)

		c.emit("%s:", condAsgMerge)

		// release the shared valPtr (+1 from phi) since we retained copies independently
		c.emit("  call void @xt_release(i64 %s)", valPtr)
	}

	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}

	c.exitScope(false)

	// 更新索引：如果是数组/字典（isArray=true），手动增加索引；如果是字符串，xt_string_next_char 已更新
	// 但对于 isDict 也是手动增加索引！而 isArray 只检查了 == 5。
	// 这里需要增加一个 isArrOrDict 的判断
	isArrOrDict := c.nextReg()
	c.emit("  %s = icmp ne i32 %s, 3", isArrOrDict, actualTypeId) // 3 is String, so if not 3, it's array or dict

	idxUpdateLabel := c.nextLabel("for.idx_update")
	idxSkipLabel := c.nextLabel("for.idx_skip")
	c.emit("  br i1 %s, label %%%s, label %%%s", isArrOrDict, idxUpdateLabel, idxSkipLabel)

	c.emit("%s:", idxUpdateLabel)
	newIdx := c.nextReg()
	// 如果是原生 i64
	c.emit("  %s = add i64 %s, 1", newIdx, idxReg)
	c.emit("  store i64 %s, i64* %s", newIdx, idxAddr)
	c.emit("  br label %%%s", condLabel)

	c.emit("%s:", idxSkipLabel)
	c.emit("  br label %%%s", condLabel)

	c.emit("%s:", endLabel)
}

func (c *LLVMCompiler) compileComplexAssignStatement(s *ast.ComplexAssignStatement) {
	if s == nil {
		return
	}
	valReg, valType, _ := c.compileExpression(s.Right)
	xtVal := c.ensureI64(valReg, valType)

	switch left := s.Left.(type) {
	case *ast.Identifier:
		if info, ok := c.symbolTable[left.Value]; ok {
			// 释放旧值
			oldVal := c.nextReg()
			c.emit("  %s = load i64, i64* %s", oldVal, info.AddrReg)
			c.emit("  call void @xt_release(i64 %s)", oldVal)
			// 存储新值 (接管 +1)
			c.emit("  store i64 %s, i64* %s", xtVal, info.AddrReg)
		}
	case *ast.IndexExpression:
		leftReg, leftType, _ := c.compileExpression(left.Left)
		idxReg, idxType, _ := c.compileExpression(left.Index)

		// 统一转为指针进行类型检查
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
		c.emit("  %s = icmp eq i32 %s, 6", isDict, typeId) // XT_TYPE_DICT = 6

		dictLabel := c.nextLabel("idx_assign.dict")
		arrayLabel := c.nextLabel("idx_assign.array")
		mergeLabel := c.nextLabel("idx_assign.merge")

		c.emit("  br i1 %s, label %%%s, label %%%s", isDict, dictLabel, arrayLabel)

		c.emit("%s:", dictLabel)
		dPtr := c.nextReg()
		c.emit("  %s = bitcast %%XTObject* %s to %%XTDict*", dPtr, objPtr)

		idxXtVal := c.ensureI64(idxReg, idxType)
		c.emit("  call void @xt_dict_set(%%XTDict* %s, i64 %s, i64 %s)", dPtr, idxXtVal, xtVal)

		c.emit("  call void @xt_release(i64 %s)", leftReg)
		c.emit("  call void @xt_release(i64 %s)", idxXtVal)

		c.emit("  br label %%%s", mergeLabel)

		c.emit("%s:", arrayLabel)
		aPtr := c.nextReg()
		c.emit("  %s = bitcast %%XTObject* %s to %%XTArray*", aPtr, objPtr)
		idxUntag := c.nextReg()
		xtIdx := c.ensureI64(idxReg, idxType)
		c.emit("  %s = call i64 @xt_to_int(i64 %s)", idxUntag, xtIdx)

		elemPtrPtr := c.nextReg()
		c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, aPtr)
		elemsPtr := c.nextReg()
		c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
		elemPtr := c.nextReg()
		c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxUntag)
		elemPtrTyped := c.nextReg()
		c.emit("  %s = bitcast i8** %s to i64*", elemPtrTyped, elemPtr)

		// 释放旧值
		oldVal := c.nextReg()
		c.emit("  %s = load i64, i64* %s", oldVal, elemPtrTyped)
		c.emit("  call void @xt_release(i64 %s)", oldVal)

		// 存储新值 (接管 +1)
		c.emit("  store i64 %s, i64* %s", xtVal, elemPtrTyped)

		c.emit("  call void @xt_release(i64 %s)", leftReg)
		if idxType != "raw_i64" {
			xtIdxRel := c.ensureI64(idxReg, idxType)
			c.emit("  call void @xt_release(i64 %s)", xtIdxRel)
		}

		c.emit("  br label %%%s", mergeLabel)

		c.emit("%s:", mergeLabel)
	case *ast.MemberCallExpression:
		objReg, objType, objClass := c.compileExpression(left.Object)
		// 如果是 i8*，尝试 bitcast 回 %XTInstance*
		if objType == "i8*" || objType == "ptr" || objType == "i64" {
			newReg := c.nextReg()
			if objType == "i64" {
				c.emit("  %s = inttoptr i64 %s to %%XTInstance*", newReg, objReg)
			} else {
				c.emit("  %s = bitcast %s %s to %%XTInstance*", newReg, objType, objReg)
			}
			objReg = newReg
			objType = "%XTInstance*"
		}

		if objType == "%XTInstance*" {
			// 查找字段索引
			fieldIdx := -1
			if info, ok := c.classes[objClass]; ok {
				if idx, ok := info.Fields[left.Member.Value]; ok {
					fieldIdx = idx
				}
			}

			if fieldIdx == -1 {
				// 兜底方案：在所有类中查找该字段名
				for _, cls := range c.classes {
					if idx, ok := cls.Fields[left.Member.Value]; ok {
						fieldIdx = idx
						break
					}
				}
			}

			if fieldIdx != -1 {
				fieldsPtrPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
				fieldsPtr := c.nextReg()
				c.emit("  %s = load i64*, i64** %s", fieldsPtr, fieldsPtrPtr)
				fieldPtr := c.nextReg()
				c.emit("  %s = getelementptr i64, i64* %s, i64 %d", fieldPtr, fieldsPtr, fieldIdx)

				// 释放旧值
				oldVal := c.nextReg()
				c.emit("  %s = load i64, i64* %s", oldVal, fieldPtr)
				c.emit("  call void @xt_release(i64 %s)", oldVal)

				// 存储新值 (接管 +1)
				c.emit("  store i64 %s, i64* %s", xtVal, fieldPtr)
			} else {
				// 不要 panic，改为编译警告兜底
				c.emit("  ; WARNING: 未找到成员变量进行赋值 %s", left.Member.Value)
			}

			objXt := c.ensureI64(objReg, objType)
			c.emit("  call void @xt_release(i64 %s)", objXt)
		}
	}
}

func (c *LLVMCompiler) compileTypeDefinitionStatement(s *ast.TypeDefinitionStatement) {
	classInfo := &ClassInfo{
		Name:    s.Name.Value,
		Fields:  make(map[string]int),
		Methods: make(map[string]string),
	}

	if s.Parent != nil {
		classInfo.Parent = s.Parent.Value
		// 继承父类字段
		if parentInfo, ok := c.classes[s.Parent.Value]; ok {
			for name, idx := range parentInfo.Fields {
				classInfo.Fields[name] = idx
			}
			// 继承父类方法
			for name, fn := range parentInfo.Methods {
				classInfo.Methods[name] = fn
			}
		}
	}

	fieldIdx := len(classInfo.Fields)
	for _, stmt := range s.Block {
		if vs, ok := stmt.(*ast.VarStatement); ok {
			if _, ok := classInfo.Fields[vs.Name.Value]; !ok {
				classInfo.Fields[vs.Name.Value] = fieldIdx
				fieldIdx++
			}
		}
	}

	c.classes[s.Name.Value] = classInfo
	oldClass := c.currentClass
	c.currentClass = s.Name.Value

	// 第一遍：注册所有方法
	for _, stmt := range s.Block {
		if m, ok := stmt.(*ast.FunctionStatement); ok && m != nil {
			funcName := fmt.Sprintf("@\"%s_%s\"", s.Name.Value, m.Name.Value)
			classInfo.Methods[m.Name.Value] = funcName
		}
	}

	// 第二遍：编译所有方法
	for _, stmt := range s.Block {
		if m, ok := stmt.(*ast.FunctionStatement); ok && m != nil {
			c.compileMethodStatement(s.Name.Value, m)
		}
	}

	c.currentClass = oldClass
}

func (c *LLVMCompiler) compileMethodStatement(className string, s *ast.FunctionStatement) {
	if s == nil {
		return
	}
	// 切换到函数输出缓冲区
	oldOutput := c.output
	c.output = bytes.Buffer{}
	oldAllocaOutput := c.allocaOutput
	c.allocaOutput = bytes.Buffer{}
	oldFunc := c.currentFunc
	c.currentFunc = s.Name.Value

	// 保存旧符号表和作用域栈
	oldTable := make(map[string]SymbolInfo)
	for k, v := range c.symbolTable {
		oldTable[k] = v
	}
	oldScopeStack := c.scopeStack
	c.scopeStack = [][]string{}

	funcName := fmt.Sprintf("@\"%s_%s\"", className, s.Name.Value)
	params := []string{"i64 %\"this_arg\""} // 方法首个参数永远是 this (现在是 i64)
	for _, p := range s.Parameters {
		params = append(params, "i64 %\""+p.Name.Value+"_arg\"")
	}

	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")
	c.currentLabel = "entry"

	// 进入方法作用域
	c.enterScope()

	// 绑定 this
	thisAddr := "%\"此\"" // 支持中文 "此" 或 "this"
	c.emitAlloca("%s = alloca i64", thisAddr)
	// this_arg 就是 i64，不需要再 bitcast 了
	c.emit("  store i64 %%\"this_arg\", i64* %s", thisAddr)
	// 参数作为局部变量，需要 retain 并加入作用域追踪
	c.emit("  call void @xt_retain(i64 %%\"this_arg\")")
	c.symbolTable["此"] = SymbolInfo{AddrReg: thisAddr, Type: "i64", ClassName: className}
	c.symbolTable["this"] = SymbolInfo{AddrReg: thisAddr, Type: "i64", ClassName: className}
	c.trackObject(thisAddr)

	// 为其他参数分配本地内存
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emitAlloca("%s = alloca i64", addrReg)
		// 参数现在是 i64
		c.emit("  store i64 %%\"%s_arg\", i64* %s", p.Name.Value, addrReg)
		// 参数作为局部变量，需要 retain 并加入作用域追踪
		c.emit("  call void @xt_retain(i64 %%\"%s_arg\")", p.Name.Value)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64"}
		c.trackObject(addrReg)
	}

	for _, stmt := range s.Body {
		c.compileStatement(stmt)
	}

	// 退出方法作用域
	c.exitScope(false)

	// 确保函数总是有返回
	c.emit("  ret i64 0")
	c.emit("}")

	funcBody := c.output.String()
	funcAllocas := c.allocaOutput.String()
	// 在 entry: 之后插入 alloca
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
