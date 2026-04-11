package evaluator

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"io/ioutil"
	"net"
	"net/http"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/object"
	"xuantie/parser"
	"xuantie/stdlib"
	"xuantie/token"
)

func RegisterStdLib(env map[string]object.Object) {
	env["空"] = &object.Null{}
	for name, obj := range stdlib.Builtins {
		env[name] = obj
		// 为字典类型的内置模块添加 __NAME__ 以便识别
		if dict, ok := obj.(*object.Dict); ok {
			dict.Pairs["__NAME__"] = &object.String{Value: name}
		}
	}
}

func Eval(node ast.Node, env map[string]object.Object) object.Object {
	return EvalContext(node, env, false)
}

func EvalContext(node ast.Node, env map[string]object.Object, isAssignment bool) object.Object {
	if node == nil {
		return &object.Null{}
	}
	switch n := node.(type) {
	case *ast.Program:
		return evalProgram(n, env)
	case *ast.AssignStatement:
		val := EvalContext(n.Value, env, true)
		if isError(val) {
			return val
		}
		if !updateEnv(env, n.Name, val) {
			// 检查是否在修改 '此' 的属性
			if self, ok := lookupEnv(env, "__SELF__"); ok {
				if instance, ok := self.(*object.Instance); ok {
					// 总是允许修改实例字段
					instance.Fields[n.Name] = val
					return val
				}
			}
			return newError(n.GetLine(), "未定义的变量: %s", n.Name)
		}
		return val
	case *ast.ComplexAssignStatement:
		val := Eval(n.Right, env)
		if isError(val) {
			return val
		}

		switch left := n.Left.(type) {
		case *ast.MemberCallExpression:
			obj := Eval(left.Object, env)
			if isError(obj) {
				return obj
			}
			if instance, ok := obj.(*object.Instance); ok {
				instance.Fields[left.Member.Value] = val
				return val
			}
			return newError(n.GetLine(), "不支持成员赋值的类型: %s", obj.Type())

		case *ast.Identifier:
			if !updateEnv(env, left.Value, val) {
				// 检查是否在修改 '此' 的属性
				if self, ok := lookupEnv(env, "__SELF__"); ok {
					if instance, ok := self.(*object.Instance); ok {
						instance.Fields[left.Value] = val
						return val
					}
				}
				return newError(n.GetLine(), "未定义的变量: %s", left.Value)
			}
			return val
		default:
			return evalComplexAssignStatement(n, env)
		}
	case *ast.VarStatement:
		val := EvalContext(n.Value, env, true)
		if isError(val) {
			return val
		}
		// 类型检查
		if n.DataType != "" {
			err := checkType(n.DataType, val, env)
			if err != nil {
				return newError(n.GetLine(), err.(*object.Error).Message)
			}
		}
		env[n.Name.Value] = val

		// 处理模块导出
		if n.Visibility == token.TOKEN_PUBLIC {
			if exports, ok := env["__EXPORTS__"]; ok {
				if dict, ok := exports.(*object.Dict); ok {
					dict.Pairs[n.Name.Value] = val
				}
			}
		}
		return val
	case *ast.ExpressionStatement:
		return EvalContext(n.Expression, env, false)
	case *ast.PrintStatement:
		if pure, ok := env["__PURE__"]; ok && pure.(*object.Boolean).Value {
			return &object.Null{}
		}
		val := EvalContext(n.Value, env, isAssignment)
		if isError(val) {
			return val
		}
		fmt.Println(val.Inspect())
		return val
	case *ast.IfStatement:
		return evalIfExpression(n, env)
	case *ast.WhileStatement:
		return evalWhileExpression(n, env)
	case *ast.LoopStatement:
		return evalLoopExpression(n, env)
	case *ast.MatchStatement:
		return evalMatchStatement(n, env)
	case *ast.ForStatement:
		return evalForStatement(n, env)
	case *ast.TestStatement:
		return evalTestStatement(n, env)
	case *ast.BreakStatement:
		return &object.Break{}
	case *ast.ContinueStatement:
		return &object.Continue{}
	case *ast.TryCatchStatement:
		return evalTryCatchStatement(n, env)
	case *ast.FunctionStatement:
		fn := &object.Function{
			Parameters:    n.Parameters,
			GenericParams: n.GenericParams,
			ReturnType:    n.ReturnType,
			Body:          n.Body,
			Env:           env,
			DocComment:    n.DocComment,
		}
		env[n.Name.Value] = fn

		// 处理模块导出
		if n.Visibility == token.TOKEN_PUBLIC {
			if exports, ok := env["__EXPORTS__"]; ok {
				if dict, ok := exports.(*object.Dict); ok {
					dict.Pairs[n.Name.Value] = fn
				}
			}
		}
		return &object.Null{}
	case *ast.TypeDefinitionStatement:
		return evalTypeDefinitionStatement(n, env)
	case *ast.InterfaceStatement:
		return evalInterfaceStatement(n, env)
	case *ast.AsyncExpression:
		return evalAsyncExpression(n, env)
	case *ast.ParallelExpression:
		return evalParallelExpression(n, env)
	case *ast.ReturnStatement:
		val := EvalContext(n.ReturnValue, env, isAssignment)
		if isError(val) {
			return val
		}
		return &object.ReturnValue{Value: val}
	case *ast.ImportExpression:
		return evalImportExpression(n, env, isAssignment)
	case *ast.NewExpression:
		return evalNewExpression(n, env)
	case *ast.SerializeExpression:
		return evalSerializeExpression(n, env)
	case *ast.DeserializeExpression:
		return evalDeserializeExpression(n, env)
	case *ast.ListenExpression:
		return evalListenExpression(n, env)
	case *ast.ConnectExpression:
		return evalConnectExpression(n, env)
	case *ast.ConnectRequestExpression:
		return evalRequestExpression(n, env)
	case *ast.ExecuteExpression:
		return evalExecuteExpression(n, env)
	case *ast.ChannelExpression:
		return &object.Channel{Value: make(chan object.Object, 100)}
	case *ast.FunctionLiteral:
		return &object.Function{
			Parameters:    n.Parameters,
			GenericParams: n.GenericParams,
			ReturnType:    n.ReturnType,
			Body:          n.Body,
			Env:           env,
		}
	case *ast.CallExpression:
		// 特殊处理 成功 和 失败
		if ident, ok := n.Function.(*ast.Identifier); ok {
			if ident.Value == "成功" || ident.Value == "失败" {
				args := evalExpressions(n.Arguments, env)
				if len(args) != 1 {
					return newError(n.GetLine(), "%s 期望 1 个参数，得到 %d", ident.Value, len(args))
				}
				if ident.Value == "成功" {
					return &object.Result{IsSuccess: true, Value: args[0]}
				}
				return &object.Result{IsSuccess: false, Error: args[0]}
			}
		}
		function := EvalContext(n.Function, env, isAssignment)
		if isError(function) {
			return function
		}
		args := evalExpressions(n.Arguments, env)
		if len(args) == 1 && isError(args[0]) {
			return args[0]
		}

		funcName := "匿名函数"
		if ident, ok := n.Function.(*ast.Identifier); ok {
			funcName = ident.Value
		}

		return applyFunctionWithGenerics(n.GetLine(), funcName, function, args, n.TypeArguments)
	case *ast.AwaitExpression:
		return evalAwaitExpression(n, env)
	case *ast.MemberCallExpression:
		return evalMemberCallExpression(n, env)
	case *ast.MemberAssignStatement:
		obj := EvalContext(n.Object, env, true)
		if isError(obj) {
			return obj
		}
		val := EvalContext(n.Value, env, true)
		if isError(val) {
			return val
		}
		return evalMemberAssignStatement(n, env)
	case *ast.IndexExpression:
		left := Eval(n.Left, env)
		if isError(left) {
			return left
		}
		index := Eval(n.Index, env)
		if isError(index) {
			return index
		}
		return evalIndexExpression(n.GetLine(), left, index)
	case *ast.IntegerLiteral:
		return &object.Integer{Value: n.Value}
	case *ast.FloatLiteral:
		return &object.Float{Value: n.Value}
	case *ast.StringLiteral:
		return &object.String{Value: n.Value}
	case *ast.ArrayLiteral:
		elements := evalExpressions(n.Elements, env)
		if len(elements) == 1 && isError(elements[0]) {
			return elements[0]
		}
		return &object.Array{Elements: elements}
	case *ast.DictLiteral:
		return evalDictLiteral(n, env)
	case *ast.BooleanLiteral:
		return &object.Boolean{Value: n.Value}
	case *ast.TypeLiteral:
		return &object.String{Value: n.Value}
	case *ast.Identifier:
		if n.Value == "此" {
			if self, ok := lookupEnv(env, "__SELF__"); ok {
				return self
			}
			return newError(n.GetLine(), "关键字 '此' 只能在类方法中使用")
		}
		// 1. 优先从环境找（局部变量、参数、闭包捕获）
		if val, ok := lookupEnv(env, n.Value); ok {
			return val
		}
		// 2. 其次检查实例属性或方法 (隐式此)
		if self, ok := lookupEnv(env, "__SELF__"); ok {
			if instance, ok := self.(*object.Instance); ok {
				// 优先查找方法
				if method, ok := findMethod(instance.Class, n.Value); ok {
					return bindInstance(instance, method)
				}
				// 其次查找字段
				if val, ok := instance.Fields[n.Value]; ok {
					return val
				}
			}
		}
		// 3. 最后找内置全局变量/函数
		if builtin, ok := stdlib.Builtins[n.Value]; ok {
			return builtin
		}
		return newError(n.GetLine(), "未定义的变量: %s", n.Value)
	case *ast.InfixExpression:
		if n.Operator == "且" {
			left := Eval(n.Left, env)
			if isError(left) {
				return left
			}
			if !isTruthy(left) {
				return &object.Boolean{Value: false}
			}
			right := Eval(n.Right, env)
			if isError(right) {
				return right
			}
			return &object.Boolean{Value: isTruthy(right)}
		}
		if n.Operator == "或" {
			left := Eval(n.Left, env)
			if isError(left) {
				return left
			}
			if isTruthy(left) {
				return &object.Boolean{Value: true}
			}
			right := Eval(n.Right, env)
			if isError(right) {
				return right
			}
			return &object.Boolean{Value: isTruthy(right)}
		}

		left := Eval(n.Left, env)
		if isError(left) {
			return left
		}
		right := Eval(n.Right, env)
		if isError(right) {
			return right
		}
		return evalInfixExpression(n.GetLine(), n.Operator, left, right)
	case *ast.PrefixExpression:
		right := EvalContext(n.Right, env, isAssignment)
		if isError(right) {
			return right
		}
		return evalPrefixExpression(n.GetLine(), n.Operator, right)
	default:
		return newError(n.GetLine(), "未知节点类型: %T", node)
	}
}

func evalExpressionsContext(exps []ast.Expression, env map[string]object.Object, isAssignment bool) []object.Object {
	var result []object.Object
	for _, e := range exps {
		evaluated := EvalContext(e, env, isAssignment)
		if isError(evaluated) {
			return []object.Object{evaluated}
		}
		result = append(result, evaluated)
	}
	return result
}

func evalDictLiteralContext(dl *ast.DictLiteral, env map[string]object.Object, isAssignment bool) object.Object {
	dict := &object.Dict{Pairs: make(map[string]object.Object)}

	for keyNode, valueNode := range dl.Pairs {
		key := EvalContext(keyNode, env, isAssignment)
		if isError(key) {
			return key
		}

		k := key.Inspect()
		v := EvalContext(valueNode, env, isAssignment)
		if isError(v) {
			return v
		}

		dict.Pairs[k] = v
	}

	return dict
}

