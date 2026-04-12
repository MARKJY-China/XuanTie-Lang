package compiler

import (
	"bytes"
	"fmt"
	"strings"
	"xuantie/ast"
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
	program      *ast.Program
	output       bytes.Buffer
	funcOutput   bytes.Buffer
	globalOutput bytes.Buffer // 存储全局变量定义的 IR
	regCount     int
	labelCount   int
	symbolTable  map[string]SymbolInfo
	strings      map[string]string
	classes      map[string]*ClassInfo
	scopeStack   [][]string // 每层作用域需要 release 的寄存器列表
	currentFunc  string     // 为空表示在 main 中
	currentClass string     // 当前正在转译的类名
}

func NewLLVMCompiler(program *ast.Program) *LLVMCompiler {
	return &LLVMCompiler{
		program:     program,
		symbolTable: make(map[string]SymbolInfo),
		strings:     make(map[string]string),
		classes:     make(map[string]*ClassInfo),
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
	c.output = oldOutput

	// 1. 写入模块头
	c.emit("; XuanTie v0.13.3 LLVM Backend")
	c.emit("target datalayout = \"e-m:w-p270:32:32-p271:32:32-p272:64:64-i64:64-f80:128-n8:16:32:64-S128\"")
	c.emit("target triple = \"x86_64-pc-windows-msvc\"")
	c.emit("")

	// 2. 写入全局字符串常量
	for content, alias := range c.strings {
		escaped := strings.ReplaceAll(content, "\\", "\\5C")
		escaped = strings.ReplaceAll(escaped, "\n", "\\0A")
		escaped = strings.ReplaceAll(escaped, "\"", "\\22")
		c.emit("@%s = private unnamed_addr constant [%d x i8] c\"%s\\00\"", alias, len(content)+1, escaped)
	}
	c.emit("")

	// 3. 外部运行时函数声明
	c.emit("%%XTString = type { i32, i32, i8*, i64 }")
	c.emit("%%XTArray = type { i32, i32, i8**, i64, i64 }")
	c.emit("%%XTInstance = type { i32, i32, i8*, i8** }")
	c.emit("%%XTResult = type { i32, i32, i1, i8*, i8* }")
	c.emit("declare void @xt_init()")
	c.emit("declare void @xt_print_int(i64)")
	c.emit("declare void @xt_print_string(%%XTString*)")
	c.emit("declare void @xt_print_bool(i1)")
	c.emit("declare void @xt_print_float(double)")
	c.emit("declare void @xt_print_value(i64)")
	c.emit("declare i64 @xt_int_new(i64)")
	c.emit("declare i8* @xt_float_new(double)")
	c.emit("declare i64 @xt_bool_new(i1)")
	c.emit("declare %%XTString* @xt_string_new(i8*)")
	c.emit("declare %%XTArray* @xt_array_new(i64)")
	c.emit("declare void @xt_array_append(%%XTArray*, i64)")
	c.emit("declare %%XTInstance* @xt_instance_new(i8*, i64)")
	c.emit("declare i8* @xt_result_new(i1, i8*, i8*)")
	c.emit("declare %%XTString* @xt_string_concat(%%XTString*, %%XTString*)")
	c.emit("declare %%XTString* @xt_int_to_string(i64)")
	c.emit("declare %%XTString* @xt_obj_to_string(i64)")
	c.emit("declare void @xt_retain(i64)")
	c.emit("declare void @xt_release(i64)")
	c.emit("declare i64 @xt_to_int(i64)")
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
	c.emit("  call void @xt_init()")
	c.output.WriteString(mainBody)
	c.emit("  ret i32 0")
	c.emit("}")

	return c.output.String()
}

func (c *LLVMCompiler) emit(format string, args ...interface{}) {
	c.output.WriteString(fmt.Sprintf(format+"\n", args...))
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

func (c *LLVMCompiler) compileStatement(stmt ast.Statement) {
	switch s := stmt.(type) {
	case *ast.PrintStatement:
		valReg, valType, _ := c.compileExpression(s.Value)
		// 统一转换为 XTValue (i64) 并调用 xt_print_value
		objReg, _ := c.convertToObj(valReg, valType)
		xtValReg := c.nextReg()
		c.emit("  %s = ptrtoint i8* %s to i64", xtValReg, objReg)
		c.emit("  call void @xt_print_value(i64 %s)", xtValReg)
	case *ast.VarStatement:
		valReg, valType, className := c.compileExpression(s.Value)
		if c.currentFunc == "" {
			// 全局变量
			addrReg := "@\"" + s.Name.Value + "\""
			initVal := "0"
			if strings.HasSuffix(valType, "*") {
				initVal = "null"
			}
			c.globalOutput.WriteString(fmt.Sprintf("%s = global %s %s\n", addrReg, valType, initVal))
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: valType, ClassName: className, IsGlobal: true}
		} else {
			// 本地变量
			addrReg := "%\"" + s.Name.Value + "\""
			c.emit("  %s = alloca %s", addrReg, valType)
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: valType, ClassName: className, IsGlobal: false}
			// 追踪对象以便退出作用域时 release
			if valType == "i64" || strings.HasSuffix(valType, "*") || valType == "i8*" || valType == "ptr" {
				c.trackObject(addrReg)
			}
		}
	case *ast.AssignStatement:
		valReg, valType, className := c.compileExpression(s.Value)
		if info, ok := c.symbolTable[s.Name]; ok {
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, info.AddrReg)
			// 更新类名信息 (简单流敏感分析)
			info.ClassName = className
			c.symbolTable[s.Name] = info
		}
	case *ast.ComplexAssignStatement:
		c.compileComplexAssignStatement(s)
	case *ast.IfStatement:
		c.compileIfStatement(s)
	case *ast.MatchStatement:
		c.compileMatchStatement(s)
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
	case *ast.ReturnStatement:
		valReg, valType, _ := c.compileExpression(s.ReturnValue)
		if valType == "i1" {
			reg := c.nextReg()
			c.emit("  %s = zext i1 %s to i64", reg, valReg)
			valReg = reg
			valType = "i64"
		}
		// 目前所有自定义函数都返回 i64 (存储对象指针或整数)
		// 如果是指针，先转为 i64
		if strings.HasSuffix(valType, "*") || valType == "i8*" || valType == "ptr" {
			reg := c.nextReg()
			c.emit("  %s = ptrtoint %s %s to i64", reg, valType, valReg)
			valReg = reg
		}

		// 在返回前 release 所有局部变量
		c.exitScope(true)

		c.emit("  ret i64 %s", valReg)
	case *ast.ExpressionStatement:
		c.compileExpression(s.Expression)
	}
}

