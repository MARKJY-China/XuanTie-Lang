package compiler

import (
	"bytes"
	"fmt"
	"strings"
	"xuantie/ast"
)

type SymbolInfo struct {
	AddrReg  string
	Type     string // i64, %XTString*, i1, double
	IsGlobal bool
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
	currentFunc  string // 为空表示在 main 中
}

func NewLLVMCompiler(program *ast.Program) *LLVMCompiler {
	return &LLVMCompiler{
		program:     program,
		symbolTable: make(map[string]SymbolInfo),
		strings:     make(map[string]string),
	}
}

func (c *LLVMCompiler) Compile() string {
	var body bytes.Buffer
	oldOutput := c.output
	c.output = body

	// 转译主体语句
	for _, stmt := range c.program.Statements {
		c.compileStatement(stmt)
	}
	mainBody := c.output.String()
	c.output = oldOutput

	// 1. 写入模块头
	c.emit("; XuanTie v0.11.2 LLVM Backend")
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
	c.emit("declare void @xt_init()")
	c.emit("declare void @xt_print_int(i64)")
	c.emit("declare void @xt_print_string(%%XTString*)")
	c.emit("declare void @xt_print_bool(i1)")
	c.emit("declare void @xt_print_float(double)")
	c.emit("declare i8* @xt_int_new(i64)")
	c.emit("declare %%XTString* @xt_string_new(i8*)")
	c.emit("declare %%XTArray* @xt_array_new(i64)")
	c.emit("declare void @xt_array_append(%%XTArray*, i8*)")
	c.emit("declare %%XTInstance* @xt_instance_new(i8*, i64)")
	c.emit("declare %%XTString* @xt_string_concat(%%XTString*, %%XTString*)")
	c.emit("declare %%XTString* @xt_int_to_string(i64)")
	c.emit("declare void @xt_retain(i8*)")
	c.emit("declare void @xt_release(i8*)")
	c.emit("declare i64 @xt_to_int(i8*)")
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

func (c *LLVMCompiler) compileStatement(stmt ast.Statement) {
	switch s := stmt.(type) {
	case *ast.PrintStatement:
		valReg, valType := c.compileExpression(s.Value)
		switch valType {
		case "%XTString*":
			c.emit("  call void @xt_print_string(%%XTString* %s)", valReg)
		case "i1":
			c.emit("  call void @xt_print_bool(i1 %s)", valReg)
		case "double":
			c.emit("  call void @xt_print_float(double %s)", valReg)
		default:
			c.emit("  call void @xt_print_int(i64 %s)", valReg)
		}
	case *ast.VarStatement:
		valReg, valType := c.compileExpression(s.Value)
		if c.currentFunc == "" {
			// 全局变量
			addrReg := "@\"" + s.Name.Value + "\""
			initVal := "0"
			if strings.HasSuffix(valType, "*") {
				initVal = "null"
			}
			c.globalOutput.WriteString(fmt.Sprintf("%s = global %s %s\n", addrReg, valType, initVal))
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: valType, IsGlobal: true}
		} else {
			// 本地变量
			addrReg := "%\"" + s.Name.Value + "\""
			c.emit("  %s = alloca %s", addrReg, valType)
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, addrReg)
			c.symbolTable[s.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: valType, IsGlobal: false}
		}
	case *ast.AssignStatement:
		valReg, valType := c.compileExpression(s.Value)
		if info, ok := c.symbolTable[s.Name]; ok {
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, info.AddrReg)
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
		valReg, valType := c.compileExpression(s.ReturnValue)
		if valType == "i1" {
			reg := c.nextReg()
			c.emit("  %s = zext i1 %s to i64", reg, valReg)
			valReg = reg
			valType = "i64"
		}
		// 目前所有自定义函数都返回 i64
		c.emit("  ret i64 %s", valReg)
	case *ast.ExpressionStatement:
		c.compileExpression(s.Expression)
	}
}