func evalImportExpression(ie *ast.ImportExpression, env map[string]object.Object, isAssignment bool) object.Object {
	path := ie.Path
	// 如果是相对路径，且环境中有当前目录信息，则进行路径拼接
	if !filepath.IsAbs(path) {
		if baseDirObj, ok := env["__DIR__"]; ok {
			if baseDir, ok := baseDirObj.(*object.String); ok {
				path = filepath.Join(baseDir.Value, path)
			}
		}
	}

	absPath, err := filepath.Abs(path)
	if err != nil {
		return newError(ie.GetLine(), "引用文件失败: 无法获取绝对路径 (%s)", path)
	}

	// 循环引用检测
	stack := []string{}
	if stackObj, ok := env["__STACK__"]; ok {
		if s, ok := stackObj.(*object.Array); ok {
			for _, item := range s.Elements {
				if item.Inspect() == absPath {
					// 发现循环引用
					var trace string
					for _, p := range s.Elements {
						trace += p.Inspect() + " -> "
					}
					trace += absPath
					return newError(ie.GetLine(), "检测到循环引用: %s", trace)
				}
				stack = append(stack, item.Inspect())
			}
		}
	}

	content, err := ioutil.ReadFile(absPath)
	if err != nil {
		return newError(ie.GetLine(), "引用文件失败: 找不到文件或无法读取 (%s)", absPath)
	}

	l := lexer.New(string(content))
	p := parser.New(l)
	program := p.ParseProgram()
	program.FilePath = absPath

	if len(p.Errors()) != 0 {
		return newError(ie.GetLine(), "引用文件解析错误: %s", p.Errors()[0])
	}

	// 模块有自己的独立环境
	moduleEnv := make(map[string]object.Object)
	RegisterStdLib(moduleEnv)
	if isAssignment {
		moduleEnv["__PURE__"] = &object.Boolean{Value: true}
	}

	// 初始化导出字典
	exportsDict := &object.Dict{Pairs: make(map[string]object.Object)}
	moduleEnv["__EXPORTS__"] = exportsDict

	// 更新引用栈
	newStack := &object.Array{Elements: []object.Object{}}
	for _, s := range stack {
		newStack.Elements = append(newStack.Elements, &object.String{Value: s})
	}
	// 将当前主文件（如果有）加入栈
	if progPath, ok := env["__FILE__"]; ok {
		newStack.Elements = append(newStack.Elements, progPath)
	}
	moduleEnv["__STACK__"] = newStack
	moduleEnv["__FILE__"] = &object.String{Value: absPath}

	// 执行模块代码
	result := Eval(program, moduleEnv)
	if isError(result) {
		return result
	}

	// 如果没有显式定义任何 '公' 成员，为了兼容性，目前仍导出所有非保留成员
	// 但如果有了 '公' 成员，则只导出它们。
	// 这里我们遵循用户要求：模块内部变量默认私有，仅导出明确定义的 '公' (Public) 成员。
	// 为了平滑过渡，如果 exportsDict 为空，我们检查是否真的没有任何公有定义。
	if len(exportsDict.Pairs) == 0 {
		for k, v := range moduleEnv {
			if _, isBuiltin := stdlib.Builtins[k]; !isBuiltin && k != "__DIR__" && k != "__PURE__" && k != "__STACK__" && k != "__FILE__" && k != "__EXPORTS__" {
				exportsDict.Pairs[k] = v
			}
		}
	}

	// 处理别名绑定
	if ie.Alias != nil {
		env[ie.Alias.Value] = exportsDict
	} else {
		// 如果没有别名，则合并到当前环境
		for k, v := range exportsDict.Pairs {
			env[k] = v
		}
	}

	return exportsDict
}

func evalProgram(prog *ast.Program, env map[string]object.Object) object.Object {
	// 设置当前程序所在的目录到环境，用于后续的相对路径引用
	if prog.FilePath != "" {
		absPath, _ := filepath.Abs(prog.FilePath)
		env["__DIR__"] = &object.String{Value: filepath.Dir(absPath)}
		env["__FILE__"] = &object.String{Value: absPath}
	}

	var result object.Object
	for _, stmt := range prog.Statements {
		result = Eval(stmt, env)
		if result != nil {
			switch res := result.(type) {
			case *object.ReturnValue:
				return res.Value
			case *object.Error:
				// 如果是顶层 Program，直接返回错误，由 main.go 打印
				return res
			}
		}
	}
	return result
}

func evalIfExpression(ie *ast.IfStatement, env map[string]object.Object) object.Object {
	condition := Eval(ie.Condition, env)
	if isError(condition) {
		return condition
	}
	if isTruthy(condition) {
		return evalBlock(ie.ThenBlock, env)
	}

	for _, eif := range ie.ElseIfs {
		eifCondition := Eval(eif.Condition, env)
		if isError(eifCondition) {
			return eifCondition
		}
		if isTruthy(eifCondition) {
			return evalBlock(eif.Block, env)
		}
	}

	if len(ie.ElseBlock) > 0 {
		return evalBlock(ie.ElseBlock, env)
	}
	return &object.Null{}
}

func evalWhileExpression(we *ast.WhileStatement, env map[string]object.Object) object.Object {
	for {
		condition := Eval(we.Condition, env)
		if isError(condition) {
			return condition
		}
		if !isTruthy(condition) {
			break
		}
		result := evalBlock(we.Block, env)
		if result != nil {
			rt := result.Type()
			if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ {
				return result
			}
			if rt == object.BREAK_OBJ {
				break
			}
			if rt == object.CONTINUE_OBJ {
				continue
			}
		}
	}
	return &object.Null{}
}

func evalLoopExpression(le *ast.LoopStatement, env map[string]object.Object) object.Object {
	for {
		result := evalBlock(le.Block, env)
		if result != nil {
			rt := result.Type()
			if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ {
				return result
			}
			if rt == object.BREAK_OBJ {
				break
			}
			if rt == object.CONTINUE_OBJ {
				continue
			}
		}
	}
	return &object.Null{}
}

func evalMatchStatement(ms *ast.MatchStatement, env map[string]object.Object) object.Object {
	val := Eval(ms.Value, env)
	if isError(val) {
		return val
	}

	for _, c := range ms.Cases {
		if matchPattern(val, c.Pattern, env) {
			return evalBlock(c.Body, env)
		}
	}

	return &object.Null{}
}

func matchPattern(val object.Object, pattern ast.Expression, env map[string]object.Object) bool {
	// 1. 处理默认分支 '_'
	if ident, ok := pattern.(*ast.Identifier); ok && ident.Value == "_" {
		return true
	}

	// 2. 处理类型匹配 '是 类型'
	if prefix, ok := pattern.(*ast.PrefixExpression); ok && prefix.Operator == "是" {
		expectedType := prefix.Right.String()
		return checkType(expectedType, val, env) == nil
	}

	// 3. 处理值匹配
	patternVal := Eval(pattern, env)
	if isError(patternVal) {
		return false
	}

	res := evalInfixExpression(0, "==", val, patternVal)
	if b, ok := res.(*object.Boolean); ok {
		return b.Value
	}

	return false
}

func evalForStatement(fs *ast.ForStatement, env map[string]object.Object) object.Object {
	iterable := Eval(fs.Iterable, env)
	if isError(iterable) {
		return iterable
	}

	switch obj := iterable.(type) {
	case *object.Array:
		for i, element := range obj.Elements {
			loopEnv := extendEnv(env)
			if len(fs.Variables) == 1 {
				loopEnv[fs.Variables[0].Value] = element
			} else if len(fs.Variables) >= 2 {
				loopEnv[fs.Variables[0].Value] = &object.Integer{Value: int64(i)}
				loopEnv[fs.Variables[1].Value] = element
			}

			result := evalBlock(fs.Block, loopEnv)
			if result != nil {
				rt := result.Type()
				if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ {
					return result
				}
				if rt == object.BREAK_OBJ {
					break
				}
				if rt == object.CONTINUE_OBJ {
					continue
				}
			}
		}
	case *object.Dict:
		for key, val := range obj.Pairs {
			loopEnv := extendEnv(env)
			if len(fs.Variables) == 1 {
				loopEnv[fs.Variables[0].Value] = &object.String{Value: key}
			} else if len(fs.Variables) >= 2 {
				loopEnv[fs.Variables[0].Value] = &object.String{Value: key}
				loopEnv[fs.Variables[1].Value] = val
			}

			result := evalBlock(fs.Block, loopEnv)
			if result != nil {
				rt := result.Type()
				if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ {
					return result
				}
				if rt == object.BREAK_OBJ {
					break
				}
				if rt == object.CONTINUE_OBJ {
					continue
				}
			}
		}
	case *object.String:
		for i, r := range obj.Value {
			loopEnv := extendEnv(env)
			if len(fs.Variables) == 1 {
				loopEnv[fs.Variables[0].Value] = &object.String{Value: string(r)}
			} else if len(fs.Variables) >= 2 {
				loopEnv[fs.Variables[0].Value] = &object.Integer{Value: int64(i)}
				loopEnv[fs.Variables[1].Value] = &object.String{Value: string(r)}
			}

			result := evalBlock(fs.Block, loopEnv)
			if result != nil {
				rt := result.Type()
				if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ {
					return result
				}
				if rt == object.BREAK_OBJ {
					break
				}
				if rt == object.CONTINUE_OBJ {
					continue
				}
			}
		}
	default:
		return newError(fs.GetLine(), "不可遍历的类型: %s", iterable.Type())
	}

	return &object.Null{}
}

func evalTestStatement(ts *ast.TestStatement, env map[string]object.Object) object.Object {
	fmt.Printf("运行测试: [%s] ... ", ts.Name)
	testEnv := extendEnv(env)
	result := evalBlock(ts.Body, testEnv)
	if isError(result) {
		fmt.Printf("失败!\n")
		return result
	}
	fmt.Printf("通过.\n")
	return &object.Null{}
}

func evalTryCatchStatement(ts *ast.TryCatchStatement, env map[string]object.Object) object.Object {
	// 创建局部环境
	tryEnv := extendEnv(env)
	result := evalBlock(ts.TryBlock, tryEnv)

	if isError(result) {
		catchEnv := extendEnv(env)
		if ts.CatchVar != nil {
			errObj := result.(*object.Error)
			// 创建结构化错误对象
			errorDict := &object.Dict{Pairs: make(map[string]object.Object)}
			errorDict.Pairs["消息"] = &object.String{Value: errObj.Message}

			stackArr := make([]object.Object, len(errObj.Trace))
			for i, t := range errObj.Trace {
				stackArr[i] = &object.String{Value: t}
			}
			errorDict.Pairs["堆栈"] = &object.Array{Elements: stackArr}
			errorDict.Pairs["文本"] = &object.String{Value: errObj.Inspect()}

			catchEnv[ts.CatchVar.Value] = errorDict
		}
		return evalBlock(ts.CatchBlock, catchEnv)
	}
	return result
}