func (c *LLVMCompiler) compileIfStatement(s *ast.IfStatement) {
	condReg, condType, _ := c.compileExpression(s.Condition)
	if condType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, condReg)
		condReg = reg
	}
	thenLabel := c.nextLabel("if.then")
	elseLabel := c.nextLabel("if.else")
	mergeLabel := c.nextLabel("if.merge")

	if len(s.ElseBlock) > 0 {
		c.emit("  br i1 %s, label %%%s, label %%%s", condReg, thenLabel, elseLabel)
	} else {
		c.emit("  br i1 %s, label %%%s, label %%%s", condReg, thenLabel, mergeLabel)
	}

	// Then block
	c.emit("%s:", thenLabel)
	c.enterScope()
	for _, stmt := range s.ThenBlock {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", mergeLabel)

	// Else block
	if len(s.ElseBlock) > 0 {
		c.emit("%s:", elseLabel)
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
	if condType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, condReg)
		condReg = reg
	}
	c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, endLabel)

	c.emit("%s:", bodyLabel)
	c.enterScope()
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.exitScope(false)
	c.emit("  br label %%%s", condLabel)

	c.emit("%s:", endLabel)
}

func (c *LLVMCompiler) compileLoopStatement(s *ast.LoopStatement) {
	bodyLabel := c.nextLabel("loop.body")
	c.emit("  br label %%%s", bodyLabel)
	c.emit("%s:", bodyLabel)
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
	c.emit("  br label %%%s", bodyLabel)
}

