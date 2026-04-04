package compiler

import (
	"bytes"
	"fmt"
	"io/ioutil"
	"path/filepath"
	"strings"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/parser"
)

type GoCompiler struct {
	program     *ast.Program
	output      bytes.Buffer
	modules     map[string]string // 缓存已转译的模块路径和生成的函数名
	moduleCode  bytes.Buffer      // 存储所有模块生成的 Go 代码
	importStack []string          // 用于循环引用检测
	errors      []string
}

func (c *GoCompiler) Errors() []string {
	return c.errors
}

func New(program *ast.Program) *GoCompiler {
	return &GoCompiler{
		program: program,
		modules: make(map[string]string),
	}
}

func (c *GoCompiler) Compile() string {
	if c.program.FilePath != "" {
		absPath, _ := filepath.Abs(c.program.FilePath)
		c.importStack = append(c.importStack, absPath)
	}
	c.writeHeader()
	c.writeBody()
	c.writeFooter()
	// 将收集到的模块代码追加到末尾
	c.output.Write(c.moduleCode.Bytes())
	return c.output.String()
}

func (c *GoCompiler) writeHeader() {
	c.output.WriteString("package main\n\n")
	c.output.WriteString("import (\n")
	c.output.WriteString("\t\"fmt\"\n")
	c.output.WriteString("\t\"reflect\"\n")
	c.output.WriteString(")\n\n")

	// 辅助函数：将 XuanTie 的 interface{} 值转为字符串用于打印
	c.output.WriteString("// inspect 模拟玄铁 object.Inspect() 功能\n")
	c.output.WriteString("func inspect(v interface{}) string {\n")
	c.output.WriteString("\tif v == nil { return \"空\" }\n")
	c.output.WriteString("\tswitch val := v.(type) {\n")
	c.output.WriteString("\tcase bool:\n")
	c.output.WriteString("\t\tif val { return \"真\" }\n")
	c.output.WriteString("\t\treturn \"假\"\n")
	c.output.WriteString("\tdefault:\n")
	c.output.WriteString("\t\treturn fmt.Sprintf(\"%v\", val)\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("}\n\n")

	// 运行时辅助逻辑
	c.output.WriteString("func isTruthy(v interface{}) bool {\n")
	c.output.WriteString("\tif v == nil { return false }\n")
	c.output.WriteString("\tswitch val := v.(type) {\n")
	c.output.WriteString("\tcase bool: return val\n")
	c.output.WriteString("\tcase int64: return val != 0\n")
	c.output.WriteString("\tcase float64: return val != 0\n")
	c.output.WriteString("\tcase string: return val != \"\"\n")
	c.output.WriteString("\tdefault: return true\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func add(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li + ri }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return float64(li) + rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif lf, ok := l.(float64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return lf + float64(ri) }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return lf + rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn fmt.Sprintf(\"%v%v\", l, r)\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func lt(l, r interface{}) bool {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li < ri }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn false\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func gt(l, r interface{}) bool {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li > ri }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn false\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func toSlice(v interface{}) []interface{} {\n")
	c.output.WriteString("\tif s, ok := v.([]interface{}); ok { return s }\n")
	c.output.WriteString("\treturn []interface{}{}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func call(fn interface{}, args []interface{}) interface{} {\n")
	c.output.WriteString("\tif fn == nil { return nil }\n")
	c.output.WriteString("\tif f, ok := fn.(func([]interface{}) interface{}); ok { return f(args) }\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func index(left, idx interface{}) interface{} {\n")
	c.output.WriteString("\tif arr, ok := left.([]interface{}); ok {\n")
	c.output.WriteString("\t\tif i, ok := idx.(int64); ok && i >= 0 && i < int64(len(arr)) {\n")
	c.output.WriteString("\t\t\treturn arr[i]\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif dict, ok := left.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\tif s, ok := idx.(string); ok {\n")
	c.output.WriteString("\t\t\treturn dict[s]\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func getAttr(obj, attr interface{}) interface{} {\n")
	c.output.WriteString("\tif dict, ok := obj.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\tif s, ok := attr.(string); ok { return dict[s] }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif res, ok := obj.(*Result); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"接着\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif res.IsSuccess && len(args) > 0 {\n")
	c.output.WriteString("\t\t\t\t\treturn call(args[0], []interface{}{res.Value})\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\treturn res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"否则\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif !res.IsSuccess && len(args) > 0 {\n")
	c.output.WriteString("\t\t\t\t\treturn call(args[0], []interface{}{res.Error})\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\treturn res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("type Result struct {\n")
	c.output.WriteString("\tIsSuccess bool\n")
	c.output.WriteString("\tValue     interface{}\n")
	c.output.WriteString("\tError     interface{}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func (r *Result) String() string {\n")
	c.output.WriteString("\tif r.IsSuccess { return fmt.Sprintf(\"成功(%v)\", r.Value) }\n")
	c.output.WriteString("\treturn fmt.Sprintf(\"失败(%v)\", r.Error)\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("type Task struct {\n")
	c.output.WriteString("\tch     chan interface{}\n")
	c.output.WriteString("\tValue  interface{}\n")
	c.output.WriteString("\tIsDone bool\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func await(v interface{}) interface{} {\n")
	c.output.WriteString("\tif t, ok := v.(*Task); ok {\n")
	c.output.WriteString("\t\tif t.IsDone { return t.Value }\n")
	c.output.WriteString("\t\tt.Value = <-t.ch\n")
	c.output.WriteString("\t\tt.IsDone = true\n")
	c.output.WriteString("\t\treturn t.Value\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn v\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func main() {\n")
}

func (c *GoCompiler) writeFooter() {
	c.output.WriteString("}\n")

	// 写入一些通用的逻辑
	c.output.WriteString("\n// 基础算术与逻辑辅助函数\n")
	c.output.WriteString("func sub(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li - ri }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return float64(li) - rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif lf, ok := l.(float64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return lf - float64(ri) }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return lf - rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n")

	c.output.WriteString("func mul(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li * ri }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return float64(li) * rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif lf, ok := l.(float64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return lf * float64(ri) }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok { return lf * rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n")

	c.output.WriteString("func div(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok {\n")
	c.output.WriteString("\t\t\tif ri == 0 { panic(\"除零错误\") }\n")
	c.output.WriteString("\t\t\treturn li / ri\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok && rf != 0 { return float64(li) / rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif lf, ok := l.(float64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok && ri != 0 { return lf / float64(ri) }\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok && rf != 0 { return lf / rf }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n")
}

func (c *GoCompiler) writeBody() {
	for _, stmt := range c.program.Statements {
		c.writeStatement(stmt, 1)
	}
}

func (c *GoCompiler) writeStatement(stmt ast.Statement, indent int) {
	indentStr := strings.Repeat("\t", indent)
	switch s := stmt.(type) {
	case *ast.VarStatement:
		c.output.WriteString(fmt.Sprintf("%svar %s interface{} = %s\n", indentStr, s.Name.Value, c.expressionCode(s.Value, true)))
		c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, s.Name.Value))
	case *ast.AssignStatement:
		c.output.WriteString(fmt.Sprintf("%s%s = %s\n", indentStr, s.Name, c.expressionCode(s.Value, true)))
	case *ast.PrintStatement:
		c.output.WriteString(fmt.Sprintf("%sfmt.Println(inspect(%s))\n", indentStr, c.expressionCode(s.Value, false)))
	case *ast.IfStatement:
		c.output.WriteString(fmt.Sprintf("%sif isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition, false)))
		for _, stmt := range s.ThenBlock {
			c.writeStatement(stmt, indent+1)
		}
		for _, eif := range s.ElseIfs {
			c.output.WriteString(fmt.Sprintf("%s} else if isTruthy(%s) {\n", indentStr, c.expressionCode(eif.Condition, false)))
			for _, stmt := range eif.Block {
				c.writeStatement(stmt, indent+1)
			}
		}
		if len(s.ElseBlock) > 0 {
			c.output.WriteString(fmt.Sprintf("%s} else {\n", indentStr))
			for _, stmt := range s.ElseBlock {
				c.writeStatement(stmt, indent+1)
			}
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.WhileStatement:
		c.output.WriteString(fmt.Sprintf("%sfor isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition, false)))
		for _, stmt := range s.Block {
			c.writeStatement(stmt, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.ForStatement:
		// 基础遍历实现
		c.output.WriteString(fmt.Sprintf("%sfor _, _val := range toSlice(%s) {\n", indentStr, c.expressionCode(s.Iterable, false)))
		c.output.WriteString(fmt.Sprintf("%s\tvar %s interface{} = _val\n", indentStr, s.Variable.Value))
		for _, stmt := range s.Block {
			c.writeStatement(stmt, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.BreakStatement:
		c.output.WriteString(fmt.Sprintf("%sbreak\n", indentStr))
	case *ast.ContinueStatement:
		c.output.WriteString(fmt.Sprintf("%scontinue\n", indentStr))
	case *ast.TryCatchStatement:
		c.output.WriteString(fmt.Sprintf("%sfunc() {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\tdefer func() {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\tif r := recover(); r != nil {\n", indentStr))
		if s.CatchVar != nil {
			c.output.WriteString(fmt.Sprintf("%s\t\t\tvar %s interface{} = fmt.Sprintf(\"%%v\", r)\n", indentStr, s.CatchVar.Value))
			c.output.WriteString(fmt.Sprintf("%s\t\t\t_ = %s\n", indentStr, s.CatchVar.Value))
		}
		for _, stmt := range s.CatchBlock {
			c.writeStatement(stmt, indent+3)
		}
		c.output.WriteString(fmt.Sprintf("%s\t\t}\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t}()\n", indentStr))
		for _, stmt := range s.TryBlock {
			c.writeStatement(stmt, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}()\n", indentStr))
	case *ast.ReturnStatement:
		c.output.WriteString(fmt.Sprintf("%sreturn %s\n", indentStr, c.expressionCode(s.ReturnValue, false)))
	case *ast.ExpressionStatement:
		exprCode := c.expressionCode(s.Expression, false)
		if exprCode != "nil" {
			c.output.WriteString(fmt.Sprintf("%s%s\n", indentStr, exprCode))
		}
	}
}

func (c *GoCompiler) expressionCode(exp ast.Expression, isAssignment bool) string {
	switch e := exp.(type) {
	case *ast.IntegerLiteral:
		return fmt.Sprintf("int64(%d)", e.Value)
	case *ast.FloatLiteral:
		return fmt.Sprintf("float64(%g)", e.Value)
	case *ast.StringLiteral:
		return fmt.Sprintf("%q", e.Value)
	case *ast.BooleanLiteral:
		return fmt.Sprintf("%t", e.Value)
	case *ast.Identifier:
		return e.Value
	case *ast.InfixExpression:
		return c.infixExpressionCode(e, isAssignment)
	case *ast.CallExpression:
		return c.callExpressionCode(e, isAssignment)
	case *ast.MemberCallExpression:
		return c.memberCallExpressionCode(e, isAssignment)
	case *ast.ArrayLiteral:
		return c.arrayLiteralCode(e, isAssignment)
	case *ast.DictLiteral:
		return c.dictLiteralCode(e, isAssignment)
	case *ast.IndexExpression:
		return c.indexExpressionCode(e, isAssignment)
	case *ast.AsyncExpression:
		return c.asyncExpressionCode(e, isAssignment)
	case *ast.ParallelExpression:
		return c.parallelExpressionCode(e, isAssignment)
	case *ast.AwaitExpression:
		return c.awaitExpressionCode(e, isAssignment)
	case *ast.FunctionLiteral:
		return c.functionLiteralCode(e, isAssignment)
	case *ast.ImportExpression:
		return c.importExpressionCode(e, isAssignment)
	}
	return "nil"
}

func (c *GoCompiler) arrayLiteralCode(e *ast.ArrayLiteral, isAssignment bool) string {
	elements := []string{}
	for _, el := range e.Elements {
		elements = append(elements, c.expressionCode(el, isAssignment))
	}
	return fmt.Sprintf("[]interface{}{%s}", strings.Join(elements, ", "))
}

func (c *GoCompiler) dictLiteralCode(e *ast.DictLiteral, isAssignment bool) string {
	pairs := []string{}
	for k, v := range e.Pairs {
		pairs = append(pairs, fmt.Sprintf("%s: %s", c.expressionCode(k, isAssignment), c.expressionCode(v, isAssignment)))
	}
	// 注意：Go 的 map[interface{}]interface{} 或者是特定的结构
	// 这里简单化，我们转为 map[string]interface{}
	return fmt.Sprintf("map[string]interface{}{%s}", strings.Join(pairs, ", "))
}

func (c *GoCompiler) indexExpressionCode(e *ast.IndexExpression, isAssignment bool) string {
	return fmt.Sprintf("index(%s, %s)", c.expressionCode(e.Left, isAssignment), c.expressionCode(e.Index, isAssignment))
}

func (c *GoCompiler) memberCallExpressionCode(e *ast.MemberCallExpression, isAssignment bool) string {
	args := []string{}
	for _, a := range e.Arguments {
		args = append(args, c.expressionCode(a, isAssignment))
	}
	// 转译为 getAttr(obj, "member") 然后调用
	return fmt.Sprintf("call(getAttr(%s, %q), []interface{}{%s})", c.expressionCode(e.Object, isAssignment), e.Member.Value, strings.Join(args, ", "))
}

func (c *GoCompiler) importExpressionCode(e *ast.ImportExpression, isAssignment bool) string {
	path := e.Path
	if !filepath.IsAbs(path) && c.program.FilePath != "" {
		path = filepath.Join(filepath.Dir(c.program.FilePath), path)
	}
	absPath, err := filepath.Abs(path)
	if err != nil {
		return "nil"
	}

	// 循环引用检测
	for _, p := range c.importStack {
		if p == absPath {
			// 发现循环引用
			c.errors = append(c.errors, fmt.Sprintf("[行:%d] 检测到循环引用: %s", e.GetLine(), strings.Join(c.importStack, " -> ")+" -> "+absPath))
			return "nil"
		}
	}

	// 缓存模块函数名，但要区分 assignment 模式
	cacheKey := absPath
	if isAssignment {
		cacheKey += "_pure"
	}

	if funcName, ok := c.modules[cacheKey]; ok {
		return fmt.Sprintf("%s()", funcName)
	}

	// 尚未转译，进行转译
	data, err := ioutil.ReadFile(absPath)
	if err != nil {
		return "nil"
	}

	l := lexer.New(string(data))
	p := parser.New(l)
	subProg := p.ParseProgram()
	subProg.FilePath = absPath

	// 生成唯一函数名
	funcName := fmt.Sprintf("_import_%d", len(c.modules))
	c.modules[cacheKey] = funcName

	// 在 moduleCode 中写入该模块的转译函数
	c.moduleCode.WriteString(fmt.Sprintf("\nfunc %s() map[string]interface{} {\n", funcName))
	c.moduleCode.WriteString("\texports := make(map[string]interface{})\n")

	// 保存主程序的 program 指针，转译子程序
	oldProg := c.program
	c.program = subProg
	c.importStack = append(c.importStack, absPath)
	for _, stmt := range subProg.Statements {
		// 如果是赋值引用，且语句是打印语句或非定义性质的表达式语句，则跳过
		if isAssignment {
			switch stmt.(type) {
			case *ast.PrintStatement, *ast.ExpressionStatement, *ast.IfStatement, *ast.WhileStatement, *ast.ForStatement, *ast.TryCatchStatement:
				continue
			}
		}

		// 如果是变量定义，记录到 exports
		if varStmt, ok := stmt.(*ast.VarStatement); ok {
			c.writeStatementToBuffer(varStmt, 1, &c.moduleCode)
			c.moduleCode.WriteString(fmt.Sprintf("\texports[%q] = %s\n", varStmt.Name.Value, varStmt.Name.Value))
		} else {
			c.writeStatementToBuffer(stmt, 1, &c.moduleCode)
		}
	}
	c.importStack = c.importStack[:len(c.importStack)-1]
	c.program = oldProg

	c.moduleCode.WriteString("\treturn exports\n")
	c.moduleCode.WriteString("}\n")

	return fmt.Sprintf("%s()", funcName)
}

func (c *GoCompiler) functionLiteralCode(e *ast.FunctionLiteral, isAssignment bool) string {
	var out bytes.Buffer
	out.WriteString("func(args []interface{}) interface{} {\n")
	for i, p := range e.Parameters {
		out.WriteString(fmt.Sprintf("\t\t%s := args[%d]\n", p.Value, i))
		out.WriteString(fmt.Sprintf("\t\t_ = %s\n", p.Value))
	}
	for _, stmt := range e.Body {
		c.writeStatementToBuffer(stmt, 2, &out)
	}
	// 在 Go 函数末尾尝试获取最后一个表达式的返回值（如果有的话，但玄铁函数必须显式返回）
	out.WriteString("\t\treturn nil\n")
	out.WriteString("\t}")
	return out.String()
}

func (c *GoCompiler) writeStatementToBuffer(stmt ast.Statement, indent int, buf *bytes.Buffer) {
	// 保存当前的 output，替换为传入的 buffer
	oldOutput := c.output
	c.output = *buf
	c.writeStatement(stmt, indent)
	*buf = c.output
	c.output = oldOutput
}

func (c *GoCompiler) asyncExpressionCode(e *ast.AsyncExpression, isAssignment bool) string {
	var out bytes.Buffer
	out.WriteString("func() *Task {\n")
	out.WriteString("\t\tch := make(chan interface{}, 1)\n")
	out.WriteString("\t\tgo func() {\n")
	out.WriteString("\t\t\tvar last interface{}\n")
	for _, stmt := range e.Block {
		if es, ok := stmt.(*ast.ExpressionStatement); ok {
			out.WriteString(fmt.Sprintf("\t\t\tlast = %s\n", c.expressionCode(es.Expression, isAssignment)))
		} else {
			c.writeStatementToBuffer(stmt, 3, &out)
		}
	}
	out.WriteString("\t\t\tch <- last\n")
	out.WriteString("\t\t}()\n")
	out.WriteString("\t\treturn &Task{ch: ch}\n")
	out.WriteString("\t}()")
	return out.String()
}

func (c *GoCompiler) awaitExpressionCode(e *ast.AwaitExpression, isAssignment bool) string {
	return fmt.Sprintf("await(%s)", c.expressionCode(e.Value, isAssignment))
}

func (c *GoCompiler) parallelExpressionCode(e *ast.ParallelExpression, isAssignment bool) string {
	var out bytes.Buffer
	out.WriteString("func() []interface{} {\n")
	out.WriteString(fmt.Sprintf("\t\tchs := make([]chan interface{}, %d)\n", len(e.Blocks)))
	for i, block := range e.Blocks {
		out.WriteString(fmt.Sprintf("\t\tchs[%d] = make(chan interface{}, 1)\n", i))
		out.WriteString(fmt.Sprintf("\t\tgo func(ch chan interface{}) {\n"))
		out.WriteString("\t\t\tvar last interface{}\n")
		for _, stmt := range block {
			if es, ok := stmt.(*ast.ExpressionStatement); ok {
				out.WriteString(fmt.Sprintf("\t\t\t\tlast = %s\n", c.expressionCode(es.Expression, isAssignment)))
			} else {
				c.writeStatementToBuffer(stmt, 4, &out)
			}
		}
		out.WriteString("\t\t\tch <- last\n")
		out.WriteString(fmt.Sprintf("\t\t}(chs[%d])\n", i))
	}
	out.WriteString("\t\tresults := make([]interface{}, len(chs))\n")
	out.WriteString("\t\tfor i, ch := range chs {\n")
	out.WriteString("\t\t\tresults[i] = <-ch\n")
	out.WriteString("\t\t}\n")
	out.WriteString("\t\treturn results\n")
	out.WriteString("\t}()")
	return out.String()
}

func (c *GoCompiler) callExpressionCode(e *ast.CallExpression, isAssignment bool) string {
	// 特殊处理内置关键字：成功、失败
	if ident, ok := e.Function.(*ast.Identifier); ok {
		if ident.Value == "成功" {
			val := "nil"
			if len(e.Arguments) > 0 {
				val = c.expressionCode(e.Arguments[0], isAssignment)
			}
			return fmt.Sprintf("&Result{IsSuccess: true, Value: %s}", val)
		}
		if ident.Value == "失败" {
			val := "nil"
			if len(e.Arguments) > 0 {
				val = c.expressionCode(e.Arguments[0], isAssignment)
			}
			return fmt.Sprintf("&Result{IsSuccess: false, Error: %s}", val)
		}
	}

	args := []string{}
	for _, a := range e.Arguments {
		args = append(args, c.expressionCode(a, isAssignment))
	}
	// 特殊处理内置函数调用，如 数学.平方(64)
	if infix, ok := e.Function.(*ast.InfixExpression); ok && infix.Operator == "." {
		return fmt.Sprintf("call(%s, []interface{}{%s})", c.infixExpressionCode(infix, isAssignment), strings.Join(args, ", "))
	}
	return fmt.Sprintf("call(%s, []interface{}{%s})", c.expressionCode(e.Function, isAssignment), strings.Join(args, ", "))
}

func (c *GoCompiler) infixExpressionCode(e *ast.InfixExpression, isAssignment bool) string {
	left := c.expressionCode(e.Left, isAssignment)
	right := c.expressionCode(e.Right, isAssignment)
	switch e.Operator {
	case ".":
		// 如果右侧是标识符，将其转为字符串字面量作为属性名
		if ident, ok := e.Right.(*ast.Identifier); ok {
			return fmt.Sprintf("getAttr(%s, %q)", left, ident.Value)
		}
		return fmt.Sprintf("getAttr(%s, %s)", left, right)
	case "+":
		return fmt.Sprintf("add(%s, %s)", left, right)
	case "-":
		return fmt.Sprintf("sub(%s, %s)", left, right)
	case "*":
		return fmt.Sprintf("mul(%s, %s)", left, right)
	case "/":
		return fmt.Sprintf("div(%s, %s)", left, right)
	case "==":
		return fmt.Sprintf("reflect.DeepEqual(%s, %s)", left, right)
	case "<":
		return fmt.Sprintf("lt(%s, %s)", left, right)
	case ">":
		return fmt.Sprintf("gt(%s, %s)", left, right)
	case "&": // 字符串拼接
		return fmt.Sprintf("fmt.Sprintf(\"%%v%%v\", %s, %s)", left, right)
	}
	return fmt.Sprintf("(%s %s %s)", left, e.Operator, right)
}

// TODO: 在 header 中添加运行时辅助函数 (isTruthy, toSlice, add, sub 等)