func evalTypeDefinitionStatement(tds *ast.TypeDefinitionStatement, env map[string]object.Object) object.Object {
	class := &object.Class{
		Name:          tds.Name.Value,
		GenericParams: tds.GenericParams,
		Fields:        make(map[string]object.Object),
		Methods:       make(map[string]*object.Function),
		Visibilities:  make(map[string]token.TokenType),
		Env:           env,
	}

	// 提前加入环境，支持递归引用
	env[tds.Name.Value] = class

	// 1. 绑定父类
	if tds.Parent != nil {
		parentObj, ok := env[tds.Parent.Value]
		if !ok {
			return newError(tds.GetLine(), "未定义的父类: %s", tds.Parent.Value)
		}
		parentClass, ok := parentObj.(*object.Class)
		if !ok {
			return newError(tds.GetLine(), "%s 不是一个有效的类", tds.Parent.Value)
		}
		class.Parent = parentClass
	}

	// 2. 解析类体（仅存储本类定义的字段和方法）
	classEnv := extendEnv(env)
	// 如果有父类，子类方法在解析时可以看见父类的非私有成员（作为语法参考）
	if class.Parent != nil {
		var injectAncestorMembers func(*object.Class)
		injectAncestorMembers = func(c *object.Class) {
			if c.Parent != nil {
				injectAncestorMembers(c.Parent)
			}
			for k, v := range c.Fields {
				if vis := c.Visibilities[k]; vis != token.TOKEN_PRIVATE {
					classEnv[k] = v
				}
			}
			for k, v := range c.Methods {
				if vis := c.Visibilities[k]; vis != token.TOKEN_PRIVATE {
					classEnv[k] = v
				}
			}
		}
		injectAncestorMembers(class.Parent)
	}

	for _, stmt := range tds.Block {
		switch s := stmt.(type) {
		case *ast.VarStatement:
			val := EvalContext(s.Value, classEnv, true)
			if isError(val) {
				return val
			}
			class.Fields[s.Name.Value] = val
			if s.Visibility != "" {
				class.Visibilities[s.Name.Value] = s.Visibility
			}
			classEnv[s.Name.Value] = val
		case *ast.FunctionStatement:
			// 校验 '覆' (Override) 关键字
			if s.IsOverride {
				if class.Parent == nil {
					return newError(s.GetLine(), "方法 '%s' 使用了 '覆'，但类 '%s' 没有父类", s.Name.Value, class.Name)
				}
				// 检查父类是否存在该方法
				found := false
				curr := class.Parent
				for curr != nil {
					if _, ok := curr.Methods[s.Name.Value]; ok {
						found = true
						break
					}
					curr = curr.Parent
				}
				if !found {
					return newError(s.GetLine(), "方法 '%s' 标注了 '覆'，但在父类继承链中未找到同名方法", s.Name.Value)
				}
			} else {
				// 如果没写 '覆'，但父类有同名方法，报警告（暂时报错误以强化契约）
				if class.Parent != nil {
					curr := class.Parent
					for curr != nil {
						if _, ok := curr.Methods[s.Name.Value]; ok {
							return newError(s.GetLine(), "方法 '%s' 重写了父类方法，必须使用 '覆' 关键字声明", s.Name.Value)
						}
						curr = curr.Parent
					}
				}
			}

			fn := &object.Function{
				Parameters: s.Parameters,
				ReturnType: s.ReturnType,
				Body:       s.Body,
				Env:        classEnv,
				OwnerClass: class,
				DocComment: s.DocComment,
			}
			class.Methods[s.Name.Value] = fn
			if s.Visibility != "" {
				class.Visibilities[s.Name.Value] = s.Visibility
			}
		}
	}

	env[tds.Name.Value] = class

	// 处理模块导出
	if tds.Visibility == token.TOKEN_PUBLIC {
		if exports, ok := env["__EXPORTS__"]; ok {
			if dict, ok := exports.(*object.Dict); ok {
				dict.Pairs[tds.Name.Value] = class
			}
		}
	}

	return &object.Null{}
}

func evalInterfaceStatement(is *ast.InterfaceStatement, env map[string]object.Object) object.Object {
	inf := &object.Interface{
		Name:    is.Name.Value,
		Methods: make(map[string]*ast.MethodSignature),
		Env:     env,
	}

	for _, m := range is.Methods {
		inf.Methods[m.Name.Value] = m
	}

	env[is.Name.Value] = inf

	// 处理模块导出
	if is.Visibility == token.TOKEN_PUBLIC {
		if exports, ok := env["__EXPORTS__"]; ok {
			if dict, ok := exports.(*object.Dict); ok {
				dict.Pairs[is.Name.Value] = inf
			}
		}
	}

	return &object.Null{}
}

func evalNewExpression(ne *ast.NewExpression, env map[string]object.Object) object.Object {
	classObj := Eval(ne.Type, env)
	if isError(classObj) {
		return classObj
	}

	class, ok := classObj.(*object.Class)
	if !ok {
		return newError(ne.GetLine(), "不是类型: %s", classObj.Type())
	}

	instance := &object.Instance{
		Class:    class,
		TypeArgs: make(map[string]string),
		Fields:   make(map[string]object.Object),
	}

	var args []object.Object
	if len(ne.Arguments) > 0 {
		args = evalExpressions(ne.Arguments, env)
		if len(args) == 1 && isError(args[0]) {
			return args[0]
		}
	}

	// 绑定泛型参数并校验约束
	if len(class.GenericParams) > 0 {
		typeArgs := ne.TypeArguments
		// 如果未显式提供泛型参数，尝试从构造函数参数推导
		if len(typeArgs) == 0 {
			if constructor, ok := class.Methods["造"]; ok {
				typeArgs = inferTypeArguments(class.GenericParams, constructor.Parameters, args)
			}
		}

		if len(typeArgs) > 0 {
			if len(typeArgs) != len(class.GenericParams) {
				return newError(ne.GetLine(), "泛型参数数量不匹配: 期望 %d, 得到 %d", len(class.GenericParams), len(typeArgs))
			}
			for i, p := range class.GenericParams {
				actualType := typeArgs[i]
				if actualType == "" {
					return newError(ne.GetLine(), "无法推导泛型参数 '%s'，请显式指定", p.Name)
				}
				// 校验约束
				if p.Constraint != "" {
					if !checkConstraint(p.Constraint, actualType, env) {
						return newError(ne.GetLine(), "泛型参数 '%s' 不满足约束 '%s': 实际得到 '%s'", p.Name, p.Constraint, actualType)
					}
				}
				instance.TypeArgs[p.Name] = actualType
			}
		}
	}

	// 1. 初始化所有字段（包括私有字段，从继承链最顶端开始向下覆盖）
	var collectFields func(*object.Class)
	collectFields = func(c *object.Class) {
		if c.Parent != nil {
			collectFields(c.Parent)
		}
		for k, v := range c.Fields {
			instance.Fields[k] = v
		}
	}
	collectFields(class)

	// 2. 如果提供了字典字面量，覆盖初始值
	if ne.Data != nil {
		data := Eval(ne.Data, env)
		if isError(data) {
			return data
		}
		if dict, ok := data.(*object.Dict); ok {
			for k, v := range dict.Pairs {
				instance.Fields[k] = v
			}
		}
	}

	// 3. 如果定义了构造函数 "造"，执行它
	if constructor, ok := class.Methods["造"]; ok {
		boundConstructor := bindInstance(instance, constructor)
		res := applyFunctionWithName(ne.GetLine(), class.Name+".造", boundConstructor, args)
		if isError(res) {
			return res
		}
	}

	return instance
}

func evalSerializeExpression(se *ast.SerializeExpression, env map[string]object.Object) object.Object {
	val := Eval(se.Value, env)
	if isError(val) {
		return val
	}

	raw := objectToInterface(val)
	bytes, err := json.Marshal(raw)
	if err != nil {
		return newError(se.GetLine(), "序列化失败: %s", err.Error())
	}

	return &object.String{Value: string(bytes)}
}

func evalDeserializeExpression(de *ast.DeserializeExpression, env map[string]object.Object) object.Object {
	val := Eval(de.Value, env)
	if isError(val) {
		return val
	}

	str, ok := val.(*object.String)
	if !ok {
		return newError(de.GetLine(), "解期望字符串，得到 %s", val.Type())
	}

	var raw interface{}
	err := json.Unmarshal([]byte(str.Value), &raw)
	if err != nil {
		return newError(de.GetLine(), "反序列化失败: %s", err.Error())
	}

	return interfaceToObject(raw)
}

func objectToInterface(obj object.Object) interface{} {
	switch o := obj.(type) {
	case *object.Integer:
		return o.Value
	case *object.Float:
		return o.Value
	case *object.String:
		return o.Value
	case *object.Boolean:
		return o.Value
	case *object.Array:
		res := make([]interface{}, len(o.Elements))
		for i, e := range o.Elements {
			res[i] = objectToInterface(e)
		}
		return res
	case *object.Dict:
		res := make(map[string]interface{})
		for k, v := range o.Pairs {
			res[k] = objectToInterface(v)
		}
		return res
	case *object.Instance:
		res := make(map[string]interface{})
		for k, v := range o.Fields {
			res[k] = objectToInterface(v)
		}
		return res
	default:
		return nil
	}
}

func interfaceToObject(raw interface{}) object.Object {
	switch v := raw.(type) {
	case bool:
		return &object.Boolean{Value: v}
	case float64:
		if v == float64(int64(v)) {
			return &object.Integer{Value: int64(v)}
		}
		return &object.Float{Value: v}
	case string:
		return &object.String{Value: v}
	case []interface{}:
		elements := make([]object.Object, len(v))
		for i, e := range v {
			elements[i] = interfaceToObject(e)
		}
		return &object.Array{Elements: elements}
	case map[string]interface{}:
		pairs := make(map[string]object.Object)
		for k, val := range v {
			pairs[k] = interfaceToObject(val)
		}
		return &object.Dict{Pairs: pairs}
	default:
		return &object.Null{}
	}
}

func evalAsyncExpression(ae *ast.AsyncExpression, env map[string]object.Object) object.Object {
	task := &object.Task{
		Channel: make(chan object.Object, 1),
	}

	// 捕获当前环境变量（简单复制，实际上可能需要更复杂的闭包处理）
	asyncEnv := extendEnv(env)

	go func() {
		result := evalBlock(ae.Block, asyncEnv)
		task.Channel <- result
		close(task.Channel)
	}()

	return task
}

func evalParallelExpression(pe *ast.ParallelExpression, env map[string]object.Object) object.Object {
	var results []object.Object
	channels := make([]chan object.Object, len(pe.Blocks))

	for i, block := range pe.Blocks {
		channels[i] = make(chan object.Object, 1)
		parallelEnv := extendEnv(env)
		go func(ch chan object.Object, b []ast.Statement, e map[string]object.Object) {
			ch <- evalBlock(b, e)
			close(ch)
		}(channels[i], block, parallelEnv)
	}

	for _, ch := range channels {
		results = append(results, <-ch)
	}

	return &object.Array{Elements: results}
}

func evalAwaitExpression(ae *ast.AwaitExpression, env map[string]object.Object) object.Object {
	val := Eval(ae.Value, env)
	if isError(val) {
		return val
	}

	if task, ok := val.(*object.Task); ok {
		if task.IsDone {
			return task.Value
		}
		result := <-task.Channel
		task.Value = result
		task.IsDone = true
		return result
	}

	return val // 如果不是任务，直接返回原值
}

func bindInstance(instance *object.Instance, fn *object.Function) *object.Function {
	return &object.Function{
		Parameters:    fn.Parameters,
		GenericParams: fn.GenericParams,
		ReturnType:    fn.ReturnType,
		Body:          fn.Body,
		Env:           fn.Env,
		OwnerClass:    fn.OwnerClass,
		Receiver:      instance,
		DocComment:    fn.DocComment,
	}
}

