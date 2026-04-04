package compiler

import (
	"bytes"
	"fmt"
	"strings"
	"xuantie/ast"
)

type GoCompiler struct {
	program *ast.Program
	output  bytes.Buffer
}

func New(program *ast.Program) *GoCompiler {
	return &GoCompiler{program: program}
}

func (c *GoCompiler) Compile() string {
	c.writeHeader()
	c.writeBody()
	c.writeFooter()
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
	c.output.WriteString("\treturn nil\n")
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
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n")

	c.output.WriteString("func mul(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok { return li * ri }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n")

	c.output.WriteString("func div(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok && ri != 0 { return li / ri }\n")
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
		c.output.WriteString(fmt.Sprintf("%svar %s interface{} = %s\n", indentStr, s.Name.Value, c.expressionCode(s.Value)))
		c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, s.Name.Value))
	case *ast.AssignStatement:
		c.output.WriteString(fmt.Sprintf("%s%s = %s\n", indentStr, s.Name, c.expressionCode(s.Value)))
	case *ast.PrintStatement:
		c.output.WriteString(fmt.Sprintf("%sfmt.Println(inspect(%s))\n", indentStr, c.expressionCode(s.Value)))
	case *ast.IfStatement:
		c.output.WriteString(fmt.Sprintf("%sif isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition)))
		for _, stmt := range s.ThenBlock {
			c.writeStatement(stmt, indent+1)
		}
		if len(s.ElseBlock) > 0 {
			c.output.WriteString(fmt.Sprintf("%s} else {\n", indentStr))
			for _, stmt := range s.ElseBlock {
				c.writeStatement(stmt, indent+1)
			}
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.WhileStatement:
		c.output.WriteString(fmt.Sprintf("%sfor isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition)))
		for _, stmt := range s.Block {
			c.writeStatement(stmt, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.ForStatement:
		// 基础遍历实现
		c.output.WriteString(fmt.Sprintf("%sfor _, _val := range toSlice(%s) {\n", indentStr, c.expressionCode(s.Iterable)))
		c.output.WriteString(fmt.Sprintf("%s\tvar %s interface{} = _val\n", indentStr, s.Variable.Value))
		for _, stmt := range s.Block {
			c.writeStatement(stmt, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.BreakStatement:
		c.output.WriteString(fmt.Sprintf("%sbreak\n", indentStr))
	case *ast.ContinueStatement:
		c.output.WriteString(fmt.Sprintf("%scontinue\n", indentStr))
	case *ast.ReturnStatement:
		c.output.WriteString(fmt.Sprintf("%sreturn %s\n", indentStr, c.expressionCode(s.ReturnValue)))
	case *ast.ExpressionStatement:
		exprCode := c.expressionCode(s.Expression)
		if exprCode != "nil" {
			c.output.WriteString(fmt.Sprintf("%s%s\n", indentStr, exprCode))
		}
	}
}

func (c *GoCompiler) expressionCode(exp ast.Expression) string {
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
		return c.infixExpressionCode(e)
	case *ast.CallExpression:
		return c.callExpressionCode(e)
	case *ast.ArrayLiteral:
		return c.arrayLiteralCode(e)
	case *ast.DictLiteral:
		return c.dictLiteralCode(e)
	case *ast.IndexExpression:
		return c.indexExpressionCode(e)
	case *ast.FunctionLiteral:
		return c.functionLiteralCode(e)
	case *ast.ImportExpression:
		return "nil" // 目前不支持转译引用，返回 nil
	}
	return "nil"
}

func (c *GoCompiler) functionLiteralCode(e *ast.FunctionLiteral) string {
	var out bytes.Buffer
	out.WriteString("func(args []interface{}) interface{} {\n")
	for i, p := range e.Parameters {
		out.WriteString(fmt.Sprintf("\t\t%s := args[%d]\n", p.Value, i))
		out.WriteString(fmt.Sprintf("\t\t_ = %s\n", p.Value))
	}
	for _, stmt := range e.Body {
		// 这里有个问题：FunctionLiteral 内部的 indent
		// 为了简单，我们先不处理复杂的缩进
		c.writeStatementToBuffer(stmt, 2, &out)
	}
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

func (c *GoCompiler) callExpressionCode(e *ast.CallExpression) string {
	args := []string{}
	for _, a := range e.Arguments {
		args = append(args, c.expressionCode(a))
	}
	return fmt.Sprintf("call(%s, []interface{}{%s})", c.expressionCode(e.Function), strings.Join(args, ", "))
}

func (c *GoCompiler) arrayLiteralCode(e *ast.ArrayLiteral) string {
	elements := []string{}
	for _, el := range e.Elements {
		elements = append(elements, c.expressionCode(el))
	}
	return fmt.Sprintf("[]interface{}{%s}", strings.Join(elements, ", "))
}

func (c *GoCompiler) dictLiteralCode(e *ast.DictLiteral) string {
	pairs := []string{}
	for k, v := range e.Pairs {
		pairs = append(pairs, fmt.Sprintf("%s: %s", c.expressionCode(k), c.expressionCode(v)))
	}
	// 注意：Go 的 map[interface{}]interface{} 或者是特定的结构
	// 这里简单化，我们转为 map[string]interface{}
	return fmt.Sprintf("map[string]interface{}{%s}", strings.Join(pairs, ", "))
}

func (c *GoCompiler) indexExpressionCode(e *ast.IndexExpression) string {
	return fmt.Sprintf("index(%s, %s)", c.expressionCode(e.Left), c.expressionCode(e.Index))
}

func (c *GoCompiler) infixExpressionCode(e *ast.InfixExpression) string {
	left := c.expressionCode(e.Left)
	right := c.expressionCode(e.Right)
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