func (c *LLVMCompiler) compileIfStatement(s *ast.IfStatement) {
	condReg, condType := c.compileExpression(s.Condition)
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
	for _, stmt := range s.ThenBlock {
		c.compileStatement(stmt)
	}
	c.emit("  br label %%%s", mergeLabel)

	// Else block
	if len(s.ElseBlock) > 0 {
		c.emit("%s:", elseLabel)
		for _, stmt := range s.ElseBlock {
			c.compileStatement(stmt)
		}
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
	condReg, condType := c.compileExpression(s.Condition)
	if condType == "i64" {
		reg := c.nextReg()
		c.emit("  %s = icmp ne i64 %s, 0", reg, condReg)
		condReg = reg
	}
	c.emit("  br i1 %s, label %%%s, label %%%s", condReg, bodyLabel, endLabel)

	c.emit("%s:", bodyLabel)
	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}
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

	// 保存旧符号表
	oldTable := make(map[string]SymbolInfo)
	for k, v := range c.symbolTable {
		oldTable[k] = v
	}

	funcName := "@\"" + s.Name.Value + "\""
	params := []string{}
	for _, p := range s.Parameters {
		// 暂时统一使用 i64
		params = append(params, "i64 %\""+p.Name.Value+"_arg\"")
	}

	c.emit("define i64 %s(%s) {", funcName, strings.Join(params, ", "))
	c.emit("entry:")

	// 为参数分配本地内存
	for _, p := range s.Parameters {
		addrReg := "%\"" + p.Name.Value + "\""
		c.emit("  %s = alloca i64", addrReg)
		c.emit("  store i64 %%\"%s_arg\", i64* %s", p.Name.Value, addrReg)
		c.symbolTable[p.Name.Value] = SymbolInfo{AddrReg: addrReg, Type: "i64"}
	}

	for _, stmt := range s.Body {
		c.compileStatement(stmt)
	}

	// 确保函数总是有返回
	c.emit("  ret i64 0")
	c.emit("}")

	c.funcOutput.Write(c.output.Bytes())
	c.output = oldOutput
	c.currentFunc = oldFunc
	c.symbolTable = oldTable
}