func evalMemberCallExpression(mce *ast.MemberCallExpression, env map[string]object.Object) object.Object {
	obj := Eval(mce.Object, env)
	if isError(obj) {
		return obj
	}

	args := evalExpressions(mce.Arguments, env)
	if len(args) == 1 && isError(args[0]) {
		return args[0]
	}

	// 处理结果类型的链式调用
	if result, ok := obj.(*object.Result); ok {
		switch mce.Member.Value {
		case "值":
			return result.Value
		case "错误":
			return result.Error
		case "成功":
			return &object.Boolean{Value: result.IsSuccess}
		case "接着":
			if result.IsSuccess {
				res := applyFunctionWithName(mce.GetLine(), "接着", args[0], []object.Object{result.Value})
				if r, ok := res.(*object.Result); ok {
					return r
				}
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
		case "否则":
			if !result.IsSuccess {
				res := applyFunctionWithName(mce.GetLine(), "否则", args[0], []object.Object{result.Error})
				if r, ok := res.(*object.Result); ok {
					return r
				}
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
		case "映射":
			if result.IsSuccess {
				res := applyFunctionWithName(mce.GetLine(), "映射", args[0], []object.Object{result.Value})
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
		case "复原":
			if !result.IsSuccess {
				res := applyFunctionWithName(mce.GetLine(), "复原", args[0], []object.Object{result.Error})
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
		case "执行":
			applyFunctionWithName(mce.GetLine(), "执行", args[0], []object.Object{result.Value, result.Error})
			return result
		case "解包", "断言":
			if result.IsSuccess {
				return result.Value
			}
			return newError(mce.GetLine(), "解包失败: %s", result.Error.Inspect())
		case "或":
			if result.IsSuccess {
				return result.Value
			}
			if len(args) > 0 {
				return args[0]
			}
			return &object.Null{}
		}
	}

	// 处理字符串成员属性
	if str, ok := obj.(*object.String); ok {
		switch mce.Member.Value {
		case "长度":
			return &object.Integer{Value: int64(len(str.Value))}
		case "包含":
			if len(args) == 0 {
				return newError(mce.GetLine(), "包含期望 1 个参数")
			}
			substr := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				substr = s.Value
			}
			return &object.Boolean{Value: strings.Contains(str.Value, substr)}
		case "分割":
			if len(args) == 0 {
				return newError(mce.GetLine(), "分割期望 1 个参数 (分隔符)")
			}
			sep := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				sep = s.Value
			}
			parts := strings.Split(str.Value, sep)
			elements := make([]object.Object, len(parts))
			for i, p := range parts {
				elements[i] = &object.String{Value: p}
			}
			return &object.Array{Elements: elements}
		case "替换":
			if len(args) != 2 {
				return newError(mce.GetLine(), "替换期望 2 个参数 (旧串, 新串)")
			}
			oldStr := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				oldStr = s.Value
			}
			newStr := args[1].Inspect()
			if s, ok := args[1].(*object.String); ok {
				newStr = s.Value
			}
			return &object.String{Value: strings.ReplaceAll(str.Value, oldStr, newStr)}
		case "修剪":
			return &object.String{Value: strings.TrimSpace(str.Value)}
		case "大写":
			return &object.String{Value: strings.ToUpper(str.Value)}
		case "小写":
			return &object.String{Value: strings.ToLower(str.Value)}
		case "开头是":
			if len(args) == 0 {
				return newError(mce.GetLine(), "开头是期望 1 个参数")
			}
			return &object.Boolean{Value: strings.HasPrefix(str.Value, args[0].Inspect())}
		case "结尾是":
			if len(args) == 0 {
				return newError(mce.GetLine(), "结尾是期望 1 个参数")
			}
			return &object.Boolean{Value: strings.HasSuffix(str.Value, args[0].Inspect())}
		case "索引":
			if len(args) == 0 {
				return newError(mce.GetLine(), "索引期望 1 个参数")
			}
			return &object.Integer{Value: int64(strings.Index(str.Value, args[0].Inspect()))}
		case "最后索引":
			if len(args) == 0 {
				return newError(mce.GetLine(), "最后索引期望 1 个参数")
			}
			return &object.Integer{Value: int64(strings.LastIndex(str.Value, args[0].Inspect()))}
		case "重复":
			if len(args) == 0 {
				return newError(mce.GetLine(), "重复期望 1 个参数 (次数)")
			}
			count, ok := args[0].(*object.Integer)
			if !ok {
				return newError(mce.GetLine(), "重复次数必须是整数")
			}
			return &object.String{Value: strings.Repeat(str.Value, int(count.Value))}
		case "修剪开头":
			if len(args) == 0 {
				return &object.String{Value: strings.TrimLeft(str.Value, " \t\n\r")}
			}
			return &object.String{Value: strings.TrimPrefix(str.Value, args[0].Inspect())}
		case "修剪结尾":
			if len(args) == 0 {
				return &object.String{Value: strings.TrimRight(str.Value, " \t\n\r")}
			}
			return &object.String{Value: strings.TrimSuffix(str.Value, args[0].Inspect())}
		case "空?":
			return &object.Boolean{Value: len(str.Value) == 0}
		case "非空?":
			return &object.Boolean{Value: len(str.Value) > 0}
		case "包含?":
			if len(args) == 0 {
				return newError(mce.GetLine(), "包含?期望 1 个参数")
			}
			return &object.Boolean{Value: strings.Contains(str.Value, args[0].Inspect())}
		case "截取":
			if len(args) < 1 {
				return newError(mce.GetLine(), "截取期望至少 1 个参数 (起始索引)")
			}
			start, ok := args[0].(*object.Integer)
			if !ok {
				return newError(mce.GetLine(), "起始索引必须是整数")
			}
			s := int(start.Value)
			e := len(str.Value)
			if len(args) >= 2 {
				end, ok := args[1].(*object.Integer)
				if !ok {
					return newError(mce.GetLine(), "结束索引必须是整数")
				}
				e = int(end.Value)
			}
			if s < 0 {
				s = 0
			}
			if e > len(str.Value) {
				e = len(str.Value)
			}
			if s > e {
				return &object.String{Value: ""}
			}
			return &object.String{Value: str.Value[s:e]}
		}
	}

	// 处理字节成员属性
	if b, ok := obj.(*object.Bytes); ok {
		switch mce.Member.Value {
		case "长度":
			return &object.Integer{Value: int64(len(b.Value))}
		}
	}

	// 处理数组成员属性与方法
	if arr, ok := obj.(*object.Array); ok {
		var memberVal object.Object
		switch mce.Member.Value {
		case "长度":
			memberVal = &object.Integer{Value: int64(len(arr.Elements))}
		case "追加":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					arr.Elements = append(arr.Elements, fArgs...)
					return arr
				},
			}
		case "截取":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "截取期望至少 1 个参数 (起始索引)")
					}
					start, ok := fArgs[0].(*object.Integer)
					if !ok {
						return newError(mce.GetLine(), "起始索引必须是整数")
					}
					s := start.Value
					e := int64(len(arr.Elements))
					if len(fArgs) >= 2 {
						end, ok := fArgs[1].(*object.Integer)
						if !ok {
							return newError(mce.GetLine(), "结束索引必须是整数")
						}
						e = end.Value
					}
					if s < 0 {
						s = 0
					}
					if e > int64(len(arr.Elements)) {
						e = int64(len(arr.Elements))
					}
					if s > e {
						return &object.Array{Elements: []object.Object{}}
					}
					return &object.Array{Elements: arr.Elements[s:e]}
				},
			}
		case "删":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) != 1 {
						return newError(mce.GetLine(), "删期望 1 个参数 (索引)")
					}
					idxObj, ok := fArgs[0].(*object.Integer)
					if !ok {
						return newError(mce.GetLine(), "索引必须是整数")
					}
					idx := idxObj.Value
					if idx < 0 || idx >= int64(len(arr.Elements)) {
						return newError(mce.GetLine(), "索引越界: %d", idx)
					}
					arr.Elements = append(arr.Elements[:idx], arr.Elements[idx+1:]...)
					return arr
				},
			}
		case "插":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) != 2 {
						return newError(mce.GetLine(), "插期望 2 个参数 (索引, 元素)")
					}
					idxObj, ok := fArgs[0].(*object.Integer)
					if !ok {
						return newError(mce.GetLine(), "索引必须是整数")
					}
					idx := idxObj.Value
					if idx < 0 || idx > int64(len(arr.Elements)) {
						return newError(mce.GetLine(), "索引越界: %d", idx)
					}
					val := fArgs[1]
					arr.Elements = append(arr.Elements[:idx], append([]object.Object{val}, arr.Elements[idx:]...)...)
					return arr
				},
			}
		case "找":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) != 1 {
						return newError(mce.GetLine(), "找期望 1 个参数 (元素)")
					}
					target := fArgs[0]
					for i, e := range arr.Elements {
						res := evalInfixExpression(mce.GetLine(), "==", e, target)
						if b, ok := res.(*object.Boolean); ok && b.Value {
							return &object.Integer{Value: int64(i)}
						}
					}
					return &object.Integer{Value: -1}
				},
			}
		case "映射":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "映射期望 1 个参数 (回调函数)")
					}
					fn := fArgs[0]
					newElements := make([]object.Object, len(arr.Elements))
					for i, e := range arr.Elements {
						res := applyFunction(mce.GetLine(), fn, []object.Object{e, &object.Integer{Value: int64(i)}})
						if isError(res) {
							return res
						}
						newElements[i] = res
					}
					return &object.Array{Elements: newElements}
				},
			}
		case "过滤":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "过滤期望 1 个参数 (谓词函数)")
					}
					fn := fArgs[0]
					newElements := []object.Object{}
					for i, e := range arr.Elements {
						res := applyFunction(mce.GetLine(), fn, []object.Object{e, &object.Integer{Value: int64(i)}})
						if isError(res) {
							return res
						}
						if isTruthy(res) {
							newElements = append(newElements, e)
						}
					}
					return &object.Array{Elements: newElements}
				},
			}
		case "包含":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "包含期望 1 个参数 (元素)")
					}
					target := fArgs[0]
					for _, e := range arr.Elements {
						res := evalInfixExpression(mce.GetLine(), "==", e, target)
						if b, ok := res.(*object.Boolean); ok && b.Value {
							return &object.Boolean{Value: true}
						}
					}
					return &object.Boolean{Value: false}
				},
			}
		case "包含?":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "包含?期望 1 个参数 (元素)")
					}
					target := fArgs[0]
					for _, e := range arr.Elements {
						res := evalInfixExpression(mce.GetLine(), "==", e, target)
						if b, ok := res.(*object.Boolean); ok && b.Value {
							return &object.Boolean{Value: true}
						}
					}
					return &object.Boolean{Value: false}
				},
			}
		case "空?":
			memberVal = &object.Boolean{Value: len(arr.Elements) == 0}
		case "非空?":
			memberVal = &object.Boolean{Value: len(arr.Elements) > 0}
		case "归纳":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					if len(fArgs) < 1 {
						return newError(mce.GetLine(), "归纳期望至少 1 个参数 (回调函数, [初值])")
					}
					fn := fArgs[0]
					var accumulator object.Object
					startIdx := 0
					if len(fArgs) >= 2 {
						accumulator = fArgs[1]
					} else {
						if len(arr.Elements) == 0 {
							return newError(mce.GetLine(), "对空数组进行归纳必须提供初值")
						}
						accumulator = arr.Elements[0]
						startIdx = 1
					}
					for i := startIdx; i < len(arr.Elements); i++ {
						accumulator = applyFunction(mce.GetLine(), fn, []object.Object{accumulator, arr.Elements[i], &object.Integer{Value: int64(i)}})
						if isError(accumulator) {
							return accumulator
						}
					}
					return accumulator
				},
			}
		case "去重":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					seen := make(map[string]bool)
					newElements := []object.Object{}
					for _, e := range arr.Elements {
						key := e.Inspect()
						if !seen[key] {
							seen[key] = true
							newElements = append(newElements, e)
						}
					}
					return &object.Array{Elements: newElements}
				},
			}
		case "展平":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					newElements := []object.Object{}
					var flatten func(object.Object)
					flatten = func(o object.Object) {
						if a, ok := o.(*object.Array); ok {
							for _, e := range a.Elements {
								flatten(e)
							}
						} else {
							newElements = append(newElements, o)
						}
					}
					flatten(arr)
					return &object.Array{Elements: newElements}
				},
			}
		case "排序":
			memberVal = &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					newElements := make([]object.Object, len(arr.Elements))
					copy(newElements, arr.Elements)
					sort.Slice(newElements, func(i, j int) bool {
						if len(fArgs) >= 1 {
							res := applyFunction(mce.GetLine(), fArgs[0], []object.Object{newElements[i], newElements[j]})
							return isTruthy(res)
						}
						res := evalInfixExpression(mce.GetLine(), "<", newElements[i], newElements[j])
						return isTruthy(res)
					})
					return &object.Array{Elements: newElements}
				},
			}
		}

		if memberVal != nil {
			if mce.Arguments != nil || memberVal.Type() == object.FUNCTION_OBJ || memberVal.Type() == object.BUILTIN_OBJ {
				return applyFunctionWithName(mce.GetLine(), mce.Member.Value, memberVal, args)
			}
			return memberVal
		}
	}

	// 处理字典/模块的成员调用
	if dict, ok := obj.(*object.Dict); ok {
		if val, ok := dict.Pairs[mce.Member.Value]; ok {
			// 特殊处理 '外' 模块的调用
			if self, ok := dict.Pairs["__NAME__"]; ok && self.Inspect() == "外" {
				switch mce.Member.Value {
				case "加载":
					if len(args) != 1 {
						return newError(mce.GetLine(), "加载期望 1 个参数")
					}
					libPath := args[0].Inspect()
					dll, err := syscall.LoadDLL(libPath)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
					}
					// 返回一个包装了 DLL 句柄的字典
					res := &object.Dict{Pairs: make(map[string]object.Object)}
					res.Pairs["__HANDLE__"] = &object.String{Value: "DLL"} // 标记类型
					res.Pairs["__PTR__"] = &object.Integer{Value: int64(uintptr(dll.Handle))}
					res.Pairs["__PATH__"] = &object.String{Value: libPath}
					return &object.Result{IsSuccess: true, Value: res}
				}
			}

			// 如果是类，不要在这里执行（即便有括号），让外部的 '造' 或其他逻辑处理
			if val.Type() == object.CLASS_OBJ {
				return val
			}

			// 如果有参数或者是函数类型，尝试执行
			if mce.Arguments != nil || val.Type() == object.FUNCTION_OBJ || val.Type() == object.BUILTIN_OBJ {
				return applyFunctionWithName(mce.GetLine(), mce.Member.Value, val, args)
			}
			// 否则作为属性直接返回
			return val
		}

		// 字典内置方法
		switch mce.Member.Value {
		case "键":
			keys := make([]object.Object, 0, len(dict.Pairs))
			for k := range dict.Pairs {
				keys = append(keys, &object.String{Value: k})
			}
			return &object.Array{Elements: keys}
		case "值":
			values := make([]object.Object, 0, len(dict.Pairs))
			for _, v := range dict.Pairs {
				values = append(values, v)
			}
			return &object.Array{Elements: values}
		case "含":
			if len(args) == 0 {
				return newError(mce.GetLine(), "含期望 1 个参数 (键)")
			}
			key := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				key = s.Value
			}
			_, ok := dict.Pairs[key]
			return &object.Boolean{Value: ok}
		case "删":
			if len(args) == 0 {
				return newError(mce.GetLine(), "删期望 1 个参数 (键)")
			}
			key := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				key = s.Value
			}
			delete(dict.Pairs, key)
			return dict
		case "大小", "长度":
			return &object.Integer{Value: int64(len(dict.Pairs))}
		case "空?":
			return &object.Boolean{Value: len(dict.Pairs) == 0}
		case "非空?":
			return &object.Boolean{Value: len(dict.Pairs) > 0}
		case "含?":
			if len(args) == 0 {
				return newError(mce.GetLine(), "含?期望 1 个参数 (键)")
			}
			key := args[0].Inspect()
			if s, ok := args[0].(*object.String); ok {
				key = s.Value
			}
			_, ok := dict.Pairs[key]
			return &object.Boolean{Value: ok}
		case "合并":
			if len(args) == 0 {
				return newError(mce.GetLine(), "合并期望 1 个参数 (字典)")
			}
			other, ok := args[0].(*object.Dict)
			if !ok {
				return newError(mce.GetLine(), "合并参数必须是字典")
			}
			newPairs := make(map[string]object.Object)
			for k, v := range dict.Pairs {
				newPairs[k] = v
			}
			for k, v := range other.Pairs {
				newPairs[k] = v
			}
			return &object.Dict{Pairs: newPairs}
		}
	}

	// 处理 FFI DLL 对象的成员调用
	if dict, ok := obj.(*object.Dict); ok {
		if handle, ok := dict.Pairs["__HANDLE__"]; ok && handle.Inspect() == "DLL" {
			ptr := dict.Pairs["__PTR__"].(*object.Integer).Value
			path := dict.Pairs["__PATH__"].Inspect()

			// 特殊方法：函数() - 用于定义带原型的外部函数
			if mce.Member.Value == "函数" {
				if len(args) < 1 {
					return newError(mce.GetLine(), "函数() 期望至少 1 个参数（函数名）")
				}
				funcName := args[0].Inspect()
				var paramTypes []string
				var returnType string

				if len(args) >= 2 {
					if arr, ok := args[1].(*object.Array); ok {
						for _, pt := range arr.Elements {
							paramTypes = append(paramTypes, pt.Inspect())
						}
					}
				}
				if len(args) >= 3 {
					returnType = args[2].Inspect()
				}

				return &object.FFIFunction{
					Name:       funcName,
					Path:       path,
					Handle:     uintptr(ptr),
					ParamTypes: paramTypes,
					ReturnType: returnType,
				}
			}

			// 此时成员名就是函数名，作为普通调用（向后兼容）
			procName := mce.Member.Value

			fn := &object.Builtin{
				Fn: func(fArgs ...object.Object) object.Object {
					dll := &syscall.DLL{Name: path, Handle: syscall.Handle(ptr)}
					proc, err := dll.FindProc(procName)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
					}

					// 转换参数为 uintptr
					uArgs := make([]uintptr, len(fArgs))
					for i, a := range fArgs {
						switch v := a.(type) {
						case *object.Integer:
							uArgs[i] = uintptr(v.Value)
						case *object.String:
							// 自动检测：如果函数名以 W 结尾，使用 UTF-16 编码，否则使用本地字节编码
							if strings.HasSuffix(procName, "W") {
								p, _ := syscall.UTF16PtrFromString(v.Value)
								uArgs[i] = uintptr(unsafe.Pointer(p))
							} else {
								p, _ := syscall.BytePtrFromString(v.Value)
								uArgs[i] = uintptr(unsafe.Pointer(p))
							}
						default:
							uArgs[i] = 0
						}
					}

					r1, _, _ := proc.Call(uArgs...)
					return &object.Integer{Value: int64(r1)}
				},
			}

			if mce.Arguments != nil {
				return applyFunctionWithName(mce.GetLine(), mce.Member.Value, fn, args)
			}
			return fn
		}
	}

	// 处理流对象的成员调用
	if stream, ok := obj.(*object.Stream); ok {
		switch mce.Member.Value {
		case "读":
			// 默认读取一行
			var size int64 = 0
			if len(args) > 0 {
				if s, ok := args[0].(*object.Integer); ok {
					size = s.Value
				}
			}

			if size > 0 {
				buf := make([]byte, size)
				n, err := stream.Conn.Read(buf)
				if err != nil {
					return &object.Null{}
				}
				return &object.String{Value: string(buf[:n])}
			} else if size == -1 {
				// 读取全部
				content, err := ioutil.ReadAll(stream.Conn)
				if err != nil {
					return &object.Null{}
				}
				return &object.String{Value: string(content)}
			} else {
				// 读行
				reader := bufio.NewReader(stream.Conn)
				line, err := reader.ReadString('\n')
				if err != nil {
					return &object.Null{}
				}
				return &object.String{Value: strings.TrimSpace(line)}
			}
		case "写":
			if len(args) == 0 {
				return newError(mce.GetLine(), "写期望 1 个参数")
			}
			content := args[0].Inspect()
			_, err := stream.Conn.Write([]byte(content + "\n"))
			if err != nil {
				return &object.Boolean{Value: false}
			}
			return &object.Boolean{Value: true}
		case "关":
			stream.Conn.Close()
			return &object.Null{}
		case "Inspect":
			return &object.String{Value: stream.Inspect()}
		}
	}

	// 处理 HTTP 响应对象的成员调用
	if res, ok := obj.(*object.HttpResponseWriter); ok {
		switch mce.Member.Value {
		case "写":
			if len(args) == 0 {
				return newError(mce.GetLine(), "写期望 1 个参数")
			}
			content := args[0].Inspect()
			res.Writer.Write([]byte(content))
			return &object.Null{}
		case "头":
			if len(args) < 2 {
				return newError(mce.GetLine(), "设置头部期望 2 个参数 (键, 值)")
			}
			res.Writer.Header().Set(args[0].Inspect(), args[1].Inspect())
			return &object.Null{}
		case "码":
			if len(args) < 1 {
				return newError(mce.GetLine(), "设置状态码期望 1 个参数")
			}
			if code, ok := args[0].(*object.Integer); ok {
				res.Writer.WriteHeader(int(code.Value))
			}
			return &object.Null{}
		}
	}

	// 处理通道对象的成员调用
	if channel, ok := obj.(*object.Channel); ok {
		switch mce.Member.Value {
		case "发", "送":
			if len(args) == 0 {
				return newError(mce.GetLine(), "%s期望 1 个参数", mce.Member.Value)
			}
			channel.Value <- args[0]
			return &object.Null{}
		case "收":
			val := <-channel.Value
			return val
		case "关":
			close(channel.Value)
			return &object.Null{}
		}
	}

	// 处理实例的成员调用
	if instance, ok := obj.(*object.Instance); ok {
		// 查找成员定义及其可见性
		var findMemberDef func(*object.Class, string) (token.TokenType, *object.Class, bool)
		findMemberDef = func(c *object.Class, name string) (token.TokenType, *object.Class, bool) {
			if vis, ok := c.Visibilities[name]; ok {
				return vis, c, true
			}
			if c.Parent != nil {
				return findMemberDef(c.Parent, name)
			}
			return "", nil, false
		}

		vis, owner, defined := findMemberDef(instance.Class, mce.Member.Value)
		if defined {
			if vis == token.TOKEN_PRIVATE {
				// 私有属性：必须是定义该属性的类内部方法访问
				canAccess := false
				if self, ok := env["__SELF__"]; ok && self == instance {
					// 还需要检查当前执行的方法所属类是否就是 owner
					if currentOwner, ok := env["__OWNER__"]; ok && currentOwner == owner {
						canAccess = true
					}
				}
				if !canAccess {
					return newError(mce.GetLine(), "禁止访问私有属性: %s", mce.Member.Value)
				}
			} else if vis == token.TOKEN_PROTECTED {
				// 保护属性：允许本类或子类访问
				canAccess := false
				if self, ok := env["__SELF__"]; ok {
					if selfInstance, ok := self.(*object.Instance); ok {
						if isSubclassOf(selfInstance.Class, instance.Class) {
							canAccess = true
						}
					}
				}
				if !canAccess {
					return newError(mce.GetLine(), "禁止访问受保护属性: %s", mce.Member.Value)
				}
			}
		}

		// 查找方法（沿继承链向上）
		var findMethod func(*object.Class, string) (*object.Function, bool)
		findMethod = func(c *object.Class, name string) (*object.Function, bool) {
			if m, ok := c.Methods[name]; ok {
				return m, true
			}
			if c.Parent != nil {
				return findMethod(c.Parent, name)
			}
			return nil, false
		}

		if method, ok := findMethod(instance.Class, mce.Member.Value); ok {
			boundFn := bindInstance(instance, method)
			if mce.Arguments != nil {
				return applyFunction(mce.GetLine(), boundFn, args)
			}
			return boundFn
		}

		// 检查 FFI DLL 对象（如果它是以实例形式存在的）
		// ... 这里我们已经在上面处理了字典形式的 DLL 包装

		// 查找字段
		if val, ok := instance.Fields[mce.Member.Value]; ok {
			// 如果字段本身是函数，也可以调用
			if fn, ok := val.(*object.Function); ok {
				boundFn := bindInstance(instance, fn)
				if mce.Arguments != nil {
					return applyFunction(mce.GetLine(), boundFn, args)
				}
				return boundFn
			}
			return val
		}
	}

	return newError(mce.GetLine(), "不支持的成员调用: %s.%s", obj.Type(), mce.Member.Value)
}

