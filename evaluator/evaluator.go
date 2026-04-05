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

		// 如果在实例方法中，同步修改实例字段
		if self, ok := env["__SELF__"]; ok {
			if instance, ok := self.(*object.Instance); ok {
				if _, ok := instance.Fields[n.Name]; ok {
					instance.Fields[n.Name] = val
				}
			}
		}
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
	case *ast.LoopStatement:
		return evalLoopExpression(n, env)
	case *ast.ForStatement:
		return evalForStatement(n, env)
	case *ast.BreakStatement:
		return &object.Break{}
	case *ast.ContinueStatement:
		return &object.Continue{}
	case *ast.TryCatchStatement:
		return evalTryCatchStatement(n, env)
	case *ast.FunctionStatement:
		fn := &object.Function{Parameters: n.Parameters, Body: n.Body, Env: env}
		env[n.Name.Value] = fn
		return &object.Null{}
	case *ast.TypeDefinitionStatement:
		return evalTypeDefinitionStatement(n, env)
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
	case *ast.MemberAssignStatement:
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

	// 收集所有顶层变量作为模块导出
	dict := &object.Dict{Pairs: make(map[string]object.Object)}
	for k, v := range moduleEnv {
		// 过滤掉内置函数和内部保留变量，只导出模块定义的变量
		if _, isBuiltin := stdlib.Builtins[k]; !isBuiltin && k != "__DIR__" && k != "__PURE__" && k != "__STACK__" && k != "__FILE__" {
			dict.Pairs[k] = v
		}
	}

	return dict
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

func evalTypeDefinitionStatement(tds *ast.TypeDefinitionStatement, env map[string]object.Object) object.Object {
	class := &object.Class{
		Name:         tds.Name.Value,
		Fields:       make(map[string]object.Object),
		Methods:      make(map[string]*object.Function),
		Visibilities: make(map[string]token.TokenType),
		Env:          env,
	}

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
			fn := &object.Function{Parameters: s.Parameters, Body: s.Body, Env: classEnv, OwnerClass: class}
			class.Methods[s.Name.Value] = fn
			if s.Visibility != "" {
				class.Visibilities[s.Name.Value] = s.Visibility
			}
		}
	}

	env[tds.Name.Value] = class
	return &object.Null{}
}

func evalNewExpression(ne *ast.NewExpression, env map[string]object.Object) object.Object {
	obj := Eval(ne.Type, env)
	if isError(obj) {
		return obj
	}

	class, ok := obj.(*object.Class)
	if !ok {
		return newError(ne.GetLine(), "不是类型: %s", obj.Type())
	}

	instance := &object.Instance{
		Class:  class,
		Fields: make(map[string]object.Object),
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
		args := evalExpressions(ne.Arguments, env)
		if len(args) == 1 && isError(args[0]) {
			return args[0]
		}

		boundConstructor := bindInstance(instance, constructor)
		applyFunction(ne.GetLine(), boundConstructor, args)
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
		Parameters: fn.Parameters,
		Body:       fn.Body,
		Env:        fn.Env,
		OwnerClass: fn.OwnerClass,
		Receiver:   instance,
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
		case "接着":
			if result.IsSuccess {
				res := applyFunction(mce.GetLine(), args[0], []object.Object{result.Value})
				if r, ok := res.(*object.Result); ok {
					return r
				}
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
		case "否则":
			if !result.IsSuccess {
				res := applyFunction(mce.GetLine(), args[0], []object.Object{result.Error})
				if r, ok := res.(*object.Result); ok {
					return r
				}
				return &object.Result{IsSuccess: true, Value: res}
			}
			return result
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
			return &object.Boolean{Value: strings.Contains(str.Value, args[0].Inspect())}
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
			return applyFunction(mce.GetLine(), val, args)
		}
	}

	// 处理 FFI DLL 对象的成员调用
	if dict, ok := obj.(*object.Dict); ok {
		if handle, ok := dict.Pairs["__HANDLE__"]; ok && handle.Inspect() == "DLL" {
			// 此时成员名就是函数名
			procName := mce.Member.Value
			ptr := dict.Pairs["__PTR__"].(*object.Integer).Value
			path := dict.Pairs["__PATH__"].Inspect()

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
							p, _ := syscall.BytePtrFromString(v.Value)
							uArgs[i] = uintptr(unsafe.Pointer(p))
						default:
							uArgs[i] = 0
						}
					}

					r1, _, _ := proc.Call(uArgs...)
					return &object.Integer{Value: int64(r1)}
				},
			}

			if mce.Arguments != nil {
				return applyFunction(mce.GetLine(), fn, args)
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
		case "送":
			if len(args) == 0 {
				return newError(mce.GetLine(), "送期望 1 个参数")
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

		// 如果绑定了实例，注入实例上下文
		if function.Receiver != nil {
			instance := function.Receiver
			extendedEnv["__SELF__"] = instance
			if function.OwnerClass != nil {
				extendedEnv["__OWNER__"] = function.OwnerClass
			}

			// 注入可见成员
			// 1. 本类定义的成员
			if function.OwnerClass != nil {
				for k, v := range function.OwnerClass.Methods {
					extendedEnv[k] = bindInstance(instance, v)
				}
				for k := range function.OwnerClass.Fields {
					if val, ok := instance.Fields[k]; ok {
						extendedEnv[k] = val
					}
				}

				// 2. 祖先类定义的成员
				var injectVisibleAncestors func(*object.Class)
				injectVisibleAncestors = func(c *object.Class) {
					if c.Parent != nil {
						injectVisibleAncestors(c.Parent)
					}
					for k, v := range c.Methods {
						if vis := c.Visibilities[k]; vis == token.TOKEN_PROTECTED || vis == token.TOKEN_PUBLIC || vis == "" {
							extendedEnv[k] = bindInstance(instance, v)
						}
					}
					for k := range c.Fields {
						if vis := c.Visibilities[k]; vis == token.TOKEN_PROTECTED || vis == token.TOKEN_PUBLIC || vis == "" {
							if val, ok := instance.Fields[k]; ok {
								extendedEnv[k] = val
							}
						}
					}
				}
				if function.OwnerClass.Parent != nil {
					injectVisibleAncestors(function.OwnerClass.Parent)
				}
			}
		}

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