func (c *LLVMCompiler) compileFunctionStatement(s *ast.FunctionStatement) {
	// 切换到函数输出缓冲区
	oldOutput := c.output
	c.output = bytes.Buffer{}
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
		// 统一使用 i8* (对象指针)
		params = append(params, "i8* %\""+p.Name.Value+"_arg\"")
	}

	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")

	// 进入函数作用域
	c.enterScope()

	// 为参数分配本地内存
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emit("  %s = alloca i8*", addrReg)
		c.emit("  store i8* %%\"%s_arg\", i8** %s", p.Name.Value, addrReg)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i8*"}
		// 追踪参数以便退出时 release
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

	c.funcOutput.Write(c.output.Bytes())
	c.output = oldOutput
	c.currentFunc = oldFunc
	c.symbolTable = oldTable
	c.scopeStack = oldScopeStack
}

func (c *LLVMCompiler) compileExpression(expr ast.Expression) (string, string, string) {
	switch e := expr.(type) {
	case *ast.IntegerLiteral:
		// Tagged Integer: (val << 1) | 1
		tagged := (e.Value << 1) | 1
		return fmt.Sprintf("%d", tagged), "i64", ""
	case *ast.FloatLiteral:
		return fmt.Sprintf("%f", e.Value), "double", ""
	case *ast.BooleanLiteral:
		// Tagged Boolean: True=4, False=2
		if e.Value {
			return "4", "i64", ""
		}
		return "2", "i64", ""
	case *ast.StringLiteral:
		alias := c.addString(e.Value)
		rawReg := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0",
			rawReg, len(e.Value)+1, len(e.Value)+1, alias)
		objReg := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", objReg, rawReg)
		return objReg, "%XTString*", ""
	case *ast.Identifier:
		if info, ok := c.symbolTable[e.Value]; ok {
			reg := c.nextReg()
			c.emit("  %s = load %s, %s* %s", reg, info.Type, info.Type, info.AddrReg)
			return reg, info.Type, info.ClassName
		}
		return "0", "i64", ""
	case *ast.PrefixExpression:
		right, _, _ := c.compileExpression(e.Right)
		reg := c.nextReg()
		if e.Operator == "!" || e.Operator == "非" {
			c.emit("  %s = xor i1 %s, 1", reg, right)
			return reg, "i1", ""
		}
		if e.Operator == "-" {
			c.emit("  %s = sub i64 0, %s", reg, right)
			return reg, "i64", ""
		}
		return "0", "i64", ""
	case *ast.CallExpression:
		// 特殊处理 成功 和 失败
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
				return reg, "i8*", ""
			}
		}

		funcName := ""
		if ident, ok := e.Function.(*ast.Identifier); ok {
			funcName = "@\"" + ident.Value + "\""
		}
		args := []string{}
		for _, a := range e.Arguments {
			valReg, valType, _ := c.compileExpression(a)
			objReg, objType := c.convertToObj(valReg, valType)
			args = append(args, objType+" "+objReg)
		}
		reg := c.nextReg()
		// 注意：目前所有自定义函数参数均预期 i8*
		c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
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
				args = append(args, thisType+" "+thisObj)

				for _, a := range e.Arguments {
					valReg, valType, _ := c.compileExpression(a)
					objReg, objType := c.convertToObj(valReg, valType)
					args = append(args, objType+" "+objReg)
				}
				c.emit("  call i64 %s(%s)", constr, strings.Join(args, ", "))
			}
		}

		return reg, "%XTInstance*", className
	case *ast.ArrayLiteral:
		reg := c.nextReg()
		c.emit("  %s = call %%XTArray* @xt_array_new(i64 %d)", reg, len(e.Elements))
		for _, el := range e.Elements {
			valReg, valType, _ := c.compileExpression(el)
			objReg, _ := c.convertToObj(valReg, valType)
			c.emit("  call void @xt_array_append(%%XTArray* %s, i8* %s)", reg, objReg)
		}
		return reg, "%XTArray*", ""
	case *ast.IndexExpression:
		leftReg, leftType, _ := c.compileExpression(e.Left)
		idxReg, _, _ := c.compileExpression(e.Index)
		if leftType == "%XTArray*" {
			elemPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, leftReg)
			elemsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
			elemPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
			valPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", valPtr, elemPtr)
			return valPtr, "i8*", ""
		}
		return "0", "i64", ""
	case *ast.MemberCallExpression:
		objReg, objType, objClass := c.compileExpression(e.Object)
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
				fieldIdx := 0
				if info, ok := c.classes[objClass]; ok {
					if idx, ok := info.Fields[e.Member.Value]; ok {
						fieldIdx = idx
					}
				} else {
					// 兜底方案
					for _, cls := range c.classes {
						if idx, ok := cls.Fields[e.Member.Value]; ok {
							fieldIdx = idx
							break
						}
					}
				}

				fieldsPtrPtr := c.nextReg()
				c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
				fieldsPtr := c.nextReg()
				c.emit("  %s = load i8**, i8*** %s", fieldsPtr, fieldsPtrPtr)
				fieldPtr := c.nextReg()
				c.emit("  %s = getelementptr i8*, i8** %s, i64 %d", fieldPtr, fieldsPtr, fieldIdx)
				valPtr := c.nextReg()
				c.emit("  %s = load i8*, i8** %s", valPtr, fieldPtr)
				return valPtr, "i8*", ""
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
					args = append(args, thisType+" "+thisObj)

					for _, a := range e.Arguments {
						valReg, valType, _ := c.compileExpression(a)
						objReg, objType := c.convertToObj(valReg, valType)
						args = append(args, objType+" "+objReg)
					}
					reg := c.nextReg()
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
					return reg, "i64", ""
				}
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

		// 如果是对象，尝试转为整数 (针对 + - * / 等)
		if leftType == "i8*" || leftType == "ptr" || strings.HasSuffix(leftType, "*") {
			// 只有在不是运算符重载的情况下才转为整数
			// 但我们现在无法确定是否是重载，所以先尝试查找
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
					foundMagic = true // 确定是实例且有类信息
				} else if leftType == "%XTInstance*" {
					foundMagic = true
				}
			}

			if !foundMagic {
				reg := c.nextReg()
				c.emit("  %s = call i64 @xt_to_int(i8* %s)", reg, leftReg)
				leftReg = reg
				leftType = "i64"
			} else {
				// 执行运算符重载
				funcName := ""
				if info, ok := c.classes[leftClass]; ok {
					funcName = info.Methods[magicMethod]
				}

				if funcName != "" {
					args := []string{}
					thisObj, thisType := c.convertToObj(leftReg, leftType)
					args = append(args, thisType+" "+thisObj)
					objReg, objType := c.convertToObj(rightReg, rightType)
					args = append(args, objType+" "+objReg)

					reg := c.nextReg()
					c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
					return reg, "i64", ""
				} else {
					// 没找到重载，退回到普通运算
					reg := c.nextReg()
					c.emit("  %s = call i64 @xt_to_int(i8* %s)", reg, leftReg)
					leftReg = reg
					leftType = "i64"
				}
			}
		}
		if rightType == "i8*" || rightType == "ptr" || strings.HasSuffix(rightType, "*") {
			reg := c.nextReg()
			c.emit("  %s = call i64 @xt_to_int(i8* %s)", reg, rightReg)
			rightReg = reg
			rightType = "i64"
		}

		if e.Operator == "&" {
			lObj, _ := c.convertToObj(leftReg, leftType)
			lStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i8* %s)", lStr, lObj)

			rObj, _ := c.convertToObj(rightReg, rightType)
			rStr := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_obj_to_string(i8* %s)", rStr, rObj)

			resReg := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_concat(%%XTString* %s, %%XTString* %s)", resReg, lStr, rStr)
			return resReg, "%XTString*", ""
		}

		reg := c.nextReg()
		// 处理比较运算
		switch e.Operator {
		case "==", "!=":
			// 对于 Tagged Values，相等性可以直接比较
			op := "eq"
			if e.Operator == "!=" {
				op = "ne"
			}
			c.emit("  %s = icmp %s i64 %s, %s", reg, op, leftReg, rightReg)
			return reg, "i1", ""
		case "<", ">", "<=", ">=":
			// 大小比较需要 untag
			lUntag := c.nextReg()
			c.emit("  %s = ashr i64 %s, 1", lUntag, leftReg)
			rUntag := c.nextReg()
			c.emit("  %s = ashr i64 %s, 1", rUntag, rightReg)

			var op string
			switch e.Operator {
			case "<":
				op = "slt"
			case ">":
				op = "sgt"
			case "<=":
				op = "sle"
			case ">=":
				op = "sge"
			}
			c.emit("  %s = icmp %s i64 %s, %s", reg, op, lUntag, rUntag)
			return reg, "i1", ""
		}

		// 算术运算：先 untag，运算后 retag
		lUntag := c.nextReg()
		c.emit("  %s = ashr i64 %s, 1", lUntag, leftReg)
		rUntag := c.nextReg()
		c.emit("  %s = ashr i64 %s, 1", rUntag, rightReg)

		resRaw := c.nextReg()
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
		c.emit("  %s = %s i64 %s, %s", resRaw, op, lUntag, rUntag)

		// Retag: (res << 1) | 1
		resShift := c.nextReg()
		c.emit("  %s = shl i64 %s, 1", resShift, resRaw)
		c.emit("  %s = or i64 %s, 1", reg, resShift)
		return reg, "i64", ""
	}
	return "0", "i64", ""
}