func isSubclassOf(child, parent *object.Class) bool {
	curr := child
	for curr != nil {
		if curr == parent {
			return true
		}
		curr = curr.Parent
	}
	return false
}

func implementsInterface(instance *object.Instance, inf *object.Interface) bool {
	for name, signature := range inf.Methods {
		method, ok := findMethod(instance.Class, name)
		if !ok {
			return false
		}
		// 校验方法签名
		if len(method.Parameters) != len(signature.Parameters) {
			return false
		}
		if method.ReturnType != signature.ReturnType {
			// 如果返回值类型不一致，暂时认为不满足。
			// 未来可以支持协变
			return false
		}
	}
	return true
}

func findMethod(class *object.Class, name string) (*object.Function, bool) {
	curr := class
	for curr != nil {
		if method, ok := curr.Methods[name]; ok {
			return method, true
		}
		curr = curr.Parent
	}
	return nil, false
}

func evalMemberAssignStatement(mas *ast.MemberAssignStatement, env map[string]object.Object) object.Object {
	obj := Eval(mas.Object, env)
	if isError(obj) {
		return obj
	}

	instance, ok := obj.(*object.Instance)
	if !ok {
		return newError(mas.GetLine(), "只有实例支持成员赋值，得到 %s", obj.Type())
	}

	// 查找成员定义及其可见性
	var findMemberDef func(*object.Class, string) (token.TokenType, *object.Class, bool)
	findMemberDef = func(c *object.Class, name string) (token.TokenType, *object.Class, bool) {
		if vis, ok := c.Visibilities[name]; ok {
			return vis, c, true
		}
		if c.Parent != nil {
			return findMemberDef(c.Parent, name)
		}
		return "", nil, false
	}

	vis, owner, defined := findMemberDef(instance.Class, mas.Member.Value)
	if defined {
		if vis == token.TOKEN_PRIVATE {
			canAccess := false
			if self, ok := env["__SELF__"]; ok && self == instance {
				if currentOwner, ok := env["__OWNER__"]; ok && currentOwner == owner {
					canAccess = true
				}
			}
			if !canAccess {
				return newError(mas.GetLine(), "禁止修改私有属性: %s", mas.Member.Value)
			}
		} else if vis == token.TOKEN_PROTECTED {
			canAccess := false
			if self, ok := env["__SELF__"]; ok {
				if selfInstance, ok := self.(*object.Instance); ok {
					if isSubclassOf(selfInstance.Class, instance.Class) {
						canAccess = true
					}
				}
			}
			if !canAccess {
				return newError(mas.GetLine(), "禁止修改受保护属性: %s", mas.Member.Value)
			}
		}
	}

	val := Eval(mas.Value, env)
	if isError(val) {
		return val
	}

	instance.Fields[mas.Member.Value] = val
	return val
}