func (c *LLVMCompiler) compileExpression(expr ast.Expression) (string, string) {
	switch e := expr.(type) {
	case *ast.IntegerLiteral:
		return fmt.Sprintf("%d", e.Value), "i64"
	case *ast.FloatLiteral:
		return fmt.Sprintf("%f", e.Value), "double"
	case *ast.BooleanLiteral:
		if e.Value {
			return "1", "i1"
		}
		return "0", "i1"
	case *ast.StringLiteral:
		alias := c.addString(e.Value)
		rawReg := c.nextReg()
		c.emit("  %s = getelementptr inbounds [%d x i8], [%d x i8]* @%s, i64 0, i64 0",
			rawReg, len(e.Value)+1, len(e.Value)+1, alias)
		objReg := c.nextReg()
		c.emit("  %s = call %%XTString* @xt_string_new(i8* %s)", objReg, rawReg)
		return objReg, "%XTString*"
	case *ast.Identifier:
		if info, ok := c.symbolTable[e.Value]; ok {
			reg := c.nextReg()
			c.emit("  %s = load %s, %s* %s", reg, info.Type, info.Type, info.AddrReg)
			return reg, info.Type
		}
		return "0", "i64"
	case *ast.PrefixExpression:
		right, _ := c.compileExpression(e.Right)
		reg := c.nextReg()
		if e.Operator == "!" || e.Operator == "非" {
			c.emit("  %s = xor i1 %s, 1", reg, right)
			return reg, "i1"
		}
		if e.Operator == "-" {
			c.emit("  %s = sub i64 0, %s", reg, right)
			return reg, "i64"
		}
		return "0", "i64"
	case *ast.CallExpression:
		funcName := ""
		if ident, ok := e.Function.(*ast.Identifier); ok {
			funcName = "@\"" + ident.Value + "\""
		}
		args := []string{}
		for _, a := range e.Arguments {
			valReg, _ := c.compileExpression(a)
			args = append(args, "i64 "+valReg)
		}
		reg := c.nextReg()
		c.emit("  %s = call i64 %s(%s)", reg, funcName, strings.Join(args, ", "))
		return reg, "i64"
	case *ast.NewExpression:
		// 目前简单处理：假设所有类都有 10 个字段空间
		reg := c.nextReg()
		c.emit("  %s = call %%XTInstance* @xt_instance_new(i8* null, i64 10)", reg)
		return reg, "%XTInstance*"
	case *ast.ArrayLiteral:
		reg := c.nextReg()
		c.emit("  %s = call %%XTArray* @xt_array_new(i64 %d)", reg, len(e.Elements))
		for _, el := range e.Elements {
			valReg, valType := c.compileExpression(el)
			bitcastReg := c.nextReg()
			if valType == "i64" {
				c.emit("  %s = call i8* @xt_int_new(i64 %s)", bitcastReg, valReg)
			} else {
				c.emit("  %s = bitcast %s %s to i8*", bitcastReg, valType, valReg)
			}
			c.emit("  call void @xt_array_append(%%XTArray* %s, i8* %s)", reg, bitcastReg)
		}
		return reg, "%XTArray*"
	case *ast.IndexExpression:
		leftReg, leftType := c.compileExpression(e.Left)
		idxReg, _ := c.compileExpression(e.Index)
		if leftType == "%XTArray*" {
			elemPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, leftReg)
			elemsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
			elemPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
			valPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", valPtr, elemPtr)
			resReg := c.nextReg()
			c.emit("  %s = call i64 @xt_to_int(i8* %s)", resReg, valPtr)
			return resReg, "i64"
		}
		return "0", "i64"
	case *ast.MemberCallExpression:
		objReg, objType := c.compileExpression(e.Object)
		if objType == "%XTInstance*" {
			// 暂时简单映射：首个字段索引 0
			fieldsPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
			fieldsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", fieldsPtr, fieldsPtrPtr)
			fieldPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 0", fieldPtr, fieldsPtr)
			valPtr := c.nextReg()
			c.emit("  %s = load i8*, i8** %s", valPtr, fieldPtr)
			resReg := c.nextReg()
			c.emit("  %s = call i64 @xt_to_int(i8* %s)", resReg, valPtr)
			return resReg, "i64"
		}
		return "0", "i64"
	case *ast.InfixExpression:
		if e.Operator == "且" || e.Operator == "&&" {
			return c.compileLogicalAnd(e)
		}
		if e.Operator == "或" || e.Operator == "||" {
			return c.compileLogicalOr(e)
		}
		if e.Operator == "&" {
			lReg, lType := c.compileExpression(e.Left)
			if lType == "i64" {
				reg := c.nextReg()
				c.emit("  %s = call %%XTString* @xt_int_to_string(i64 %s)", reg, lReg)
				lReg = reg
				lType = "%XTString*"
			}
			rReg, rType := c.compileExpression(e.Right)
			if rType == "i64" {
				reg := c.nextReg()
				c.emit("  %s = call %%XTString* @xt_int_to_string(i64 %s)", reg, rReg)
				rReg = reg
				rType = "%XTString*"
			}
			resReg := c.nextReg()
			c.emit("  %s = call %%XTString* @xt_string_concat(%%XTString* %s, %%XTString* %s)", resReg, lReg, rReg)
			return resReg, "%XTString*"
		}

		left, _ := c.compileExpression(e.Left)
		right, _ := c.compileExpression(e.Right)
		reg := c.nextReg()

		// 处理比较运算
		switch e.Operator {
		case "==", "!=", "<", ">", "<=", ">=":
			var op string
			switch e.Operator {
			case "==":
				op = "eq"
			case "!=":
				op = "ne"
			case "<":
				op = "slt"
			case ">":
				op = "sgt"
			case "<=":
				op = "sle"
			case ">=":
				op = "sge"
			}
			c.emit("  %s = icmp %s i64 %s, %s", reg, op, left, right)
			return reg, "i1"
		}

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
		c.emit("  %s = %s i64 %s, %s", reg, op, left, right)
		return reg, "i64"
	}
	return "0", "i64"
}

func (c *LLVMCompiler) compileLogicalAnd(e *ast.InfixExpression) (string, string) {
	leftReg, leftType := c.compileExpression(e.Left)
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
	rightReg, rightType := c.compileExpression(e.Right)
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
	return resReg, "i1"
}

func (c *LLVMCompiler) compileLogicalOr(e *ast.InfixExpression) (string, string) {
	leftReg, leftType := c.compileExpression(e.Left)
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
	rightReg, rightType := c.compileExpression(e.Right)
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
	return resReg, "i1"
}