func (c *LLVMCompiler) compileLogicalAnd(e *ast.InfixExpression) (string, string, string) {
	leftReg, leftType, _ := c.compileExpression(e.Left)
	if leftType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, leftReg)
		leftReg = reg
	}
	resAddr := c.nextReg()
	c.emit("  %s = alloca i1", resAddr)
	c.emit("  store i1 %s, i1* %s", leftReg, resAddr)

	rhsLabel := c.nextLabel("and.rhs")
	endLabel := c.nextLabel("and.end")

	c.emit("  br i1 %s, label %%%s, label %%%s", leftReg, rhsLabel, endLabel)
	c.emit("%s:", rhsLabel)
	rightReg, rightType, _ := c.compileExpression(e.Right)
	if rightType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, rightReg)
		rightReg = reg
	}
	c.emit("  store i1 %s, i1* %s", rightReg, resAddr)
	c.emit("  br label %%%s", endLabel)

	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = load i1, i1* %s", resReg, resAddr)
	return resReg, "i1", ""
}

func (c *LLVMCompiler) compileLogicalOr(e *ast.InfixExpression) (string, string, string) {
	leftReg, leftType, _ := c.compileExpression(e.Left)
	if leftType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, leftReg)
		leftReg = reg
	}
	resAddr := c.nextReg()
	c.emit("  %s = alloca i1", resAddr)
	c.emit("  store i1 %s, i1* %s", leftReg, resAddr)

	rhsLabel := c.nextLabel("or.rhs")
	endLabel := c.nextLabel("or.end")

	c.emit("  br i1 %s, label %%%s, label %%%s", leftReg, endLabel, rhsLabel)
	c.emit("%s:", rhsLabel)
	rightReg, rightType, _ := c.compileExpression(e.Right)
	if rightType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, rightReg)
		rightReg = reg
	}
	c.emit("  store i1 %s, i1* %s", rightReg, resAddr)
	c.emit("  br label %%%s", endLabel)

	c.emit("%s:", endLabel)
	resReg := c.nextReg()
	c.emit("  %s = load i1, i1* %s", resReg, resAddr)
	return resReg, "i1", ""
}

