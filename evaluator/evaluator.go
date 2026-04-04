package evaluator

import (
	"fmt"
	"io/ioutil"
	"path/filepath"
	"xuantie/ast"
	"xuantie/lexer"
	"xuantie/object"
	"xuantie/parser"
	"xuantie/stdlib"
)

func RegisterStdLib(env map[string]object.Object) {
	for name, obj := range stdlib.Builtins {
		env[name] = obj
	}
}

func Eval(node ast.Node, env map[string]object.Object) object.Object {
	return EvalContext(node, env, false)
}

func EvalContext(node ast.Node, env map[string]object.Object, isAssignment bool) object.Object {
	switch n := node.(type) {
	case *ast.Program:
		return evalProgram(n, env)
	case *ast.AssignStatement:
		val := EvalContext(n.Value, env, true)
		if isError(val) {
			return val
		}
		if _, ok := env[n.Name]; !ok {
			return newError(n.GetLine(), "未定义的变量: %s", n.Name)
		}
		env[n.Name] = val
		return val
	case *ast.VarStatement:
		val := EvalContext(n.Value, env, true)
		if isError(val) {
			return val
		}
		// 简单类型检查
		if n.DataType != "" {
			switch n.DataType {
			case "字符串":
				if val.Type() != object.STRING_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望字符串，得到 %s", val.Type())
				}
			case "整数":
				if val.Type() != object.INTEGER_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望整数，得到 %s", val.Type())
				}
			case "小数":
				if val.Type() != object.FLOAT_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望小数，得到 %s", val.Type())
				}
			case "逻辑":
				if val.Type() != object.BOOLEAN_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望逻辑，得到 %s", val.Type())
				}
			case "数组":
				if val.Type() != object.ARRAY_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望数组，得到 %s", val.Type())
				}
			case "字典":
				if val.Type() != object.DICT_OBJ {
					return newError(n.GetLine(), "类型不匹配: 期望字典，得到 %s", val.Type())
				}
			}
		}
		env[n.Name.Value] = val
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
	case *ast.ForStatement:
		return evalForStatement(n, env)
	case *ast.BreakStatement:
		return &object.Break{}
	case *ast.ContinueStatement:
		return &object.Continue{}
	case *ast.TryCatchStatement:
		return evalTryCatchStatement(n, env)
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
	case *ast.FunctionLiteral:
		return &object.Function{Parameters: n.Parameters, Body: n.Body, Env: env}
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
		function := Eval(n.Function, env)
		if isError(function) {
			return function
		}
		args := evalExpressions(n.Arguments, env)
		if len(args) == 1 && isError(args[0]) {
			return args[0]
		}
		return applyFunction(n.GetLine(), function, args)
	case *ast.AwaitExpression:
		return evalAwaitExpression(n, env)
	case *ast.MemberCallExpression:
		return evalMemberCallExpression(n, env)
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
	case *ast.Identifier:
		return evalIdentifier(n, env)
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

	content, err := ioutil.ReadFile(path)
	if err != nil {
		return newError(ie.GetLine(), "引用文件失败: 找不到文件或无法读取 (%s)", path)
	}

	l := lexer.New(string(content))
	p := parser.New(l)
	program := p.ParseProgram()
	program.FilePath = path // 设置新程序的路径，以便它也能正确处理它的引用

	if len(p.Errors()) != 0 {
		return newError(ie.GetLine(), "引用文件解析错误: %s", p.Errors()[0])
	}

	// 模块有自己的独立环境
	moduleEnv := make(map[string]object.Object)
	RegisterStdLib(moduleEnv)
	if isAssignment {
		moduleEnv["__PURE__"] = &object.Boolean{Value: true}
	}

	// 执行模块代码
	result := Eval(program, moduleEnv)
	if isError(result) {
		return result
	}

	// 收集所有顶层变量作为模块导出
	dict := &object.Dict{Pairs: make(map[string]object.Object)}
	for k, v := range moduleEnv {
		// 过滤掉内置函数和内部保留变量，只导出模块定义的变量
		if _, isBuiltin := stdlib.Builtins[k]; !isBuiltin && k != "__DIR__" && k != "__PURE__" {
			dict.Pairs[k] = v
		}
	}

	return dict
}

