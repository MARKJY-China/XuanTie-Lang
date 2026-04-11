package object

import (
	"fmt"
	"net"
	"net/http"
	"strings"
	"xuantie/ast"
	"xuantie/token"
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
	CLASS_OBJ        ObjectType = "CLASS"
	INSTANCE_OBJ     ObjectType = "INSTANCE"
	INTERFACE_OBJ    ObjectType = "INTERFACE"
	STREAM_OBJ       ObjectType = "STREAM"
	CHANNEL_OBJ      ObjectType = "CHANNEL"
	HTTP_RES_OBJ     ObjectType = "HTTP_RES"
	BYTES_OBJ        ObjectType = "BYTES"
	FFI_FUNCTION_OBJ ObjectType = "FFI_FUNCTION"
	INTERNAL_ENV_OBJ ObjectType = "INTERNAL_ENV"
)

type InternalEnv struct {
	Value map[string]Object
}

func (ie *InternalEnv) Type() ObjectType { return INTERNAL_ENV_OBJ }
func (ie *InternalEnv) Inspect() string  { return "<internal env>" }

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
	Trace   []string
}

func (e *Error) Type() ObjectType { return ERROR_OBJ }
func (e *Error) Inspect() string {
	var out strings.Builder
	out.WriteString(e.Message)
	if len(e.Trace) > 0 {
		out.WriteString("\n堆栈追踪:")
		for _, t := range e.Trace {
			out.WriteString("\n  于 " + t)
		}
	}
	return out.String()
}

type ReturnValue struct {
	Value Object
}

func (rv *ReturnValue) Type() ObjectType { return RETURN_VALUE_OBJ }
func (rv *ReturnValue) Inspect() string  { return rv.Value.Inspect() }

type Function struct {
	Parameters    []*ast.Parameter
	GenericParams []*ast.GenericParam // 泛型参数
	ReturnType    string              // 可选返回类型
	Body          []ast.Statement
	Env           map[string]Object
	OwnerClass    *Class    // 所属类（用于权限校验）
	Receiver      *Instance // 绑定的实例（如果是方法）
	DocComment    string    // 文档注释
}

func (f *Function) Type() ObjectType { return FUNCTION_OBJ }
func (f *Function) Inspect() string {
	var out strings.Builder
	if f.DocComment != "" {
		out.WriteString(f.DocComment + "\n")
	}
	params := []string{}
	for _, p := range f.Parameters {
		params = append(params, p.Name.Value)
	}
	out.WriteString("函数")
	if len(f.GenericParams) > 0 {
		out.WriteString("<")
		gps := []string{}
		for _, p := range f.GenericParams {
			gps = append(gps, p.String())
		}
		out.WriteString(strings.Join(gps, ", "))
		out.WriteString(">")
	}
	out.WriteString(fmt.Sprintf("(%s) { ... }", strings.Join(params, ", ")))
	return out.String()
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

type Stream struct {
	Conn net.Conn
}

func (s *Stream) Type() ObjectType { return STREAM_OBJ }
func (s *Stream) Inspect() string  { return fmt.Sprintf("流(%s)", s.Conn.RemoteAddr()) }

type Channel struct {
	Value chan Object
}

func (c *Channel) Type() ObjectType { return CHANNEL_OBJ }
func (c *Channel) Inspect() string  { return "道" }

type HttpResponseWriter struct {
	Writer http.ResponseWriter
}

func (h *HttpResponseWriter) Type() ObjectType { return HTTP_RES_OBJ }
func (h *HttpResponseWriter) Inspect() string  { return "答" }

type Bytes struct {
	Value []byte
}

func (b *Bytes) Type() ObjectType { return BYTES_OBJ }
func (b *Bytes) Inspect() string  { return fmt.Sprintf("字节(%d)", len(b.Value)) }

type FFIFunction struct {
	Name       string
	Path       string
	Handle     uintptr
	ParamTypes []string
	ReturnType string
}

func (f *FFIFunction) Type() ObjectType { return FFI_FUNCTION_OBJ }
func (f *FFIFunction) Inspect() string  { return fmt.Sprintf("外部函数 %s (%s)", f.Name, f.Path) }

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

func (r *Result) String() string {
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

type Class struct {
	Name          string
	GenericParams []*ast.GenericParam // 泛型参数
	Parent        *Class
	Fields        map[string]Object
	Methods       map[string]*Function
	Visibilities  map[string]token.TokenType
	Env           map[string]Object
}

func (c *Class) Type() ObjectType { return CLASS_OBJ }
func (c *Class) Inspect() string {
	var out strings.Builder
	out.WriteString("型 " + c.Name)
	if len(c.GenericParams) > 0 {
		out.WriteString("<")
		gps := []string{}
		for _, p := range c.GenericParams {
			gps = append(gps, p.String())
		}
		out.WriteString(strings.Join(gps, ", "))
		out.WriteString(">")
	}
	out.WriteString(" { ... }")
	return out.String()
}

type Interface struct {
	Name    string
	Methods map[string]*ast.MethodSignature
	Env     map[string]Object
}

func (i *Interface) Type() ObjectType { return INTERFACE_OBJ }
func (i *Interface) Inspect() string  { return fmt.Sprintf("口 %s { ... }", i.Name) }

type Instance struct {
	Class    *Class
	TypeArgs map[string]string // 泛型绑定，如 T -> 整
	Fields   map[string]Object
}

func (i *Instance) Type() ObjectType { return INSTANCE_OBJ }
func (i *Instance) Inspect() string {
	var out strings.Builder
	fields := []string{}
	for k, v := range i.Fields {
		suffix := ""
		if vis, ok := i.Class.Visibilities[k]; ok && vis == token.TOKEN_PRIVATE {
			suffix = "(私)"
		} else if vis, ok := i.Class.Visibilities[k]; ok && vis == token.TOKEN_PROTECTED {
			suffix = "(护)"
		}
		fields = append(fields, fmt.Sprintf("%s%s: %s", k, suffix, v.Inspect()))
	}
	out.WriteString("造 " + i.Class.Name + " {")
	out.WriteString(strings.Join(fields, ", "))
	out.WriteString("}")
	return out.String()
}