func evalIndexExpression(line int, left, index object.Object) object.Object {
	switch {
	case left.Type() == object.ARRAY_OBJ && index.Type() == object.INTEGER_OBJ:
		return evalArrayIndexExpression(line, left, index)
	case left.Type() == object.DICT_OBJ:
		return evalDictIndexExpression(line, left, index)
	case left.Type() == object.STRING_OBJ && index.Type() == object.INTEGER_OBJ:
		return evalStringIndexExpression(line, left, index)
	case left.Type() == object.BYTES_OBJ && index.Type() == object.INTEGER_OBJ:
		return evalBytesIndexExpression(line, left, index)
	default:
		return newError(line, "不支持索引操作: %s[%s]", left.Type(), index.Type())
	}
}

func evalPrefixExpression(line int, operator string, right object.Object) object.Object {
	switch operator {
	case "非":
		return &object.Boolean{Value: !isTruthy(right)}
	case "-":
		if right.Type() == object.INTEGER_OBJ {
			val := right.(*object.Integer).Value
			return &object.Integer{Value: -val}
		}
		if right.Type() == object.FLOAT_OBJ {
			val := right.(*object.Float).Value
			return &object.Float{Value: -val}
		}
		return newError(line, "未知操作符: -%s", right.Type())
	default:
		return newError(line, "未知操作符: %s%s", operator, right.Type())
	}
}

func evalArrayIndexExpression(line int, array, index object.Object) object.Object {
	arrayObject := array.(*object.Array)
	idx := index.(*object.Integer).Value
	max := int64(len(arrayObject.Elements) - 1)

	if idx < 0 || idx > max {
		return &object.Null{}
	}

	return arrayObject.Elements[idx]
}

func evalDictIndexExpression(line int, dict, index object.Object) object.Object {
	dictObject := dict.(*object.Dict)

	key := index.Inspect() // 简单实现，将索引转为字符串作为键
	val, ok := dictObject.Pairs[key]
	if !ok {
		return &object.Null{}
	}

	return val
}

func evalStringIndexExpression(line int, str, index object.Object) object.Object {
	strObject := str.(*object.String)
	idx := index.(*object.Integer).Value

	runes := []rune(strObject.Value)
	max := int64(len(runes) - 1)

	if idx < 0 || idx > max {
		return &object.Null{}
	}

	return &object.String{Value: string(runes[idx])}
}

func evalBytesIndexExpression(line int, bytes, index object.Object) object.Object {
	bytesObject := bytes.(*object.Bytes)
	idx := index.(*object.Integer).Value
	max := int64(len(bytesObject.Value) - 1)

	if idx < 0 || idx > max {
		return &object.Null{}
	}

	return &object.Integer{Value: int64(bytesObject.Value[idx])}
}

func extendEnv(outer map[string]object.Object) map[string]object.Object {
	env := make(map[string]object.Object)
	// 我们不拷贝，而是通过特殊的键记录父环境，实现作用域链
	env["__PARENT_ENV__"] = &object.InternalEnv{Value: outer}
	return env
}

func lookupEnv(env map[string]object.Object, name string) (object.Object, bool) {
	val, ok := env[name]
	if ok {
		return val, true
	}
	if parent, ok := env["__PARENT_ENV__"]; ok {
		if pEnv, ok := parent.(*object.InternalEnv); ok {
			return lookupEnv(pEnv.Value, name)
		}
	}
	return nil, false
}

func updateEnv(env map[string]object.Object, name string, val object.Object) bool {
	if _, ok := env[name]; ok {
		env[name] = val
		return true
	}
	if parent, ok := env["__PARENT_ENV__"]; ok {
		if pEnv, ok := parent.(*object.InternalEnv); ok {
			return updateEnv(pEnv.Value, name, val)
		}
	}
	return false
}

func evalBlock(block []ast.Statement, env map[string]object.Object) object.Object {
	var result object.Object
	for _, stmt := range block {
		result = Eval(stmt, env)
		if result != nil {
			rt := result.Type()
			if rt == object.RETURN_VALUE_OBJ || rt == object.ERROR_OBJ || rt == object.BREAK_OBJ || rt == object.CONTINUE_OBJ {
				return result
			}
		}
	}
	if result == nil {
		return &object.Null{}
	}
	return result
}

func evalExpressions(exps []ast.Expression, env map[string]object.Object) []object.Object {
	var result []object.Object
	for _, e := range exps {
		evaluated := Eval(e, env)
		if isError(evaluated) {
			return []object.Object{evaluated}
		}
		result = append(result, evaluated)
	}
	return result
}

func evalDictLiteral(node *ast.DictLiteral, env map[string]object.Object) object.Object {
	pairs := make(map[string]object.Object)

	for keyNode, valueNode := range node.Pairs {
		var keyStr string
		// 如果键是标识符，直接将其作为字符串使用（类似 JS）
		if ident, ok := keyNode.(*ast.Identifier); ok {
			keyStr = ident.Value
		} else {
			key := Eval(keyNode, env)
			if isError(key) {
				return key
			}
			switch k := key.(type) {
			case *object.String:
				keyStr = k.Value
			case *object.Integer:
				keyStr = fmt.Sprintf("%d", k.Value)
			case *object.Boolean:
				keyStr = fmt.Sprintf("%t", k.Value)
			default:
				return newError(node.GetLine(), "不支持作为字典键的类型: %s", key.Type())
			}
		}

		val := Eval(valueNode, env)
		if isError(val) {
			return val
		}

		pairs[keyStr] = val
	}

	return &object.Dict{Pairs: pairs}
}

func applyFunction(line int, fn object.Object, args []object.Object) object.Object {
	return applyFunctionWithGenerics(line, "匿名函数", fn, args, nil)
}

func applyFunctionWithName(line int, name string, fn object.Object, args []object.Object) object.Object {
	return applyFunctionWithGenerics(line, name, fn, args, nil)
}

func applyFunctionWithGenerics(line int, name string, fn object.Object, args []object.Object, typeArgs []string) object.Object {
	switch function := fn.(type) {
	case *object.Function:
		// 绑定泛型参数
		boundTypeArgs := make(map[string]string)
		// 如果是方法，从实例中继承泛型绑定
		if function.Receiver != nil {
			for k, v := range function.Receiver.TypeArgs {
				boundTypeArgs[k] = v
			}
		}

		actualTypeArgs := typeArgs
		// 如果未显式提供泛型参数，尝试从参数推导
		if len(actualTypeArgs) == 0 && len(function.GenericParams) > 0 {
			actualTypeArgs = inferTypeArguments(function.GenericParams, function.Parameters, args)
		}

		// 如果提供了或推导出了泛型参数
		if len(function.GenericParams) > 0 {
			if len(actualTypeArgs) > 0 {
				if len(actualTypeArgs) != len(function.GenericParams) {
					return newError(line, "泛型参数数量不匹配: 期望 %d, 得到 %d", len(function.GenericParams), len(actualTypeArgs))
				}
				for i, p := range function.GenericParams {
					actualType := actualTypeArgs[i]
					if actualType == "" {
						return newError(line, "无法推导泛型参数 '%s'，请显式指定", p.Name)
					}
					// 校验约束
					if p.Constraint != "" {
						if !checkConstraint(p.Constraint, actualType, function.Env) {
							return newError(line, "泛型参数 '%s' 不满足约束 '%s': 实际得到 '%s'", p.Name, p.Constraint, actualType)
						}
					}
					boundTypeArgs[p.Name] = actualType
				}
			}
		}

		envObj := extendFunctionEnvWithGenerics(function, args, boundTypeArgs)
		if isError(envObj) {
			err := envObj.(*object.Error)
			err.Trace = append(err.Trace, fmt.Sprintf("%s [行:%d]", name, line))
			return err
		}
		extendedEnv := envObj.(*object.Dict).Pairs

		// 如果绑定了实例，注入实例上下文
		if function.Receiver != nil {
			instance := function.Receiver
			extendedEnv["__SELF__"] = instance
			if function.OwnerClass != nil {
				extendedEnv["__OWNER__"] = function.OwnerClass
			}

			// 不再直接注入成员到 extendedEnv，而是通过 Identifier 的 lookupEnv Fallback 处理
			// 这样可以避免成员覆盖函数参数
		}

		evaluated := evalBlock(function.Body, extendedEnv)
		if isError(evaluated) {
			err := evaluated.(*object.Error)
			err.Trace = append(err.Trace, fmt.Sprintf("%s [行:%d]", name, line))
			return err
		}
		result := unwrapReturnValue(evaluated)

		// 检查返回类型
		if function.ReturnType != "" {
			errObj := checkTypeWithGenerics(function.ReturnType, result, extendedEnv, boundTypeArgs)
			if errObj != nil {
				err := errObj.(*object.Error)
				err.Message = fmt.Sprintf("函数返回值 %s", err.Message)
				err.Trace = append(err.Trace, fmt.Sprintf("%s [行:%d]", name, line))
				return err
			}
		}

		return result
	case *object.FFIFunction:
		dll := &syscall.DLL{Name: function.Path, Handle: syscall.Handle(function.Handle)}
		proc, err := dll.FindProc(function.Name)
		if err != nil {
			return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
		}

		// 转换参数为 uintptr
		uArgs := make([]uintptr, len(args))
		for i, a := range args {
			// 如果有原型定义，可以进行类型检查（这里暂时简化，直接转换）
			switch v := a.(type) {
			case *object.Integer:
				uArgs[i] = uintptr(v.Value)
			case *object.String:
				// 自动检测：如果函数名以 W 结尾，使用 UTF-16 编码，否则使用本地字节编码
				if strings.HasSuffix(function.Name, "W") {
					p, _ := syscall.UTF16PtrFromString(v.Value)
					uArgs[i] = uintptr(unsafe.Pointer(p))
				} else {
					p, _ := syscall.BytePtrFromString(v.Value)
					uArgs[i] = uintptr(unsafe.Pointer(p))
				}
			default:
				uArgs[i] = 0
			}
		}

		r1, _, _ := proc.Call(uArgs...)
		// 如果有返回类型定义，可以按需转换。目前统一转为整数。
		return &object.Integer{Value: int64(r1)}

	case *object.Builtin:
		res := function.Fn(args...)
		if isError(res) {
			err := res.(*object.Error)
			err.Trace = append(err.Trace, fmt.Sprintf("内置函数:%s [行:%d]", name, line))
		}
		return res
	default:
		return newError(line, "不是函数: %s", fn.Type())
	}
}