func (c *LLVMCompiler) compileMatchStatement(s *ast.MatchStatement) {
	valReg, valType, _ := c.compileExpression(s.Value)
	mergeLabel := c.nextLabel("match.merge")

	for _, cas := range s.Cases {
		nextCaseLabel := c.nextLabel("match.next")
		bodyLabel := c.nextLabel("match.body")

		if ident, ok := cas.Pattern.(*ast.Identifier); ok && ident.Value == "_" {
			c.emit("  br label %%%s", bodyLabel)
		} else {
			patReg, patType, _ := c.compileExpression(cas.Pattern)
			condReg := c.nextReg()
			if valType == "i64" && patType == "i64" {
				c.emit("  %s = icmp eq i64 %s, %s", condReg, valReg, patReg)
			} else {
				c.emit("  %s = icmp eq i64 %s, %s", condReg, valReg, patReg)
			}
			c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, nextCaseLabel)
		}

		c.emit("%s:", bodyLabel)
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
	iterReg, iterType, _ := c.compileExpression(s.Iterable)
	if iterType != "%XTArray*" {
		return
	}

	condLabel := c.nextLabel("for.cond")
	bodyLabel := c.nextLabel("for.body")
	endLabel := c.nextLabel("for.end")

	idxAddr := c.nextReg()
	c.emit("  %s = alloca i64", idxAddr)
	c.emit("  store i64 0, i64* %s", idxAddr)
	c.emit("  br label %%%s", condLabel)

	c.emit("%s:", condLabel)
	idxReg := c.nextReg()
	c.emit("  %s = load i64, i64* %s", idxReg, idxAddr)
	lenPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 3", lenPtr, iterReg)
	lenReg := c.nextReg()
	c.emit("  %s = load i64, i64* %s", lenReg, lenPtr)
	condReg := c.nextReg()
	c.emit("  %s = icmp slt i64 %s, %s", condReg, idxReg, lenReg)
	c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, endLabel)

	c.emit("%s:", bodyLabel)
	c.enterScope()
	elemPtrPtr := c.nextReg()
	c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, iterReg)
	elemsPtr := c.nextReg()
	c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
	elemPtr := c.nextReg()
	c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
	valPtr := c.nextReg()
	c.emit("  %s = load i8*, i8** %s", valPtr, elemPtr)

	if len(s.Variables) == 1 {
		varAddr := "%\"" + s.Variables[0].Value + "\""
		c.emit("  %s = alloca i8*", varAddr)
		c.emit("  store i8* %s, i8** %s", valPtr, varAddr)
		c.symbolTable[s.Variables[0].Value] = SymbolInfo{AddrReg: varAddr, Type: "i8*"}
		c.trackObject(varAddr)
	} else if len(s.Variables) >= 2 {
		// 解构赋值: index, value
		idxAddrVar := "%\"" + s.Variables[0].Value + "\""
		c.emit("  %s = alloca i64", idxAddrVar)
		c.emit("  store i64 %s, i64* %s", idxReg, idxAddrVar)
		c.symbolTable[s.Variables[0].Value] = SymbolInfo{AddrReg: idxAddrVar, Type: "i64"}
		c.trackObject(idxAddrVar)

		valAddrVar := "%\"" + s.Variables[1].Value + "\""
		c.emit("  %s = alloca i8*", valAddrVar)
		c.emit("  store i8* %s, i8** %s", valPtr, valAddrVar)
		c.symbolTable[s.Variables[1].Value] = SymbolInfo{AddrReg: valAddrVar, Type: "i8*"}
		c.trackObject(valAddrVar)
	}

	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}

	c.exitScope(false)

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
		if info, ok := c.symbolTable[left.Value]; ok {
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, info.AddrReg)
		}
	case *ast.IndexExpression:
		leftReg, leftType, _ := c.compileExpression(left.Left)
		idxReg, _, _ := c.compileExpression(left.Index)
		if leftType == "%XTArray*" {
			elemPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, leftReg)
			elemsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
			elemPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
			objReg, _ := c.convertToObj(valReg, valType)
			c.emit("  store i8* %s, i8** %s", objReg, elemPtr)
		}
	case *ast.MemberCallExpression:
		objReg, objType, objClass := c.compileExpression(left.Object)
		// 如果是 i8*，尝试 bitcast 回 %XTInstance*
		if objType == "i8*" || objType == "ptr" {
			newReg := c.nextReg()
			c.emit("  %s = bitcast %s %s to %%XTInstance*", newReg, objType, objReg)
			objReg = newReg
			objType = "%XTInstance*"
		}

		if objType == "%XTInstance*" {
			// 查找字段索引
			fieldIdx := 0
			if info, ok := c.classes[objClass]; ok {
				if idx, ok := info.Fields[left.Member.Value]; ok {
					fieldIdx = idx
				}
			} else {
				// 兜底方案
				for _, cls := range c.classes {
					if idx, ok := cls.Fields[left.Member.Value]; ok {
						fieldIdx = idx
						break
					}
				}
			}

			fieldsPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
			fieldsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", fieldsPtr, fieldsPtrPtr)
			fieldPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %d", fieldPtr, fieldsPtr, fieldIdx)
			objReg, _ := c.convertToObj(valReg, valType)
			c.emit("  store i8* %s, i8** %s", objReg, fieldPtr)
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

	for _, stmt := range s.Block {
		switch m := stmt.(type) {
		case *ast.VarStatement:
			// 字段已在上方处理
		case *ast.FunctionStatement:
			funcName := fmt.Sprintf("@\"%s_%s\"", s.Name.Value, m.Name.Value)
			classInfo.Methods[m.Name.Value] = funcName
			c.compileMethodStatement(s.Name.Value, m)
		}
	}

	c.currentClass = oldClass
}