func evalProgram(prog *ast.Program, env map[string]object.Object) object.Object {
	// 设置当前程序所在的目录到环境，用于后续的相对路径引用
	if prog.FilePath != "" {
		env["__DIR__"] = &object.String{Value: filepath.Dir(prog.FilePath)}
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
	} else if len(ie.ElseBlock) > 0 {
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

func evalForStatement(fs *ast.ForStatement, env map[string]object.Object) object.Object {
	iterable := Eval(fs.Iterable, env)
	if isError(iterable) {
		return iterable
	}

	switch obj := iterable.(type) {
	case *object.Array:
		for _, element := range obj.Elements {
			// 为每个迭代创建新的局部作用域
			loopEnv := extendEnv(env)
			loopEnv[fs.Variable.Value] = element

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
		for key := range obj.Pairs {
			loopEnv := extendEnv(env)
			loopEnv[fs.Variable.Value] = &object.String{Value: key}

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
		for _, r := range obj.Value {
			loopEnv := extendEnv(env)
			loopEnv[fs.Variable.Value] = &object.String{Value: string(r)}

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

func evalTryCatchStatement(ts *ast.TryCatchStatement, env map[string]object.Object) object.Object {
	// 创建局部环境
	tryEnv := extendEnv(env)
	result := evalBlock(ts.TryBlock, tryEnv)

	if isError(result) {
		catchEnv := extendEnv(env)
		if ts.CatchVar != nil {
			// 将错误对象转换为字符串，避免在 Catch 块中继续触发错误传播
			catchEnv[ts.CatchVar.Value] = &object.String{Value: result.Inspect()}
		}
		return evalBlock(ts.CatchBlock, catchEnv)
	}
	return result
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
		case "接着":
			if result.IsSuccess {
				return applyFunction(mce.GetLine(), args[0], []object.Object{result.Value})
			}
			return result // 保持原样向下传递
		case "否则":
			if !result.IsSuccess {
				return applyFunction(mce.GetLine(), args[0], []object.Object{result.Error})
			}
			return result // 保持原样向下传递
		}
	}

	// 处理字符串成员属性
	if str, ok := obj.(*object.String); ok {
		switch mce.Member.Value {
		case "长度":
			return &object.Integer{Value: int64(len(str.Value))}
		}
	}

	// 处理字典/模块的成员调用
	if dict, ok := obj.(*object.Dict); ok {
		if val, ok := dict.Pairs[mce.Member.Value]; ok {
			return applyFunction(mce.GetLine(), val, args)
		}
	}

	return newError(mce.GetLine(), "不支持的成员调用: %s.%s", obj.Type(), mce.Member.Value)
}

func evalIndexExpression(line int, left, index object.Object) object.Object {
	switch {
	case left.Type() == object.ARRAY_OBJ && index.Type() == object.INTEGER_OBJ:
		return evalArrayIndexExpression(line, left, index)
	case left.Type() == object.DICT_OBJ:
		return evalDictIndexExpression(line, left, index)
	case left.Type() == object.STRING_OBJ && index.Type() == object.INTEGER_OBJ:
		return evalStringIndexExpression(line, left, index)
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

func extendEnv(outer map[string]object.Object) map[string]object.Object {
	env := make(map[string]object.Object)
	for k, v := range outer {
		env[k] = v
	}
	return env
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
	switch function := fn.(type) {
	case *object.Function:
		extendedEnv := extendFunctionEnv(function, args)
		evaluated := evalBlock(function.Body, extendedEnv)
		return unwrapReturnValue(evaluated)
	case *object.Builtin:
		return function.Fn(args...)
	default:
		return newError(line, "不是函数: %s", fn.Type())
	}
}

func extendFunctionEnv(fn *object.Function, args []object.Object) map[string]object.Object {
	env := make(map[string]object.Object)
	// Copy outer env (not efficient but simple for now)
	for k, v := range fn.Env {
		env[k] = v
	}
	for i, param := range fn.Parameters {
		env[param.Value] = args[i]
	}
	return env
}

func unwrapReturnValue(obj object.Object) object.Object {
	if returnValue, ok := obj.(*object.ReturnValue); ok {
		return returnValue.Value
	}
	return obj
}

func evalIdentifier(node *ast.Identifier, env map[string]object.Object) object.Object {
	if val, ok := env[node.Value]; ok {
		return val
	}
	return newError(node.GetLine(), "未定义的变量: "+node.Value)
}

func evalInfixExpression(line int, op string, left, right object.Object) object.Object {
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
	case op == "==" || op == "=": // 支持 = 作为相等
		return &object.Boolean{Value: left.Inspect() == right.Inspect()} // 简单比较
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
	case "<":
		return &object.Boolean{Value: leftVal < rightVal}
	case ">":
		return &object.Boolean{Value: leftVal > rightVal}
	case "==", "=": // 支持 = 作为相等
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
	case "==", "=":
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
	case "==", "=": // 支持 = 作为相等
		return &object.Boolean{Value: leftVal == rightVal}
	case "!=":
		return &object.Boolean{Value: leftVal != rightVal}
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