func extendFunctionEnvWithGenerics(fn *object.Function, args []object.Object, boundTypeArgs map[string]string) object.Object {
	env := make(map[string]object.Object)
	// Copy outer env
	for k, v := range fn.Env {
		env[k] = v
	}
	for i, param := range fn.Parameters {
		val := args[i]
		// 类型检查
		if param.DataType != "" {
			err := checkTypeWithGenerics(param.DataType, val, env, boundTypeArgs)
			if err != nil {
				return newError(param.Name.GetLine(), "参数 '%s' %s", param.Name.Value, err.(*object.Error).Message)
			}
		}
		env[param.Name.Value] = val
	}
	return &object.Dict{Pairs: env}
}

func unwrapReturnValue(obj object.Object) object.Object {
	if returnValue, ok := obj.(*object.ReturnValue); ok {
		return returnValue.Value
	}
	return obj
}

func evalIdentifier(node *ast.Identifier, env map[string]object.Object) object.Object {
	if val, ok := lookupEnv(env, node.Value); ok {
		return val
	}

	// 检查是否是 '此' 的属性
	if self, ok := lookupEnv(env, "__SELF__"); ok {
		if instance, ok := self.(*object.Instance); ok {
			if val, ok := instance.Fields[node.Value]; ok {
				return val
			}
		}
	}

	return newError(node.GetLine(), "未定义的变量: "+node.Value)
}

func evalInfixExpression(line int, op string, left, right object.Object) object.Object {
	// 运算符重载逻辑
	if instance, ok := left.(*object.Instance); ok {
		var magicMethod string
		switch op {
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

		if magicMethod != "" {
			// 查找方法（包含继承链）
			if method, ok := findMethod(instance.Class, magicMethod); ok {
				return applyFunctionWithName(line, magicMethod, bindInstance(instance, method), []object.Object{right})
			}
		}
	}

	if op == "&" {
		return &object.String{Value: left.Inspect() + right.Inspect()}
	}
	switch {
	case left.Type() == object.INTEGER_OBJ && right.Type() == object.INTEGER_OBJ:
		return evalIntegerInfixExpression(line, op, left, right)
	case (left.Type() == object.FLOAT_OBJ || left.Type() == object.INTEGER_OBJ) &&
		(right.Type() == object.FLOAT_OBJ || right.Type() == object.INTEGER_OBJ):
		return evalFloatInfixExpression(line, op, left, right)
	case left.Type() == object.STRING_OBJ && right.Type() == object.STRING_OBJ:
		return evalStringInfixExpression(line, op, left, right)
	case op == "==" || op == "等于":
		return &object.Boolean{Value: left.Inspect() == right.Inspect()}
	case op == "是":
		// 支持 a 是 1 (逻辑相等) 或 a 是 "整" (类型判断)
		if right.Type() == object.STRING_OBJ {
			rVal := right.(*object.String).Value
			switch rVal {
			case "整", "整数":
				return &object.Boolean{Value: left.Type() == object.INTEGER_OBJ}
			case "字", "字符串":
				return &object.Boolean{Value: left.Type() == object.STRING_OBJ}
			case "逻", "逻辑":
				return &object.Boolean{Value: left.Type() == object.BOOLEAN_OBJ}
			case "小数":
				return &object.Boolean{Value: left.Type() == object.FLOAT_OBJ}
			case "数组":
				return &object.Boolean{Value: left.Type() == object.ARRAY_OBJ}
			case "字典":
				return &object.Boolean{Value: left.Type() == object.DICT_OBJ}
			case "空":
				return &object.Boolean{Value: left.Type() == object.NULL_OBJ}
			}
		}
		return &object.Boolean{Value: left.Inspect() == right.Inspect()}
	case op == "!=":
		return &object.Boolean{Value: left.Inspect() != right.Inspect()}
	default:
		return newError(line, "不支持的操作: %s %s %s", left.Type(), op, right.Type())
	}
}

func evalIntegerInfixExpression(line int, op string, left, right object.Object) object.Object {
	leftVal := left.(*object.Integer).Value
	rightVal := right.(*object.Integer).Value
	switch op {
	case "+":
		return &object.Integer{Value: leftVal + rightVal}
	case "-":
		return &object.Integer{Value: leftVal - rightVal}
	case "*":
		return &object.Integer{Value: leftVal * rightVal}
	case "/":
		if rightVal == 0 {
			return newError(line, "除数不能为零")
		}
		return &object.Integer{Value: leftVal / rightVal}
	case "%":
		if rightVal == 0 {
			return newError(line, "除数不能为零")
		}
		return &object.Integer{Value: leftVal % rightVal}
	case "<":
		return &object.Boolean{Value: leftVal < rightVal}
	case ">":
		return &object.Boolean{Value: leftVal > rightVal}
	case "<=":
		return &object.Boolean{Value: leftVal <= rightVal}
	case ">=":
		return &object.Boolean{Value: leftVal >= rightVal}
	case "==", "等于":
		return &object.Boolean{Value: leftVal == rightVal}
	case "是":
		return &object.Boolean{Value: leftVal == rightVal}
	case "!=":
		return &object.Boolean{Value: leftVal != rightVal}
	default:
		return newError(line, "未知的整数操作符: %s", op)
	}
}

func evalFloatInfixExpression(line int, op string, left, right object.Object) object.Object {
	var leftVal, rightVal float64
	if left.Type() == object.FLOAT_OBJ {
		leftVal = left.(*object.Float).Value
	} else {
		leftVal = float64(left.(*object.Integer).Value)
	}

	if right.Type() == object.FLOAT_OBJ {
		rightVal = right.(*object.Float).Value
	} else {
		rightVal = float64(right.(*object.Integer).Value)
	}

	switch op {
	case "+":
		return &object.Float{Value: leftVal + rightVal}
	case "-":
		return &object.Float{Value: leftVal - rightVal}
	case "*":
		return &object.Float{Value: leftVal * rightVal}
	case "/":
		if rightVal == 0 {
			return newError(line, "除数不能为零")
		}
		return &object.Float{Value: leftVal / rightVal}
	case "<":
		return &object.Boolean{Value: leftVal < rightVal}
	case ">":
		return &object.Boolean{Value: leftVal > rightVal}
	case "==", "等于":
		return &object.Boolean{Value: leftVal == rightVal}
	case "是":
		return &object.Boolean{Value: leftVal == rightVal}
	case "!=":
		return &object.Boolean{Value: leftVal != rightVal}
	default:
		return newError(line, "未知的小数操作符: %s", op)
	}
}

func evalStringInfixExpression(line int, op string, left, right object.Object) object.Object {
	leftVal := left.(*object.String).Value
	rightVal := right.(*object.String).Value
	switch op {
	case "+":
		return &object.String{Value: leftVal + rightVal}
	case "==", "等于":
		return &object.Boolean{Value: leftVal == rightVal}
	case "是":
		return &object.Boolean{Value: leftVal == rightVal}
	case "!=":
		return &object.Boolean{Value: leftVal != rightVal}
	case "<":
		return &object.Boolean{Value: leftVal < rightVal}
	case ">":
		return &object.Boolean{Value: leftVal > rightVal}
	case "<=":
		return &object.Boolean{Value: leftVal <= rightVal}
	case ">=":
		return &object.Boolean{Value: leftVal >= rightVal}
	default:
		return newError(line, "未知的字符串操作符: %s", op)
	}
}

func isTruthy(obj object.Object) bool {
	switch obj := obj.(type) {
	case *object.Boolean:
		return obj.Value
	case *object.Integer:
		return obj.Value != 0
	case *object.Float:
		return obj.Value != 0.0
	case *object.String:
		return obj.Value != ""
	case *object.Null:
		return false
	default:
		return true
	}
}

func newError(line int, format string, a ...interface{}) *object.Error {
	return &object.Error{Message: fmt.Sprintf("[第 %d 行]: %s", line, fmt.Sprintf(format, a...))}
}

func isError(obj object.Object) bool {
	if obj != nil {
		return obj.Type() == object.ERROR_OBJ
	}
	return false
}

func evalListenExpression(le *ast.ListenExpression, env map[string]object.Object) object.Object {
	addr := Eval(le.Address, env)
	if isError(addr) {
		return addr
	}

	callback := Eval(le.Callback, env)
	if isError(callback) {
		return callback
	}

	addrStr := addr.Inspect()
	if !strings.Contains(addrStr, ":") {
		// 如果只是数字，当作端口处理
		if _, err := strconv.Atoi(addrStr); err == nil {
			addrStr = ":" + addrStr
		}
	}

	// 检查回调函数参数数量
	var paramCount int
	if fn, ok := callback.(*object.Function); ok {
		paramCount = len(fn.Parameters)
	} else if bi, ok := callback.(*object.Builtin); ok {
		// 内置函数无法确定参数数量，默认当作 1 个 (TCP)
		_ = bi
		paramCount = 1
	}

	if paramCount == 2 {
		// HTTP 模式
		server := &http.Server{
			Addr: addrStr,
			Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				// 包装请求对象
				reqDict := &object.Dict{Pairs: make(map[string]object.Object)}
				reqDict.Pairs["方法"] = &object.String{Value: r.Method}
				reqDict.Pairs["路径"] = &object.String{Value: r.URL.Path}

				headers := &object.Dict{Pairs: make(map[string]object.Object)}
				for k, v := range r.Header {
					headers.Pairs[k] = &object.String{Value: strings.Join(v, ",")}
				}
				reqDict.Pairs["头"] = headers

				body, _ := ioutil.ReadAll(r.Body)
				reqDict.Pairs["主体"] = &object.String{Value: string(body)}

				// 包装响应对象
				resObj := &object.HttpResponseWriter{Writer: w}

				applyFunction(le.GetLine(), callback, []object.Object{reqDict, resObj})
			}),
		}
		go server.ListenAndServe()
	} else {
		// TCP 模式
		listener, err := net.Listen("tcp", addrStr)
		if err != nil {
			return newError(le.GetLine(), "监听失败: %s", err.Error())
		}

		go func() {
			defer listener.Close()
			for {
				conn, err := listener.Accept()
				if err != nil {
					continue
				}
				stream := &object.Stream{Conn: conn}
				go applyFunction(le.GetLine(), callback, []object.Object{stream})
			}
		}()
	}

	return &object.Null{}
}

