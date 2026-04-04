package object

import (
	"fmt"
	"strings"
	"xuantie/ast"
)

type ObjectType string

const (
	INTEGER_OBJ      ObjectType = "INTEGER"
	FLOAT_OBJ        ObjectType = "FLOAT"
	STRING_OBJ       ObjectType = "STRING"
	BOOLEAN_OBJ      ObjectType = "BOOLEAN"
	NULL_OBJ         ObjectType = "NULL"
	ERROR_OBJ        ObjectType = "ERROR"
	FUNCTION_OBJ     ObjectType = "FUNCTION"
	RETURN_VALUE_OBJ ObjectType = "RETURN_VALUE"
	ARRAY_OBJ        ObjectType = "ARRAY"
	DICT_OBJ         ObjectType = "DICT"
	RESULT_OBJ       ObjectType = "RESULT"
	TASK_OBJ         ObjectType = "TASK"
	BUILTIN_OBJ      ObjectType = "BUILTIN"
	BREAK_OBJ        ObjectType = "BREAK"
	CONTINUE_OBJ     ObjectType = "CONTINUE"
)

type Object interface {
	Type() ObjectType
	Inspect() string
}

type Integer struct {
	Value int64
}

func (i *Integer) Type() ObjectType { return INTEGER_OBJ }
func (i *Integer) Inspect() string  { return fmt.Sprintf("%d", i.Value) }

type Float struct {
	Value float64
}

func (f *Float) Type() ObjectType { return FLOAT_OBJ }
func (f *Float) Inspect() string {
	return fmt.Sprintf("%g", f.Value)
}

type String struct {
	Value string
}

func (s *String) Type() ObjectType { return STRING_OBJ }
func (s *String) Inspect() string  { return s.Value }

type Boolean struct {
	Value bool
}

func (b *Boolean) Type() ObjectType { return BOOLEAN_OBJ }
func (b *Boolean) Inspect() string {
	if b.Value {
		return "真"
	}
	return "假"
}

type Null struct{}

func (n *Null) Type() ObjectType { return NULL_OBJ }
func (n *Null) Inspect() string  { return "空" }

type Error struct {
	Message string
}

func (e *Error) Type() ObjectType { return ERROR_OBJ }
func (e *Error) Inspect() string  { return e.Message }

type ReturnValue struct {
	Value Object
}

func (rv *ReturnValue) Type() ObjectType { return RETURN_VALUE_OBJ }
func (rv *ReturnValue) Inspect() string  { return rv.Value.Inspect() }

type Function struct {
	Parameters []*ast.Identifier
	Body       []ast.Statement
	Env        map[string]Object
}

func (f *Function) Type() ObjectType { return FUNCTION_OBJ }
func (f *Function) Inspect() string {
	params := []string{}
	for _, p := range f.Parameters {
		params = append(params, p.Value)
	}
	return fmt.Sprintf("函数(%s) { ... }", strings.Join(params, ", "))
}

type Array struct {
	Elements []Object
}

func (a *Array) Type() ObjectType { return ARRAY_OBJ }
func (a *Array) Inspect() string {
	var out strings.Builder
	elements := []string{}
	for _, e := range a.Elements {
		elements = append(elements, e.Inspect())
	}
	out.WriteString("[")
	out.WriteString(strings.Join(elements, ", "))
	out.WriteString("]")
	return out.String()
}

type BuiltinFunction func(args ...Object) Object

type Builtin struct {
	Fn BuiltinFunction
}

func (b *Builtin) Type() ObjectType { return BUILTIN_OBJ }
func (b *Builtin) Inspect() string  { return "内置函数" }

type Dict struct {
	Pairs map[string]Object // 简化版，键仅支持字符串/标识符
}

func (d *Dict) Type() ObjectType { return DICT_OBJ }
func (d *Dict) Inspect() string {
	var out strings.Builder
	pairs := []string{}
	for k, v := range d.Pairs {
		pairs = append(pairs, fmt.Sprintf("%s: %s", k, v.Inspect()))
	}
	out.WriteString("{")
	out.WriteString(strings.Join(pairs, ", "))
	out.WriteString("}")
	return out.String()
}

type Result struct {
	IsSuccess bool
	Value     Object
	Error     Object
}

func (r *Result) Type() ObjectType { return RESULT_OBJ }
func (r *Result) Inspect() string {
	if r.IsSuccess {
		return fmt.Sprintf("成功(%s)", r.Value.Inspect())
	}
	return fmt.Sprintf("失败(%s)", r.Error.Inspect())
}

type Task struct {
	Channel chan Object
	Value   Object
	IsDone  bool
}

func (t *Task) Type() ObjectType { return TASK_OBJ }
func (t *Task) Inspect() string {
	if t.IsDone {
		return fmt.Sprintf("任务(完成: %s)", t.Value.Inspect())
	}
	return "任务(进行中)"
}

type Break struct{}

func (b *Break) Type() ObjectType { return BREAK_OBJ }
func (b *Break) Inspect() string  { return "跳出" }

type Continue struct{}

func (c *Continue) Type() ObjectType { return CONTINUE_OBJ }
func (c *Continue) Inspect() string  { return "继续" }
