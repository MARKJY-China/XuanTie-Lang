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
	program         *ast.Program
	output          bytes.Buffer
	modules         map[string]string // 缓存已转译的模块路径和生成的函数名
	moduleCode      bytes.Buffer      // 存储所有模块生成的 Go 代码
	classes         map[string]*ast.TypeDefinitionStatement
	importStack     []string // 用于循环引用检测
	returnTypeStack []string // 用于函数返回类型校验
	errors          []string
}

func (c *GoCompiler) Errors() []string {
	return c.errors
}

func New(program *ast.Program) *GoCompiler {
	return &GoCompiler{
		program: program,
		modules: make(map[string]string),
		classes: make(map[string]*ast.TypeDefinitionStatement),
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
	c.output.WriteString("\t\"encoding/json\"\n")
	c.output.WriteString("\t\"io\"\n")
	c.output.WriteString("\t\"os\"\n")
	c.output.WriteString("\t\"net\"\n")
	c.output.WriteString("\t\"net/http\"\n")
	c.output.WriteString("\t\"io/ioutil\"\n")
	c.output.WriteString("\t\"os/exec\"\n")
	c.output.WriteString("\t\"time\"\n")
	c.output.WriteString("\t\"bufio\"\n")
	c.output.WriteString("\t\"strings\"\n")
	c.output.WriteString("\t\"syscall\"\n")
	c.output.WriteString("\t\"unsafe\"\n")
	c.output.WriteString(")\n\n")
	c.output.WriteString("var _ = reflect.TypeOf\n")
	c.output.WriteString("var 空 interface{} = nil\n")
	c.output.WriteString("var interfaces = make(map[string][]string)\n")
	c.output.WriteString("var xtStack []string\n\n")

	// 辅助函数：将 XuanTie 的 interface{} 值转为字符串用于打印
	c.output.WriteString("// inspect 模拟玄铁 object.Inspect() 功能\n")
	c.output.WriteString("func inspect(v interface{}) string {\n")
	c.output.WriteString("\tif v == nil { return \"空\" }\n")
	c.output.WriteString("\tswitch val := v.(type) {\n")
	c.output.WriteString("\tcase []uint8:\n")
	c.output.WriteString("\t\tvar out strings.Builder\n")
	c.output.WriteString("\t\tout.WriteString(\"字节[\")\n")
	c.output.WriteString("\t\tfor i, b := range val {\n")
	c.output.WriteString("\t\t\tif i > 0 { out.WriteString(\" \") }\n")
	c.output.WriteString("\t\t\tout.WriteString(fmt.Sprintf(\"%02X\", b))\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\tout.WriteString(\"]\")\n")
	c.output.WriteString("\t\treturn out.String()\n")
	c.output.WriteString("\tcase bool:\n")
	c.output.WriteString("\t\tif val { return \"真\" }\n")
	c.output.WriteString("\t\treturn \"假\"\n")
	c.output.WriteString("\tcase string: return val\n")
	c.output.WriteString("\tcase *[]interface{}:\n")
	c.output.WriteString("\t\telems := make([]string, len(*val))\n")
	c.output.WriteString("\t\tfor i, e := range *val { elems[i] = inspect(e) }\n")
	c.output.WriteString("\t\treturn \"[\" + strings.Join(elems, \", \") + \"]\"\n")
	c.output.WriteString("\tcase []interface{}:\n")
	c.output.WriteString("\t\telems := make([]string, len(val))\n")
	c.output.WriteString("\t\tfor i, e := range val { elems[i] = inspect(e) }\n")
	c.output.WriteString("\t\treturn \"[\" + strings.Join(elems, \", \") + \"]\"\n")
	c.output.WriteString("\tcase int64, float64: return fmt.Sprintf(\"%v\", val)\n")
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

	c.output.WriteString("func checkTypeRuntime(expectedType string, v interface{}, label string) {\n")
	c.output.WriteString("\tif expectedType == \"\" { return }\n")
	c.output.WriteString("\tif !checkTypeRuntimeNoPanic(expectedType, v) {\n")
	c.output.WriteString("\t\tpanic(fmt.Sprintf(\"%s类型错误: 期望 %s, 实际得到 %T\", label, expectedType, v))\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func checkTypeRuntimeNoPanic(expectedType string, v interface{}) bool {\n")
	c.output.WriteString("\tif expectedType == \"\" { return true }\n")
	c.output.WriteString("\tif strings.Contains(expectedType, \" | \") {\n")
	c.output.WriteString("\t\ttypes := strings.Split(expectedType, \" | \")\n")
	c.output.WriteString("\t\tfor _, t := range types {\n")
	c.output.WriteString("\t\t\tif checkTypeRuntimeNoPanic(strings.TrimSpace(t), v) { return true }\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\treturn false\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif strings.HasSuffix(expectedType, \"?\") {\n")
	c.output.WriteString("\t\tif v == nil { return true }\n")
	c.output.WriteString("\t\treturn checkTypeRuntimeNoPanic(expectedType[:len(expectedType)-1], v)\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif v == nil { return expectedType == \"空\" }\n")
	c.output.WriteString("\tswitch expectedType {\n")
	c.output.WriteString("\tcase \"字\", \"字符串\": _, ok := v.(string); return ok\n")
	c.output.WriteString("\tcase \"整\", \"整数\": _, ok := v.(int64); return ok\n")
	c.output.WriteString("\tcase \"小数\": _, ok := v.(float64); return ok\n")
	c.output.WriteString("\tcase \"逻\", \"逻辑\": _, ok := v.(bool); return ok\n")
	c.output.WriteString("\tcase \"数组\":\n")
	c.output.WriteString("\t\tif _, ok := v.(*[]interface{}); ok { return true }\n")
	c.output.WriteString("\t\tif _, ok := v.([]interface{}); ok { return true }\n")
	c.output.WriteString("\t\treturn false\n")
	c.output.WriteString("\tcase \"字典\": _, ok := v.(map[string]interface{}); return ok\n")
	c.output.WriteString("\tcase \"字节\": _, ok := v.([]byte); return ok\n")
	c.output.WriteString("\tcase \"结果\": _, ok := v.(*Result); return ok\n")
	c.output.WriteString("\tdefault:\n")
	c.output.WriteString("\t\tif dict, ok := v.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\t\tif classes, ok := dict[\"__CLASSES__\"].([]string); ok {\n")
	c.output.WriteString("\t\t\t\tfor _, cls := range classes { if cls == expectedType { return true } }\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t\t// 检查是否满足接口契约\n")
	c.output.WriteString("\t\t\tif methods, ok := interfaces[expectedType]; ok {\n")
	c.output.WriteString("\t\t\t\tfor _, m := range methods {\n")
	c.output.WriteString("\t\t\t\t\tif _, ok := dict[m]; !ok { return false }\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\treturn true\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\treturn false\n")
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
	c.output.WriteString("\treturn inspect(l) + inspect(r)\n")
	c.output.WriteString("}\n\n")

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
	c.output.WriteString("}\n\n")

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
	c.output.WriteString("}\n\n")

	c.output.WriteString("func div(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok {\n")
	c.output.WriteString("\t\t\tif ri == 0 { panic(\"除数不能为零\") }\n")
	c.output.WriteString("\t\t\treturn li / ri\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok {\n")
	c.output.WriteString("\t\t\tif rf == 0 { panic(\"除数不能为零\") }\n")
	c.output.WriteString("\t\t\treturn float64(li) / rf\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif lf, ok := l.(float64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok {\n")
	c.output.WriteString("\t\t\tif ri == 0 { panic(\"除数不能为零\") }\n")
	c.output.WriteString("\t\t\treturn lf / float64(ri)\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\tif rf, ok := r.(float64); ok {\n")
	c.output.WriteString("\t\t\tif rf == 0 { panic(\"除数不能为零\") }\n")
	c.output.WriteString("\t\t\treturn lf / rf\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func mod(l, r interface{}) interface{} {\n")
	c.output.WriteString("\tif li, ok := l.(int64); ok {\n")
	c.output.WriteString("\t\tif ri, ok := r.(int64); ok && ri != 0 { return li % ri }\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn 0\n")
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
	c.output.WriteString("\tif s, ok := v.(*[]interface{}); ok { return *s }\n")
	c.output.WriteString("\tif s, ok := v.([]interface{}); ok { return s }\n")
	c.output.WriteString("\treturn []interface{}{}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func listen(addr interface{}, callback interface{}, paramCount int) interface{} {\n")
	c.output.WriteString("\taddrStr := fmt.Sprintf(\"%v\", addr)\n")
	c.output.WriteString("\tif !strings.Contains(addrStr, \":\") { addrStr = \":\" + addrStr }\n")
	c.output.WriteString("\tif paramCount == 2 {\n")
	c.output.WriteString("\t\tgo http.ListenAndServe(addrStr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {\n")
	c.output.WriteString("\t\t\treq := map[string]interface{}{\n")
	c.output.WriteString("\t\t\t\t\"方法\": r.Method,\n")
	c.output.WriteString("\t\t\t\t\"路径\": r.URL.Path,\n")
	c.output.WriteString("\t\t\t\t\"头\": func() map[string]interface{} {\n")
	c.output.WriteString("\t\t\t\t\th := make(map[string]interface{})\n")
	c.output.WriteString("\t\t\t\t\tfor k, v := range r.Header { h[k] = strings.Join(v, \",\") }\n")
	c.output.WriteString("\t\t\t\t\treturn h\n")
	c.output.WriteString("\t\t\t\t}(),\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t\tbody, _ := ioutil.ReadAll(r.Body)\n")
	c.output.WriteString("\t\t\treq[\"主体\"] = string(body)\n")
	c.output.WriteString("\t\t\tcall(callback, []interface{}{req, w})\n")
	c.output.WriteString("\t\t}))\n")
	c.output.WriteString("\t} else {\n")
	c.output.WriteString("\t\tl, err := net.Listen(\"tcp\", addrStr)\n")
	c.output.WriteString("\t\tif err != nil { return nil }\n")
	c.output.WriteString("\t\tgo func() {\n")
	c.output.WriteString("\t\t\tdefer l.Close()\n")
	c.output.WriteString("\t\t\tfor {\n")
	c.output.WriteString("\t\t\t\tconn, err := l.Accept()\n")
	c.output.WriteString("\t\t\t\tif err != nil { continue }\n")
	c.output.WriteString("\t\t\t\tcall(callback, []interface{}{conn})\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t}()\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func connect(addr interface{}, timeout interface{}) interface{} {\n")
	c.output.WriteString("\tt := 5 * time.Second\n")
	c.output.WriteString("\tif ti, ok := timeout.(int64); ok { t = time.Duration(ti) * time.Millisecond }\n")
	c.output.WriteString("\tconn, err := net.DialTimeout(\"tcp\", fmt.Sprintf(\"%v\", addr), t)\n")
	c.output.WriteString("\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\treturn &Result{IsSuccess: true, Value: conn}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func request(url interface{}, options interface{}) interface{} {\n")
	c.output.WriteString("\tmethod := \"GET\"\n")
	c.output.WriteString("\tvar body io.Reader\n")
	c.output.WriteString("\theaders := make(map[string]string)\n")
	c.output.WriteString("\tif opt, ok := options.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\tif m, ok := opt[\"方法\"].(string); ok { method = m }\n")
	c.output.WriteString("\t\tif b, ok := opt[\"主体\"].(string); ok { body = strings.NewReader(b) }\n")
	c.output.WriteString("\t\tif h, ok := opt[\"头\"].(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\t\tfor k, v := range h { headers[k] = fmt.Sprintf(\"%v\", v) }\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treq, err := http.NewRequest(method, fmt.Sprintf(\"%v\", url), body)\n")
	c.output.WriteString("\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\tfor k, v := range headers { req.Header.Set(k, v) }\n")
	c.output.WriteString("\tclient := &http.Client{}\n")
	c.output.WriteString("\tresp, err := client.Do(req)\n")
	c.output.WriteString("\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\tdefer resp.Body.Close()\n")
	c.output.WriteString("\trespBody, err := ioutil.ReadAll(resp.Body)\n")
	c.output.WriteString("\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\treturn &Result{IsSuccess: true, Value: string(respBody)}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("var 时 = map[string]interface{}{\n")
	c.output.WriteString("\t\"睡\": func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\tif len(args) > 0 { if ms, ok := args[0].(int64); ok { time.Sleep(time.Duration(ms) * time.Millisecond) } }\n")
	c.output.WriteString("\t\treturn nil\n")
	c.output.WriteString("\t},\n")
	c.output.WriteString("\t\"现\": func(args []interface{}) interface{} { return time.Now().UnixNano() / 1e6 },\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("var 外 = map[string]interface{}{\n")
	c.output.WriteString("\t\"加载\": func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\tif len(args) < 1 { return &Result{IsSuccess: false, Error: \"加载期望 1 个参数\"} }\n")
	c.output.WriteString("\t\tlibPath := fmt.Sprintf(\"%v\", args[0])\n")
	c.output.WriteString("\t\tdll, err := syscall.LoadDLL(libPath)\n")
	c.output.WriteString("\t\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\t\treturn &Result{IsSuccess: true, Value: map[string]interface{}{\n")
	c.output.WriteString("\t\t\t\"__HANDLE__\": \"DLL\",\n")
	c.output.WriteString("\t\t\t\"__PTR__\":    int64(uintptr(dll.Handle)),\n")
	c.output.WriteString("\t\t\t\"__PATH__\":   libPath,\n")
	c.output.WriteString("\t\t}}\n")
	c.output.WriteString("\t},\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("var 字节 = map[string]interface{}{\n")
	c.output.WriteString("\t\"从字\": func(args []interface{}) interface{} { if len(args) > 0 { return []byte(fmt.Sprintf(\"%v\", args[0])) }; return nil },\n")
	c.output.WriteString("\t\"到字\": func(args []interface{}) interface{} { if len(args) > 0 { if b, ok := args[0].([]byte); ok { return string(b) } }; return \"\" },\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("var 系统 = map[string]interface{}{\n")
	c.output.WriteString("\t\"参数\": func() []interface{} { res := make([]interface{}, len(os.Args)); for i, a := range os.Args { res[i] = a }; return res }(),\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func execute(cmd interface{}) interface{} {\n")
	c.output.WriteString("\tcmdStr := fmt.Sprintf(\"%v\", cmd)\n")
	c.output.WriteString("\tparts := strings.Fields(cmdStr)\n")
	c.output.WriteString("\tif len(parts) == 0 { return &Result{IsSuccess: false, Error: \"empty command\"} }\n")
	c.output.WriteString("\tc := exec.Command(parts[0], parts[1:]...)\n")
	c.output.WriteString("\tout, err := c.CombinedOutput()\n")
	c.output.WriteString("\tif err != nil { return &Result{IsSuccess: false, Error: string(out) + \" \" + err.Error()} }\n")
	c.output.WriteString("\treturn &Result{IsSuccess: true, Value: string(out)}\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func call(fn interface{}, args []interface{}) interface{} {\n")
	c.output.WriteString("\tif fn == nil { return nil }\n")
	c.output.WriteString("\tif f, ok := fn.(func([]interface{}) interface{}); ok { return f(args) }\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func index(left, idx interface{}) interface{} {\n")
	c.output.WriteString("\tif arrPtr, ok := left.(*[]interface{}); ok {\n")
	c.output.WriteString("\t\tarr := *arrPtr\n")
	c.output.WriteString("\t\tif i, ok := idx.(int64); ok && i >= 0 && i < int64(len(arr)) {\n")
	c.output.WriteString("\t\t\treturn arr[i]\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif arr, ok := left.([]interface{}); ok {\n")
	c.output.WriteString("\t\tif i, ok := idx.(int64); ok && i >= 0 && i < int64(len(arr)) {\n")
	c.output.WriteString("\t\t\treturn arr[i]\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\tif b, ok := left.([]byte); ok {\n")
	c.output.WriteString("\t\tif i, ok := idx.(int64); ok && i >= 0 && i < int64(len(b)) {\n")
	c.output.WriteString("\t\t\treturn int64(b[i])\n")
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
	c.output.WriteString("\t\tif s, ok := attr.(string); ok {\n")
	c.output.WriteString("\t\t\t// 处理 FFI DLL 调用\n")
	c.output.WriteString("\t\t\tif dict[\"__HANDLE__\"] == \"DLL\" {\n")
	c.output.WriteString("\t\t\t\tprocName := s\n")
	c.output.WriteString("\t\t\t\tptr := dict[\"__PTR__\"].(int64)\n")
	c.output.WriteString("\t\t\t\tpath := dict[\"__PATH__\"].(string)\n")
	c.output.WriteString("\t\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\t\tdll := &syscall.DLL{Name: path, Handle: syscall.Handle(ptr)}\n")
	c.output.WriteString("\t\t\t\t\tproc, err := dll.FindProc(procName)\n")
	c.output.WriteString("\t\t\t\t\tif err != nil { return &Result{IsSuccess: false, Error: err.Error()} }\n")
	c.output.WriteString("\t\t\t\t\tuArgs := make([]uintptr, len(args))\n")
	c.output.WriteString("\t\t\t\t\tfor i, a := range args {\n")
	c.output.WriteString("\t\t\t\t\t\tswitch v := a.(type) {\n")
	c.output.WriteString("\t\t\t\t\t\tcase int64: uArgs[i] = uintptr(v)\n")
	c.output.WriteString("\t\t\t\t\t\tcase string:\n")
	c.output.WriteString("\t\t\t\t\t\t\tif strings.HasSuffix(procName, \"W\") {\n")
	c.output.WriteString("\t\t\t\t\t\t\t\tp, _ := syscall.UTF16PtrFromString(v)\n")
	c.output.WriteString("\t\t\t\t\t\t\t\tuArgs[i] = uintptr(unsafe.Pointer(p))\n")
	c.output.WriteString("\t\t\t\t\t\t\t} else {\n")
	c.output.WriteString("\t\t\t\t\t\t\t\tp, _ := syscall.BytePtrFromString(v)\n")
	c.output.WriteString("\t\t\t\t\t\t\t\tuArgs[i] = uintptr(unsafe.Pointer(p))\n")
	c.output.WriteString("\t\t\t\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\t\t\tdefault: uArgs[i] = 0\n")
	c.output.WriteString("\t\t\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\t\tr1, _, _ := proc.Call(uArgs...)\n")
	c.output.WriteString("\t\t\t\t\treturn int64(r1)\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t\tif visMap, ok := dict[\"__VIS__\"].(map[string]string); ok {\n")
	c.output.WriteString("\t\t\t\tif vis, ok := visMap[s]; ok && vis != \"公\" {\n")
	c.output.WriteString("\t\t\t\t\tpanic(fmt.Sprintf(\"禁止访问%s属性: %s\", vis, s))\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t\treturn dict[s]\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif str, ok := obj.(string); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"长度\": return int64(len(str))\n")
	c.output.WriteString("\t\tcase \"包含\": return func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\tif len(args) > 0 { return strings.Contains(str, fmt.Sprintf(\"%v\", args[0])) }\n")
	c.output.WriteString("\t\t\treturn false\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif b, ok := obj.([]byte); ok {\n")
	c.output.WriteString("\t\tif attr == \"长度\" { return int64(len(b)) }\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif arrPtr, ok := obj.(*[]interface{}); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"长度\": return int64(len(*arrPtr))\n")
	c.output.WriteString("\t\tcase \"追加\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} { *arrPtr = append(*arrPtr, args...); return arrPtr }\n")
	c.output.WriteString("\t\tcase \"截取\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\ts, e := int64(0), int64(len(*arrPtr))\n")
	c.output.WriteString("\t\t\t\tif len(args) > 0 { if v, ok := args[0].(int64); ok { s = v } }\n")
	c.output.WriteString("\t\t\t\tif len(args) > 1 { if v, ok := args[1].(int64); ok { e = v } }\n")
	c.output.WriteString("\t\t\t\tif s < 0 { s = 0 }; if e > int64(len(*arrPtr)) { e = int64(len(*arrPtr)) }\n")
	c.output.WriteString("\t\t\t\tif s > e { return &[]interface{}{} }\n")
	c.output.WriteString("\t\t\t\tres := append([]interface{}{}, (*arrPtr)[s:e]...)\n")
	c.output.WriteString("\t\t\t\treturn &res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"删\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return arrPtr }\n")
	c.output.WriteString("\t\t\t\tidx, ok := args[0].(int64)\n")
	c.output.WriteString("\t\t\t\tif !ok || idx < 0 || idx >= int64(len(*arrPtr)) { return arrPtr }\n")
	c.output.WriteString("\t\t\t\t*arrPtr = append((*arrPtr)[:idx], (*arrPtr)[idx+1:]...)\n")
	c.output.WriteString("\t\t\t\treturn arrPtr\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"插\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) < 2 { return arrPtr }\n")
	c.output.WriteString("\t\t\t\tidx, ok := args[0].(int64)\n")
	c.output.WriteString("\t\t\t\tif !ok || idx < 0 || idx > int64(len(*arrPtr)) { return arrPtr }\n")
	c.output.WriteString("\t\t\t\tval := args[1]\n")
	c.output.WriteString("\t\t\t\t*arrPtr = append((*arrPtr)[:idx], append([]interface{}{val}, (*arrPtr)[idx:]...)...)\n")
	c.output.WriteString("\t\t\t\treturn arrPtr\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"找\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return int64(-1) }\n")
	c.output.WriteString("\t\t\t\tfor i, v := range *arrPtr { if reflect.DeepEqual(v, args[0]) { return int64(i) } }\n")
	c.output.WriteString("\t\t\t\treturn int64(-1)\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"映射\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return arrPtr }\n")
	c.output.WriteString("\t\t\t\tres := make([]interface{}, len(*arrPtr))\n")
	c.output.WriteString("\t\t\t\tfor i, v := range *arrPtr { res[i] = call(args[0], []interface{}{v, int64(i)}) }\n")
	c.output.WriteString("\t\t\t\treturn &res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"过滤\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return arrPtr }\n")
	c.output.WriteString("\t\t\t\tres := []interface{}{}\n")
	c.output.WriteString("\t\t\t\tfor i, v := range *arrPtr { if isTruthy(call(args[0], []interface{}{v, int64(i)})) { res = append(res, v) } }\n")
	c.output.WriteString("\t\t\t\treturn &res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif arr, ok := obj.([]interface{}); ok {\n")
	c.output.WriteString("\t\tif attr == \"长度\" { return int64(len(arr)) }\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif conn, ok := obj.(net.Conn); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"读\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tvar size int64 = 0\n")
	c.output.WriteString("\t\t\t\tif len(args) > 0 { if s, ok := args[0].(int64); ok { size = s } }\n")
	c.output.WriteString("\t\t\t\tif size > 0 {\n")
	c.output.WriteString("\t\t\t\t\tbuf := make([]byte, size)\n")
	c.output.WriteString("\t\t\t\t\tn, err := conn.Read(buf)\n")
	c.output.WriteString("\t\t\t\t\tif err != nil { return nil }\n")
	c.output.WriteString("\t\t\t\t\treturn string(buf[:n])\n")
	c.output.WriteString("\t\t\t\t} else if size == -1 {\n")
	c.output.WriteString("\t\t\t\t\tc, _ := ioutil.ReadAll(conn)\n")
	c.output.WriteString("\t\t\t\t\treturn string(c)\n")
	c.output.WriteString("\t\t\t\t} else {\n")
	c.output.WriteString("\t\t\t\t\tr := bufio.NewReader(conn)\n")
	c.output.WriteString("\t\t\t\t\tl, _ := r.ReadString('\\n')\n")
	c.output.WriteString("\t\t\t\t\treturn strings.TrimSpace(l)\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"写\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return false }\n")
	c.output.WriteString("\t\t\t\t_, err := conn.Write([]byte(fmt.Sprintf(\"%v\\n\", args[0])))\n")
	c.output.WriteString("\t\t\t\treturn err == nil\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"关\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} { conn.Close(); return nil }\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif w, ok := obj.(http.ResponseWriter); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"写\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) == 0 { return nil }\n")
	c.output.WriteString("\t\t\t\tw.Write([]byte(fmt.Sprintf(\"%v\", args[0])))\n")
	c.output.WriteString("\t\t\t\treturn nil\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"头\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) < 2 { return nil }\n")
	c.output.WriteString("\t\t\t\tw.Header().Set(fmt.Sprintf(\"%v\", args[0]), fmt.Sprintf(\"%v\", args[1]))\n")
	c.output.WriteString("\t\t\t\treturn nil\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"码\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif len(args) > 0 { if code, ok := args[0].(int64); ok { w.WriteHeader(int(code)) } }\n")
	c.output.WriteString("\t\t\t\treturn nil\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif ch, ok := obj.(chan interface{}); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"送\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} { if len(args) > 0 { ch <- args[0] }; return nil }\n")
	c.output.WriteString("\t\tcase \"收\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} { return <-ch }\n")
	c.output.WriteString("\t\tcase \"关\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} { close(ch); return nil }\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")

	c.output.WriteString("\tif res, ok := obj.(*Result); ok {\n")
	c.output.WriteString("\t\tswitch attr {\n")
	c.output.WriteString("\t\tcase \"接着\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif res.IsSuccess && len(args) > 0 {\n")
	c.output.WriteString("\t\t\t\t\tr := call(args[0], []interface{}{res.Value})\n")
	c.output.WriteString("\t\t\t\t\tif rv, ok := r.(*Result); ok { return rv }\n")
	c.output.WriteString("\t\t\t\t\treturn &Result{IsSuccess: true, Value: r}\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t\treturn res\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\tcase \"否则\":\n")
	c.output.WriteString("\t\t\treturn func(args []interface{}) interface{} {\n")
	c.output.WriteString("\t\t\t\tif !res.IsSuccess && len(args) > 0 {\n")
	c.output.WriteString("\t\t\t\t\tr := call(args[0], []interface{}{res.Error})\n")
	c.output.WriteString("\t\t\t\t\tif rv, ok := r.(*Result); ok { return rv }\n")
	c.output.WriteString("\t\t\t\t\treturn &Result{IsSuccess: true, Value: r}\n")
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

	c.output.WriteString("func serialize(v interface{}) string {\n")
	c.output.WriteString("\tb, _ := json.Marshal(v)\n")
	c.output.WriteString("\treturn string(b)\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func deserialize(s interface{}) interface{} {\n")
	c.output.WriteString("\tstr, ok := s.(string)\n")
	c.output.WriteString("\tif !ok { return nil }\n")
	c.output.WriteString("\tvar res interface{}\n")
	c.output.WriteString("\tjson.Unmarshal([]byte(str), &res)\n")
	c.output.WriteString("\treturn res\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func merge(base map[string]interface{}, override interface{}) map[string]interface{} {\n")
	c.output.WriteString("\tif o, ok := override.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\tfor k, v := range o {\n")
	c.output.WriteString("\t\t\tbase[k] = v\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn base\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func setAttr(obj, attr, val interface{}) interface{} {\n")
	c.output.WriteString("\tif dict, ok := obj.(map[string]interface{}); ok {\n")
	c.output.WriteString("\t\tif s, ok := attr.(string); ok {\n")
	c.output.WriteString("\t\t\tif visMap, ok := dict[\"__VIS__\"].(map[string]string); ok {\n")
	c.output.WriteString("\t\t\t\tif vis, ok := visMap[s]; ok && vis != \"公\" {\n")
	c.output.WriteString("\t\t\t\t\tpanic(fmt.Sprintf(\"禁止修改%s属性: %s\", vis, s))\n")
	c.output.WriteString("\t\t\t\t}\n")
	c.output.WriteString("\t\t\t}\n")
	c.output.WriteString("\t\t\tdict[s] = val\n")
	c.output.WriteString("\t\t\treturn val\n")
	c.output.WriteString("\t\t}\n")
	c.output.WriteString("\t}\n")
	c.output.WriteString("\treturn nil\n")
	c.output.WriteString("}\n\n")

	c.output.WriteString("func main() {\n")
}

func (c *GoCompiler) writeFooter() {
	c.output.WriteString("}\n")
}

func (c *GoCompiler) writeBody() {
	c.writeStatementsWithDeclarations(c.program.Statements, 1)
}

func (c *GoCompiler) writeStatementsWithDeclarations(stmts []ast.Statement, indent int) {
	indentStr := strings.Repeat("\t", indent)
	// 收集块内声明以支持前向引用和局部变量
	for _, stmt := range stmts {
		if vs, ok := stmt.(*ast.VarStatement); ok {
			c.output.WriteString(fmt.Sprintf("%svar %s interface{}\n", indentStr, vs.Name.Value))
			c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, vs.Name.Value))
		}
		if fs, ok := stmt.(*ast.FunctionStatement); ok {
			c.output.WriteString(fmt.Sprintf("%svar %s interface{}\n", indentStr, fs.Name.Value))
			c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, fs.Name.Value))
		}
	}

	for _, stmt := range stmts {
		c.writeStatement(stmt, indent)
	}
}

func (c *GoCompiler) writeStatement(stmt ast.Statement, indent int) {
	indentStr := strings.Repeat("\t", indent)
	switch s := stmt.(type) {
	case *ast.VarStatement:
		c.output.WriteString(fmt.Sprintf("%s%s = %s\n", indentStr, s.Name.Value, c.expressionCode(s.Value, true)))
		if s.DataType != "" {
			c.output.WriteString(fmt.Sprintf("%scheckTypeRuntime(%q, %s, %q)\n", indentStr, s.DataType, s.Name.Value, "变量 "+s.Name.Value))
		}
	case *ast.AssignStatement:
		c.output.WriteString(fmt.Sprintf("%s%s = %s\n", indentStr, s.Name, c.expressionCode(s.Value, true)))
	case *ast.MemberAssignStatement:
		c.output.WriteString(fmt.Sprintf("%ssetAttr(%s, %q, %s)\n", indentStr, c.expressionCode(s.Object, true), s.Member.Value, c.expressionCode(s.Value, true)))
	case *ast.PrintStatement:
		c.output.WriteString(fmt.Sprintf("%sfmt.Println(inspect(%s))\n", indentStr, c.expressionCode(s.Value, false)))
	case *ast.IfStatement:
		c.output.WriteString(fmt.Sprintf("%sif isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition, false)))
		c.writeStatementsWithDeclarations(s.ThenBlock, indent+1)
		for _, eif := range s.ElseIfs {
			c.output.WriteString(fmt.Sprintf("%s} else if isTruthy(%s) {\n", indentStr, c.expressionCode(eif.Condition, false)))
			c.writeStatementsWithDeclarations(eif.Block, indent+1)
		}
		if len(s.ElseBlock) > 0 {
			c.output.WriteString(fmt.Sprintf("%s} else {\n", indentStr))
			c.writeStatementsWithDeclarations(s.ElseBlock, indent+1)
		}
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.WhileStatement:
		c.output.WriteString(fmt.Sprintf("%sfor isTruthy(%s) {\n", indentStr, c.expressionCode(s.Condition, false)))
		c.writeStatementsWithDeclarations(s.Block, indent+1)
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.LoopStatement:
		c.output.WriteString(fmt.Sprintf("%sfor {\n", indentStr))
		c.writeStatementsWithDeclarations(s.Block, indent+1)
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.ForStatement:
		// 基础遍历实现
		c.output.WriteString(fmt.Sprintf("%sfor _, _val := range toSlice(%s) {\n", indentStr, c.expressionCode(s.Iterable, false)))
		c.output.WriteString(fmt.Sprintf("%s\tvar %s interface{} = _val\n", indentStr, s.Variable.Value))
		c.writeStatementsWithDeclarations(s.Block, indent+1)
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
	case *ast.BreakStatement:
		c.output.WriteString(fmt.Sprintf("%sbreak\n", indentStr))
	case *ast.ContinueStatement:
		c.output.WriteString(fmt.Sprintf("%scontinue\n", indentStr))
	case *ast.TryCatchStatement:
		c.output.WriteString(fmt.Sprintf("%sfunc() {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\tdefer func() {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\tif r := recover(); r != nil {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\t\tmsg := fmt.Sprintf(\"%%v\", r)\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\t\tif len(xtStack) > 0 {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\t\t\tmsg += \"\\n堆栈追踪:\"\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\t\t\tfor i := len(xtStack) - 1; i >= 0; i-- { msg += \"\\n  于 \" + xtStack[i] }\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\t\t}\n", indentStr))
		if s.CatchVar != nil {
			c.output.WriteString(fmt.Sprintf("%s\t\t\tvar %s interface{} = msg\n", indentStr, s.CatchVar.Value))
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
	case *ast.FunctionStatement:
		c.output.WriteString(fmt.Sprintf("%s%s = func(args []interface{}) interface{} {\n", indentStr, s.Name.Value))
		c.output.WriteString(fmt.Sprintf("%s\txtStack = append(xtStack, %q + \" [行:%d]\")\n", indentStr, s.Name.Value, s.GetLine()))
		c.output.WriteString(fmt.Sprintf("%s\t_res := func() interface{} {\n", indentStr))
		// 绑定参数
		for i, p := range s.Parameters {
			c.output.WriteString(fmt.Sprintf("%s\t\tvar %s interface{}\n", indentStr, p.Name.Value))
			c.output.WriteString(fmt.Sprintf("%s\t\tif len(args) > %d { %s = args[%d] }\n", indentStr, i, p.Name.Value, i))
			// 类型校验
			if p.DataType != "" {
				c.output.WriteString(fmt.Sprintf("%s\t\tcheckTypeRuntime(%q, %s, %q)\n", indentStr, p.DataType, p.Name.Value, "参数 "+p.Name.Value))
			}
		}

		c.returnTypeStack = append(c.returnTypeStack, s.ReturnType)
		c.writeStatementsWithDeclarations(s.Body, indent+2)
		c.returnTypeStack = c.returnTypeStack[:len(c.returnTypeStack)-1]

		if s.ReturnType != "" {
			c.output.WriteString(fmt.Sprintf("%s\t\tcheckTypeRuntime(%q, nil, \"返回值\")\n", indentStr, s.ReturnType))
		}
		c.output.WriteString(fmt.Sprintf("%s\t\treturn nil\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t}()\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\txtStack = xtStack[:len(xtStack)-1]\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\treturn _res\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, s.Name.Value))
	case *ast.TypeDefinitionStatement:
		c.classes[s.Name.Value] = s
		c.output.WriteString(fmt.Sprintf("%svar %s = func(args []interface{}) map[string]interface{} {\n", indentStr, s.Name.Value))
		if s.Parent != nil {
			// 如果有父类，先调用父类构造逻辑
			c.output.WriteString(fmt.Sprintf("%s\tres := %s([]interface{}{})\n", indentStr, s.Parent.Value))
		} else {
			c.output.WriteString(fmt.Sprintf("%s\tres := make(map[string]interface{})\n", indentStr))
			c.output.WriteString(fmt.Sprintf("%s\tres[\"__VIS__\"] = make(map[string]string)\n", indentStr))
			c.output.WriteString(fmt.Sprintf("%s\tres[\"__CLASSES__\"] = []string{}\n", indentStr))
		}
		c.output.WriteString(fmt.Sprintf("%s\tres[\"__CLASS__\"] = %q\n", indentStr, s.Name.Value))
		c.output.WriteString(fmt.Sprintf("%s\tres[\"__CLASSES__\"] = append(res[\"__CLASSES__\"].([]string), %q)\n", indentStr, s.Name.Value))

		// 记录可见性
		for _, stmt := range s.Block {
			if varStmt, ok := stmt.(*ast.VarStatement); ok {
				vis := "公"
				if varStmt.Visibility != "" {
					vis = string(varStmt.Visibility)
				}
				c.output.WriteString(fmt.Sprintf("%s\tres[\"__VIS__\"].(map[string]string)[%q] = %q\n", indentStr, varStmt.Name.Value, vis))
				c.output.WriteString(fmt.Sprintf("%s\tres[%q] = %s\n", indentStr, varStmt.Name.Value, c.expressionCode(varStmt.Value, false)))
			}
			if fnStmt, ok := stmt.(*ast.FunctionStatement); ok {
				vis := "公"
				if fnStmt.Visibility != "" {
					vis = string(fnStmt.Visibility)
				}
				c.output.WriteString(fmt.Sprintf("%s\tres[\"__VIS__\"].(map[string]string)[%q] = %q\n", indentStr, fnStmt.Name.Value, vis))
			}
		}
		// 2. 初始化方法 (注入 res 自身模拟 __SELF__)
		for _, stmt := range s.Block {
			if fnStmt, ok := stmt.(*ast.FunctionStatement); ok {
				c.output.WriteString(fmt.Sprintf("%s\tres[%q] = func(m_args []interface{}) interface{} {\n", indentStr, fnStmt.Name.Value))
				// 注入属性和方法到作用域（包括继承来的）
				c.output.WriteString(fmt.Sprintf("%s\t\tfor _k, _v := range res {\n", indentStr))
				c.output.WriteString(fmt.Sprintf("%s\t\t\t_ = _k; _ = _v\n", indentStr))
				c.output.WriteString(fmt.Sprintf("%s\t\t}\n", indentStr))

				var injectHierarchy func(cls *ast.TypeDefinitionStatement)
				injectHierarchy = func(cls *ast.TypeDefinitionStatement) {
					if cls.Parent != nil {
						if parentCls, ok := c.classes[cls.Parent.Value]; ok {
							injectHierarchy(parentCls)
						}
					}
					for _, m := range cls.Block {
						if vs, ok := m.(*ast.VarStatement); ok {
							// 只有本类私有或祖先非私有才注入（简化版全注入）
							c.output.WriteString(fmt.Sprintf("%s\t\t%s := res[%q]\n", indentStr, vs.Name.Value, vs.Name.Value))
							c.output.WriteString(fmt.Sprintf("%s\t\t_ = %s\n", indentStr, vs.Name.Value))
						}
						if fs, ok := m.(*ast.FunctionStatement); ok {
							c.output.WriteString(fmt.Sprintf("%s\t\t%s := res[%q]\n", indentStr, fs.Name.Value, fs.Name.Value))
							c.output.WriteString(fmt.Sprintf("%s\t\t_ = %s\n", indentStr, fs.Name.Value))
						}
					}
				}

				injectHierarchy(s)

				// 绑定参数
				for i, p := range fnStmt.Parameters {
					c.output.WriteString(fmt.Sprintf("%s\t\t%s := interface{}(nil)\n", indentStr, p.Name.Value))
					c.output.WriteString(fmt.Sprintf("%s\t\tif len(m_args) > %d { %s = m_args[%d] }\n", indentStr, i, p.Name.Value, i))
					if p.DataType != "" {
						c.output.WriteString(fmt.Sprintf("%s\t\tcheckTypeRuntime(%q, %s, %q)\n", indentStr, p.DataType, p.Name.Value, "参数 "+p.Name.Value))
					}
				}
				for _, b := range fnStmt.Body {
					c.writeStatement(b, indent+2)
				}
				// 同步属性回 res
				// 同样需要同步整个继承链的属性
				var syncHierarchy func(cls *ast.TypeDefinitionStatement)
				syncHierarchy = func(cls *ast.TypeDefinitionStatement) {
					if cls.Parent != nil {
						if parentCls, ok := c.classes[cls.Parent.Value]; ok {
							syncHierarchy(parentCls)
						}
					}
					for _, m := range cls.Block {
						if vs, ok := m.(*ast.VarStatement); ok {
							c.output.WriteString(fmt.Sprintf("%s\t\tres[%q] = %s\n", indentStr, vs.Name.Value, vs.Name.Value))
						}
					}
				}
				syncHierarchy(s)

				c.output.WriteString(fmt.Sprintf("%s\t\treturn nil\n", indentStr))
				c.output.WriteString(fmt.Sprintf("%s\t}\n", indentStr))
			}
		}
		// 3. 执行构造函数 "造"
		c.output.WriteString(fmt.Sprintf("%s\tif constructor, ok := res[\"造\"].(func([]interface{}) interface{}); ok {\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t\tconstructor(args)\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s\t}\n", indentStr))

		c.output.WriteString(fmt.Sprintf("%sreturn res\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s}\n", indentStr))
		c.output.WriteString(fmt.Sprintf("%s_ = %s\n", indentStr, s.Name.Value))
	case *ast.InterfaceStatement:
		methods := []string{}
		for _, m := range s.Methods {
			methods = append(methods, fmt.Sprintf("%q", m.Name.Value))
		}
		c.output.WriteString(fmt.Sprintf("%sinterfaces[%q] = []string{%s}\n", indentStr, s.Name.Value, strings.Join(methods, ", ")))
	case *ast.ReturnStatement:
		expectedType := ""
		if len(c.returnTypeStack) > 0 {
			expectedType = c.returnTypeStack[len(c.returnTypeStack)-1]
		}
		valCode := c.expressionCode(s.ReturnValue, false)
		if expectedType != "" {
			c.output.WriteString(fmt.Sprintf("%s_rv := %s\n", indentStr, valCode))
			c.output.WriteString(fmt.Sprintf("%scheckTypeRuntime(%q, _rv, \"返回值\")\n", indentStr, expectedType))
			c.output.WriteString(fmt.Sprintf("%sreturn _rv\n", indentStr))
		} else {
			c.output.WriteString(fmt.Sprintf("%sreturn %s\n", indentStr, valCode))
		}
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
	case *ast.TypeLiteral:
		return fmt.Sprintf("%q", e.Value)
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
	case *ast.NewExpression:
		typeCode := c.expressionCode(e.Type, false)
		args := []string{}
		for _, a := range e.Arguments {
			args = append(args, c.expressionCode(a, false))
		}
		argsStr := fmt.Sprintf("[]interface{}{%s}", strings.Join(args, ", "))

		if e.Data != nil {
			return fmt.Sprintf("merge(%s(%s), %s)", typeCode, argsStr, c.expressionCode(e.Data, false))
		}
		return fmt.Sprintf("%s(%s)", typeCode, argsStr)
	case *ast.SerializeExpression:
		return fmt.Sprintf("serialize(%s)", c.expressionCode(e.Value, false))
	case *ast.DeserializeExpression:
		return fmt.Sprintf("deserialize(%s)", c.expressionCode(e.Value, false))
	case *ast.ListenExpression:
		return c.listenExpressionCode(e, isAssignment)
	case *ast.ConnectExpression:
		return c.connectExpressionCode(e, isAssignment)
	case *ast.ConnectRequestExpression:
		return c.requestExpressionCode(e, isAssignment)
	case *ast.ExecuteExpression:
		return c.executeExpressionCode(e, isAssignment)
	case *ast.ChannelExpression:
		return "make(chan interface{}, 100)"
	}
	return "nil"
}

func (c *GoCompiler) arrayLiteralCode(e *ast.ArrayLiteral, isAssignment bool) string {
	elements := []string{}
	for _, el := range e.Elements {
		elements = append(elements, c.expressionCode(el, isAssignment))
	}
	return fmt.Sprintf("(&[]interface{}{%s})", strings.Join(elements, ", "))
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
	if e.Arguments != nil {
		args := []string{}
		for _, a := range e.Arguments {
			args = append(args, c.expressionCode(a, isAssignment))
		}
		// 转译为 getAttr(obj, "member") 然后调用
		return fmt.Sprintf("call(getAttr(%s, %q), []interface{}{%s})", c.expressionCode(e.Object, isAssignment), e.Member.Value, strings.Join(args, ", "))
	}
	return fmt.Sprintf("getAttr(%s, %q)", c.expressionCode(e.Object, isAssignment), e.Member.Value)
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
			case *ast.PrintStatement, *ast.ExpressionStatement, *ast.IfStatement, *ast.WhileStatement, *ast.LoopStatement, *ast.ForStatement, *ast.TryCatchStatement, *ast.TypeDefinitionStatement, *ast.FunctionStatement:
				continue
			case *ast.ReturnStatement:
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
	out.WriteString(fmt.Sprintf("\t\txtStack = append(xtStack, \"匿名函数 [行:%d]\")\n", e.GetLine()))
	out.WriteString("\t\t_res := func() interface{} {\n")
	for i, p := range e.Parameters {
		out.WriteString(fmt.Sprintf("\t\t\t%s := args[%d]\n", p.Name.Value, i))
		out.WriteString(fmt.Sprintf("\t\t\t_ = %s\n", p.Name.Value))
		if p.DataType != "" {
			out.WriteString(fmt.Sprintf("\t\t\tcheckTypeRuntime(%q, %s, %q)\n", p.DataType, p.Name.Value, "参数 "+p.Name.Value))
		}
	}
	c.returnTypeStack = append(c.returnTypeStack, e.ReturnType)
	c.writeStatementsWithDeclarationsToBuffer(e.Body, 3, &out)
	c.returnTypeStack = c.returnTypeStack[:len(c.returnTypeStack)-1]
	if e.ReturnType != "" {
		out.WriteString(fmt.Sprintf("\t\t\tcheckTypeRuntime(%q, nil, \"返回值\")\n", e.ReturnType))
	}
	out.WriteString("\t\t\treturn nil\n")
	out.WriteString("\t\t}()\n")
	out.WriteString("\t\txtStack = xtStack[:len(xtStack)-1]\n")
	out.WriteString("\t\treturn _res\n")
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

func (c *GoCompiler) writeStatementsWithDeclarationsToBuffer(stmts []ast.Statement, indent int, buf *bytes.Buffer) {
	oldOutput := c.output
	c.output = *buf
	c.writeStatementsWithDeclarations(stmts, indent)
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

func (c *GoCompiler) listenExpressionCode(e *ast.ListenExpression, isAssignment bool) string {
	addr := c.expressionCode(e.Address, isAssignment)
	callback := c.expressionCode(e.Callback, isAssignment)

	// 尝试在编译时检测参数数量
	paramCount := 1
	if fl, ok := e.Callback.(*ast.FunctionLiteral); ok {
		paramCount = len(fl.Parameters)
	}

	return fmt.Sprintf("listen(%s, %s, %d)", addr, callback, paramCount)
}

func (c *GoCompiler) connectExpressionCode(e *ast.ConnectExpression, isAssignment bool) string {
	addr := c.expressionCode(e.Address, isAssignment)
	timeout := "5000"
	if len(e.Arguments) > 0 {
		timeout = c.expressionCode(e.Arguments[0], isAssignment)
	}
	return fmt.Sprintf("connect(%s, %s)", addr, timeout)
}

func (c *GoCompiler) requestExpressionCode(e *ast.ConnectRequestExpression, isAssignment bool) string {
	url := c.expressionCode(e.Url, isAssignment)
	options := "nil"
	if len(e.Arguments) > 0 {
		options = c.expressionCode(e.Arguments[0], isAssignment)
	}
	return fmt.Sprintf("request(%s, %s)", url, options)
}

func (c *GoCompiler) executeExpressionCode(e *ast.ExecuteExpression, isAssignment bool) string {
	cmd := c.expressionCode(e.Command, isAssignment)
	return fmt.Sprintf("execute(%s)", cmd)
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
	case "%":
		return fmt.Sprintf("mod(%s, %s)", left, right)
	case "等于", "==":
		return fmt.Sprintf("(reflect.DeepEqual(%s, %s))", left, right)
	case "是":
		// 如果右侧是字符串字面量（类型判断）
		if strings.HasPrefix(right, "\"") && strings.HasSuffix(right, "\"") {
			typeStr := strings.Trim(right, "\"")
			switch typeStr {
			case "整", "整数":
				return fmt.Sprintf("(reflect.TypeOf(%s).Kind() == reflect.Int64)", left)
			case "字", "字符串":
				return fmt.Sprintf("(reflect.TypeOf(%s).Kind() == reflect.String)", left)
			case "逻", "逻辑":
				return fmt.Sprintf("(reflect.TypeOf(%s).Kind() == reflect.Bool)", left)
			case "小数":
				return fmt.Sprintf("(reflect.TypeOf(%s).Kind() == reflect.Float64)", left)
			}
		}
		return fmt.Sprintf("(reflect.DeepEqual(%s, %s))", left, right)
	case "<":
		return fmt.Sprintf("lt(%s, %s)", left, right)
	case ">":
		return fmt.Sprintf("gt(%s, %s)", left, right)
	case "&": // 字符串拼接
		return fmt.Sprintf("add(%s, %s)", left, right)
	}
	return fmt.Sprintf("(%s %s %s)", left, e.Operator, right)
}

// TODO: 在 header 中添加运行时辅助函数 (isTruthy, toSlice, add, sub 等)