func evalConnectExpression(ce *ast.ConnectExpression, env map[string]object.Object) object.Object {
	addr := Eval(ce.Address, env)
	if isError(addr) {
		return addr
	}

	timeout := 5 * time.Second
	if len(ce.Arguments) > 0 {
		// 寻找名为 ".超时" 的参数
		// 目前简单处理第一个参数如果是整数则为毫秒超时
		arg := Eval(ce.Arguments[0], env)
		if t, ok := arg.(*object.Integer); ok {
			timeout = time.Duration(t.Value) * time.Millisecond
		}
	}

	conn, err := net.DialTimeout("tcp", addr.Inspect(), timeout)
	if err != nil {
		return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
	}

	return &object.Result{IsSuccess: true, Value: &object.Stream{Conn: conn}}
}

func evalRequestExpression(re *ast.ConnectRequestExpression, env map[string]object.Object) object.Object {
	url := Eval(re.Url, env)
	if isError(url) {
		return url
	}

	method := "GET"
	var body io.Reader
	headers := make(map[string]string)

	if len(re.Arguments) > 0 {
		arg := Eval(re.Arguments[0], env)
		if dict, ok := arg.(*object.Dict); ok {
			if m, ok := dict.Pairs["方法"]; ok {
				method = m.Inspect()
			}
			if b, ok := dict.Pairs["主体"]; ok {
				body = strings.NewReader(b.Inspect())
			}
			if h, ok := dict.Pairs["头"]; ok {
				if hd, ok := h.(*object.Dict); ok {
					for k, v := range hd.Pairs {
						headers[k] = v.Inspect()
					}
				}
			}
		}
	}

	req, err := http.NewRequest(method, url.Inspect(), body)
	if err != nil {
		return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
	}

	for k, v := range headers {
		req.Header.Set(k, v)
	}

	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
	}
	defer resp.Body.Close()

	respBody, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
	}

	return &object.Result{IsSuccess: true, Value: &object.String{Value: string(respBody)}}
}

func evalExecuteExpression(ee *ast.ExecuteExpression, env map[string]object.Object) object.Object {
	cmdExpr := Eval(ee.Command, env)
	if isError(cmdExpr) {
		return cmdExpr
	}

	cmdStr := cmdExpr.Inspect()
	var cmd *exec.Cmd
	if strings.Contains(cmdStr, " ") {
		parts := strings.Fields(cmdStr)
		cmd = exec.Command(parts[0], parts[1:]...)
	} else {
		cmd = exec.Command(cmdStr)
	}

	out, err := cmd.CombinedOutput()
	if err != nil {
		return &object.Result{IsSuccess: false, Error: &object.String{Value: string(out) + " " + err.Error()}}
	}

	return &object.Result{IsSuccess: true, Value: &object.String{Value: string(out)}}
}

func getXTTypeName(obj object.Object) string {
	switch obj.Type() {
	case object.INTEGER_OBJ:
		return "整"
	case object.FLOAT_OBJ:
		return "小数"
	case object.STRING_OBJ:
		return "字"
	case object.BOOLEAN_OBJ:
		return "逻"
	case object.ARRAY_OBJ:
		return "数组"
	case object.DICT_OBJ:
		return "字典"
	case object.NULL_OBJ:
		return "空"
	case object.INSTANCE_OBJ:
		return obj.(*object.Instance).Class.Name
	case object.RESULT_OBJ:
		return "结果"
	default:
		return string(obj.Type())
	}
}

func inferTypeArguments(genericParams []*ast.GenericParam, params []*ast.Parameter, args []object.Object) []string {
	inferred := make(map[string]string)
	for i, p := range params {
		if i >= len(args) {
			break
		}
		arg := args[i]
		expectedType := p.DataType
		// 检查参数类型是否直接引用了泛型参数
		for _, gp := range genericParams {
			if expectedType == gp.Name {
				inferred[gp.Name] = getXTTypeName(arg)
			}
		}
	}

	res := make([]string, len(genericParams))
	for i, gp := range genericParams {
		res[i] = inferred[gp.Name]
	}
	return res
}

func checkConstraint(constraint string, actualType string, env map[string]object.Object) bool {
	if constraint == "" {
		return true
	}

	// 我们需要创建一个该类型的模拟实例来进行校验
	// 但这比较重。简化的做法是检查 actualType 是否满足 constraint 契约。
	if actualType == constraint {
		return true
	}

	// 获取实际类型的对象
	actualTypeObj, ok := env[actualType]
	if !ok {
		// 可能是内置类型，目前我们只支持对类和接口的约束
		return false
	}

	// 获取约束类型的对象
	constraintObj, ok := env[constraint]
	if !ok {
		return false
	}

	switch c := constraintObj.(type) {
	case *object.Class:
		if a, ok := actualTypeObj.(*object.Class); ok {
			return isSubclassOf(a, c)
		}
	case *object.Interface:
		if a, ok := actualTypeObj.(*object.Class); ok {
			// 创建一个模拟实例来检查接口实现
			mockInstance := &object.Instance{Class: a}
			return implementsInterface(mockInstance, c)
		}
	}

	return false
}

func checkType(expectedType string, val object.Object, env map[string]object.Object) object.Object {
	return checkTypeWithGenerics(expectedType, val, env, nil)
}

func checkTypeWithGenerics(expectedType string, val object.Object, env map[string]object.Object, boundTypeArgs map[string]string) object.Object {
	if expectedType == "" {
		return nil
	}

	// 0. 处理泛型参数替换 (如 T -> 整)
	if boundTypeArgs != nil {
		if substituted, ok := boundTypeArgs[expectedType]; ok {
			expectedType = substituted
		}
	}

	// 1. 处理联合类型 (Union Types)
	if strings.Contains(expectedType, " | ") {
		types := strings.Split(expectedType, " | ")
		for _, t := range types {
			if checkTypeWithGenerics(strings.TrimSpace(t), val, env, boundTypeArgs) == nil {
				return nil
			}
		}
		return &object.Error{Message: fmt.Sprintf("类型不匹配: 期望 %s，实际得到 %s", expectedType, val.Type())}
	}

	// 2. 处理可空类型 (Nullable Types)
	if strings.HasSuffix(expectedType, "?") {
		if val.Type() == object.NULL_OBJ {
			return nil
		}
		baseType := expectedType[:len(expectedType)-1]
		return checkTypeWithGenerics(baseType, val, env, boundTypeArgs)
	}

	// 3. 处理带泛型参数的类型校验 (如 盒子<整>)
	if strings.Contains(expectedType, "<") && strings.HasSuffix(expectedType, ">") {
		baseTypeName := expectedType[:strings.Index(expectedType, "<")]
		argsStr := expectedType[strings.Index(expectedType, "<")+1 : len(expectedType)-1]
		typeArgs := strings.Split(argsStr, ",")
		for i := range typeArgs {
			typeArgs[i] = strings.TrimSpace(typeArgs[i])
		}

		// 首先校验基础类名
		if err := checkTypeWithGenerics(baseTypeName, val, env, boundTypeArgs); err != nil {
			return err
		}

		// 如果是实例，进一步校验泛型绑定是否一致
		if instance, ok := val.(*object.Instance); ok {
			class := instance.Class
			if len(class.GenericParams) != len(typeArgs) {
				return &object.Error{Message: fmt.Sprintf("泛型参数数量不匹配: 期望 %d, 得到 %d", len(class.GenericParams), len(typeArgs))}
			}
			for i, p := range class.GenericParams {
				actualArg := instance.TypeArgs[p.Name]
				expectedArg := typeArgs[i]
				// 递归校验泛型参数
				// 注意：这里我们简单对比类型名字符串，或者可以进行更深度的类型兼容性检查
				if actualArg != expectedArg {
					return &object.Error{Message: fmt.Sprintf("泛型参数 '%s' 类型不匹配: 期望 %s, 得到 %s", p.Name, expectedArg, actualArg)}
				}
			}
			return nil
		}
	}

	actualType := val.Type()
	switch expectedType {
	case "字", "字符串":
		if actualType == object.STRING_OBJ {
			return nil
		}
	case "整", "整数":
		if actualType == object.INTEGER_OBJ {
			return nil
		}
	case "小数":
		if actualType == object.FLOAT_OBJ {
			return nil
		}
	case "逻", "逻辑":
		if actualType == object.BOOLEAN_OBJ {
			return nil
		}
	case "数组":
		if actualType == object.ARRAY_OBJ {
			return nil
		}
	case "字典":
		if actualType == object.DICT_OBJ {
			return nil
		}
	case "结果":
		if actualType == object.RESULT_OBJ {
			return nil
		}
	case "字节":
		if actualType == object.BYTES_OBJ {
			return nil
		}
	case "空":
		if actualType == object.NULL_OBJ {
			return nil
		}
	default:
		// 检查自定义类名或接口
		if typeObj, ok := env[expectedType]; ok {
			switch t := typeObj.(type) {
			case *object.Class:
				if instance, ok := val.(*object.Instance); ok {
					if isSubclassOf(instance.Class, t) {
						return nil
					}
				}
			case *object.Interface:
				if instance, ok := val.(*object.Instance); ok {
					if implementsInterface(instance, t) {
						return nil
					}
				}
			}
		}
	}

	return &object.Error{Message: fmt.Sprintf("类型不匹配: 期望 %s，实际得到 %s", expectedType, actualType)}
}

func evalComplexAssignStatement(cas *ast.ComplexAssignStatement, env map[string]object.Object) object.Object {
	val := EvalContext(cas.Right, env, true)
	if isError(val) {
		return val
	}

	switch left := cas.Left.(type) {
	case *ast.Identifier:
		if !updateEnv(env, left.Value, val) {
			if self, ok := lookupEnv(env, "__SELF__"); ok {
				if instance, ok := self.(*object.Instance); ok {
					instance.Fields[left.Value] = val
					return val
				}
			}
			return newError(cas.GetLine(), "未定义的变量: %s", left.Value)
		}
		return val

	case *ast.IndexExpression:
		leftObj := Eval(left.Left, env)
		if isError(leftObj) {
			return leftObj
		}

		index := Eval(left.Index, env)
		if isError(index) {
			return index
		}

		switch container := leftObj.(type) {
		case *object.Array:
			idx, ok := index.(*object.Integer)
			if !ok {
				return newError(cas.GetLine(), "数组索引必须是整数")
			}
			if idx.Value < 0 || idx.Value >= int64(len(container.Elements)) {
				return newError(cas.GetLine(), "索引越界")
			}
			container.Elements[idx.Value] = val
			return val
		case *object.Dict:
			key := index.Inspect()
			container.Pairs[key] = val
			return val
		default:
			return newError(cas.GetLine(), "不支持索引赋值的类型: %s", leftObj.Type())
		}

	case *ast.MemberCallExpression:
		obj := Eval(left.Object, env)
		if isError(obj) {
			return obj
		}

		if instance, ok := obj.(*object.Instance); ok {
			instance.Fields[left.Member.Value] = val
			return val
		}
		return newError(cas.GetLine(), "不支持成员赋值的类型: %s", obj.Type())
	}

	return newError(cas.GetLine(), "不支持的赋值左值类型")
}