func (c *LLVMCompiler) compileMethodStatement(className string, s *ast.FunctionStatement) {
	// 切换到函数输出缓冲区
	oldOutput := c.output
	c.output = bytes.Buffer{}
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
	params := []string{"i8* %\"this_arg\""} // 方法首个参数永远是 this (i8*)
	for _, p := range s.Parameters {
		params = append(params, "i8* %\""+p.Name.Value+"_arg\"")
	}

	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")

	// 进入方法作用域
	c.enterScope()

	// 绑定 this
	thisAddr := "%\"此\"" // 支持中文 "此" 或 "this"
	c.emit("  %s = alloca i8*", thisAddr)
	c.emit("  store i8* %%\"this_arg\", i8** %s", thisAddr)
	c.symbolTable["此"] = SymbolInfo{AddrReg: thisAddr, Type: "i8*", ClassName: className}
	c.symbolTable["this"] = SymbolInfo{AddrReg: thisAddr, Type: "i8*", ClassName: className}
	c.trackObject(thisAddr)

	// 为其他参数分配本地内存
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emit("  %s = alloca i8*", addrReg)
		c.emit("  store i8* %%\"%s_arg\", i8** %s", p.Name.Value, addrReg)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i8*"}
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

	c.funcOutput.Write(c.output.Bytes())
	c.output = oldOutput
	c.currentFunc = oldFunc
	c.symbolTable = oldTable
	c.scopeStack = oldScopeStack
}