func (c *LLVMCompiler) compileMatchStatement(s *ast.MatchStatement) {
	valReg, valType := c.compileExpression(s.Value)
	mergeLabel := c.nextLabel("match.merge")

	for _, cas := range s.Cases {
		nextCaseLabel := c.nextLabel("match.next")
		bodyLabel := c.nextLabel("match.body")

		if ident, ok := cas.Pattern.(*ast.Identifier); ok && ident.Value == "_" {
			c.emit("  br label %%%s", bodyLabel)
		} else {
			patReg, patType := c.compileExpression(cas.Pattern)
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
	iterReg, iterType := c.compileExpression(s.Iterable)
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
	} else if len(s.Variables) >= 2 {
		// 解构赋值: index, value
		idxAddrVar := "%\"" + s.Variables[0].Value + "\""
		c.emit("  %s = alloca i64", idxAddrVar)
		c.emit("  store i64 %s, i64* %s", idxReg, idxAddrVar)
		c.symbolTable[s.Variables[0].Value] = SymbolInfo{AddrReg: idxAddrVar, Type: "i64"}

		valAddrVar := "%\"" + s.Variables[1].Value + "\""
		c.emit("  %s = alloca i8*", valAddrVar)
		c.emit("  store i8* %s, i8** %s", valPtr, valAddrVar)
		c.symbolTable[s.Variables[1].Value] = SymbolInfo{AddrReg: valAddrVar, Type: "i8*"}
	}

	for _, stmt := range s.Block {
		c.compileStatement(stmt)
	}

	newIdx := c.nextReg()
	c.emit("  %s = add i64 %s, 1", newIdx, idxReg)
	c.emit("  store i64 %s, i64* %s", newIdx, idxAddr)
	c.emit("  br label %%%s", condLabel)

	c.emit("%s:", endLabel)
}

func (c *LLVMCompiler) compileComplexAssignStatement(s *ast.ComplexAssignStatement) {
	valReg, valType := c.compileExpression(s.Right)
	switch left := s.Left.(type) {
	case *ast.Identifier:
		if info, ok := c.symbolTable[left.Value]; ok {
			c.emit("  store %s %s, %s* %s", valType, valReg, valType, info.AddrReg)
		}
	case *ast.IndexExpression:
		leftReg, leftType := c.compileExpression(left.Left)
		idxReg, _ := c.compileExpression(left.Index)
		if leftType == "%XTArray*" {
			elemPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTArray, %%XTArray* %s, i32 0, i32 2", elemPtrPtr, leftReg)
			elemsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", elemsPtr, elemPtrPtr)
			elemPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 %s", elemPtr, elemsPtr, idxReg)
			bitcastReg := c.nextReg()
			if valType == "i64" {
				c.emit("  %s = call i8* @xt_int_new(i64 %s)", bitcastReg, valReg)
			} else {
				c.emit("  %s = bitcast %s %s to i8*", bitcastReg, valType, valReg)
			}
			c.emit("  store i8* %s, i8** %s", bitcastReg, elemPtr)
		}
	case *ast.MemberCallExpression:
		objReg, objType := c.compileExpression(left.Object)
		if objType == "%XTInstance*" {
			fieldsPtrPtr := c.nextReg()
			c.emit("  %s = getelementptr %%XTInstance, %%XTInstance* %s, i32 0, i32 3", fieldsPtrPtr, objReg)
			fieldsPtr := c.nextReg()
			c.emit("  %s = load i8**, i8*** %s", fieldsPtr, fieldsPtrPtr)
			fieldPtr := c.nextReg()
			c.emit("  %s = getelementptr i8*, i8** %s, i64 0", fieldPtr, fieldsPtr)
			bitcastReg := c.nextReg()
			if valType == "i64" {
				c.emit("  %s = call i8* @xt_int_new(i64 %s)", bitcastReg, valReg)
			} else {
				c.emit("  %s = bitcast %s %s to i8*", bitcastReg, valType, valReg)
			}
			c.emit("  store i8* %s, i8** %s", bitcastReg, fieldPtr)
		}
	}
}

func (c *LLVMCompiler) compileTypeDefinitionStatement(s *ast.TypeDefinitionStatement) {
	c.emit("  ; 定义类: %s", s.Name.Value)
}
