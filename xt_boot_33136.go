package main

import (
	"fmt"
	"reflect"
	"encoding/json"
	"io"
	"os"
	"net"
	"net/http"
	"io/ioutil"
	"os/exec"
	"time"
	"bufio"
	"strings"
	"syscall"
	"unsafe"
)

var _ = reflect.TypeOf

// inspect 模拟玄铁 object.Inspect() 功能
func inspect(v interface{}) string {
	if v == nil { return "空" }
	fmt.Printf("DEBUG: type=%T\n", v)
	switch val := v.(type) {
	case []uint8:
		fmt.Println("!!! HIT BYTE CASE !!!")
		var out strings.Builder
		out.WriteString("字节[")
		for i, b := range val {
			if i > 0 { out.WriteString(" ") }
			out.WriteString(fmt.Sprintf("%02X", b))
		}
		out.WriteString("]")
		return out.String()
	case bool:
		if val { return "真" }
		return "假"
	case string: return val
	case []interface{}:
		elems := make([]string, len(val))
		for i, e := range val { elems[i] = inspect(e) }
		return "[" + strings.Join(elems, ", ") + "]"
	case int64, float64: return fmt.Sprintf("%v", val)
	default:
		return fmt.Sprintf("(%T)%v", val, val)
	}
}

func isTruthy(v interface{}) bool {
	if v == nil { return false }
	switch val := v.(type) {
	case bool: return val
	case int64: return val != 0
	case float64: return val != 0
	case string: return val != ""
	default: return true
	}
}

func add(l, r interface{}) interface{} {
	fmt.Printf("DEBUG ADD: l=%T, r=%T\n", l, r)
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok { return li + ri }
		if rf, ok := r.(float64); ok { return float64(li) + rf }
	}
	if lf, ok := l.(float64); ok {
		if ri, ok := r.(int64); ok { return lf + float64(ri) }
		if rf, ok := r.(float64); ok { return lf + rf }
	}
	return inspect(l) + inspect(r)
}

func lt(l, r interface{}) bool {
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok { return li < ri }
	}
	return false
}

func gt(l, r interface{}) bool {
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok { return li > ri }
	}
	return false
}

func toSlice(v interface{}) []interface{} {
	if s, ok := v.([]interface{}); ok { return s }
	return []interface{}{}
}

func listen(addr interface{}, callback interface{}, paramCount int) interface{} {
	addrStr := fmt.Sprintf("%v", addr)
	if !strings.Contains(addrStr, ":") { addrStr = ":" + addrStr }
	if paramCount == 2 {
		go http.ListenAndServe(addrStr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			req := map[string]interface{}{
				"方法": r.Method,
				"路径": r.URL.Path,
				"头": func() map[string]interface{} {
					h := make(map[string]interface{})
					for k, v := range r.Header { h[k] = strings.Join(v, ",") }
					return h
				}(),
			}
			body, _ := ioutil.ReadAll(r.Body)
			req["主体"] = string(body)
			call(callback, []interface{}{req, w})
		}))
	} else {
		l, err := net.Listen("tcp", addrStr)
		if err != nil { return nil }
		go func() {
			defer l.Close()
			for {
				conn, err := l.Accept()
				if err != nil { continue }
				call(callback, []interface{}{conn})
			}
		}()
	}
	return nil
}

func connect(addr interface{}, timeout interface{}) interface{} {
	t := 5 * time.Second
	if ti, ok := timeout.(int64); ok { t = time.Duration(ti) * time.Millisecond }
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("%v", addr), t)
	if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
	return &Result{IsSuccess: true, Value: conn}
}

func request(url interface{}, options interface{}) interface{} {
	method := "GET"
	var body io.Reader
	headers := make(map[string]string)
	if opt, ok := options.(map[string]interface{}); ok {
		if m, ok := opt["方法"].(string); ok { method = m }
		if b, ok := opt["主体"].(string); ok { body = strings.NewReader(b) }
		if h, ok := opt["头"].(map[string]interface{}); ok {
			for k, v := range h { headers[k] = fmt.Sprintf("%v", v) }
		}
	}
	req, err := http.NewRequest(method, fmt.Sprintf("%v", url), body)
	if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
	for k, v := range headers { req.Header.Set(k, v) }
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
	defer resp.Body.Close()
	respBody, err := ioutil.ReadAll(resp.Body)
	if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
	return &Result{IsSuccess: true, Value: string(respBody)}
}

var 时 = map[string]interface{}{
	"睡": func(args []interface{}) interface{} {
		if len(args) > 0 { if ms, ok := args[0].(int64); ok { time.Sleep(time.Duration(ms) * time.Millisecond) } }
		return nil
	},
	"现": func(args []interface{}) interface{} { return time.Now().UnixNano() / 1e6 },
}

var 外 = map[string]interface{}{
	"加载": func(args []interface{}) interface{} {
		if len(args) < 1 { return &Result{IsSuccess: false, Error: "加载期望 1 个参数"} }
		libPath := fmt.Sprintf("%v", args[0])
		dll, err := syscall.LoadDLL(libPath)
		if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
		return &Result{IsSuccess: true, Value: map[string]interface{}{
			"__HANDLE__": "DLL",
			"__PTR__":    int64(uintptr(dll.Handle)),
			"__PATH__":   libPath,
		}}
	},
}

var 字节 = map[string]interface{}{
	"从字": func(args []interface{}) interface{} { if len(args) > 0 { return []byte(fmt.Sprintf("%v", args[0])) }; return nil },
	"到字": func(args []interface{}) interface{} { if len(args) > 0 { if b, ok := args[0].([]byte); ok { return string(b) } }; return "" },
}

var 系统 = map[string]interface{}{
	"参数": func() []interface{} { res := make([]interface{}, len(os.Args)); for i, a := range os.Args { res[i] = a }; return res }(),
}

func execute(cmd interface{}) interface{} {
	cmdStr := fmt.Sprintf("%v", cmd)
	parts := strings.Fields(cmdStr)
	if len(parts) == 0 { return &Result{IsSuccess: false, Error: "empty command"} }
	c := exec.Command(parts[0], parts[1:]...)
	out, err := c.CombinedOutput()
	if err != nil { return &Result{IsSuccess: false, Error: string(out) + " " + err.Error()} }
	return &Result{IsSuccess: true, Value: string(out)}
}

func call(fn interface{}, args []interface{}) interface{} {
	if fn == nil { return nil }
	if f, ok := fn.(func([]interface{}) interface{}); ok { return f(args) }
	return nil
}

func index(left, idx interface{}) interface{} {
	if arr, ok := left.([]interface{}); ok {
		if i, ok := idx.(int64); ok && i >= 0 && i < int64(len(arr)) {
			return arr[i]
		}
	}
	if b, ok := left.([]byte); ok {
		if i, ok := idx.(int64); ok && i >= 0 && i < int64(len(b)) {
			return int64(b[i])
		}
	}
	if dict, ok := left.(map[string]interface{}); ok {
		if s, ok := idx.(string); ok {
			return dict[s]
		}
	}
	return nil
}

func getAttr(obj, attr interface{}) interface{} {
	if dict, ok := obj.(map[string]interface{}); ok {
		if s, ok := attr.(string); ok {
			// 处理 FFI DLL 调用
			if dict["__HANDLE__"] == "DLL" {
				procName := s
				ptr := dict["__PTR__"].(int64)
				path := dict["__PATH__"].(string)
				return func(args []interface{}) interface{} {
					dll := &syscall.DLL{Name: path, Handle: syscall.Handle(ptr)}
					proc, err := dll.FindProc(procName)
					if err != nil { return &Result{IsSuccess: false, Error: err.Error()} }
					uArgs := make([]uintptr, len(args))
					for i, a := range args {
						switch v := a.(type) {
						case int64: uArgs[i] = uintptr(v)
						case string:
							if strings.HasSuffix(procName, "W") {
								p, _ := syscall.UTF16PtrFromString(v)
								uArgs[i] = uintptr(unsafe.Pointer(p))
							} else {
								p, _ := syscall.BytePtrFromString(v)
								uArgs[i] = uintptr(unsafe.Pointer(p))
							}
						default: uArgs[i] = 0
						}
					}
					r1, _, _ := proc.Call(uArgs...)
					return int64(r1)
				}
			}
			if visMap, ok := dict["__VIS__"].(map[string]string); ok {
				if vis, ok := visMap[s]; ok && vis != "公" {
					panic(fmt.Sprintf("禁止访问%s属性: %s", vis, s))
				}
			}
			return dict[s]
		}
	}
	if str, ok := obj.(string); ok {
		switch attr {
		case "长度": return int64(len(str))
		case "包含": return func(args []interface{}) interface{} {
			if len(args) > 0 { return strings.Contains(str, fmt.Sprintf("%v", args[0])) }
			return false
		}
		}
	}
	if b, ok := obj.([]byte); ok {
		if attr == "长度" { return int64(len(b)) }
	}
	if arr, ok := obj.([]interface{}); ok {
		if attr == "长度" { return int64(len(arr)) }
	}
	if conn, ok := obj.(net.Conn); ok {
		switch attr {
		case "读":
			return func(args []interface{}) interface{} {
				var size int64 = 0
				if len(args) > 0 { if s, ok := args[0].(int64); ok { size = s } }
				if size > 0 {
					buf := make([]byte, size)
					n, err := conn.Read(buf)
					if err != nil { return nil }
					return string(buf[:n])
				} else if size == -1 {
					c, _ := ioutil.ReadAll(conn)
					return string(c)
				} else {
					r := bufio.NewReader(conn)
					l, _ := r.ReadString('\n')
					return strings.TrimSpace(l)
				}
			}
		case "写":
			return func(args []interface{}) interface{} {
				if len(args) == 0 { return false }
				_, err := conn.Write([]byte(fmt.Sprintf("%v\n", args[0])))
				return err == nil
			}
		case "关":
			return func(args []interface{}) interface{} { conn.Close(); return nil }
		}
	}
	if w, ok := obj.(http.ResponseWriter); ok {
		switch attr {
		case "写":
			return func(args []interface{}) interface{} {
				if len(args) == 0 { return nil }
				w.Write([]byte(fmt.Sprintf("%v", args[0])))
				return nil
			}
		case "头":
			return func(args []interface{}) interface{} {
				if len(args) < 2 { return nil }
				w.Header().Set(fmt.Sprintf("%v", args[0]), fmt.Sprintf("%v", args[1]))
				return nil
			}
		case "码":
			return func(args []interface{}) interface{} {
				if len(args) > 0 { if code, ok := args[0].(int64); ok { w.WriteHeader(int(code)) } }
				return nil
			}
		}
	}
	if ch, ok := obj.(chan interface{}); ok {
		switch attr {
		case "送":
			return func(args []interface{}) interface{} { if len(args) > 0 { ch <- args[0] }; return nil }
		case "收":
			return func(args []interface{}) interface{} { return <-ch }
		case "关":
			return func(args []interface{}) interface{} { close(ch); return nil }
		}
	}
	if res, ok := obj.(*Result); ok {
		switch attr {
		case "接着":
			return func(args []interface{}) interface{} {
				if res.IsSuccess && len(args) > 0 {
					r := call(args[0], []interface{}{res.Value})
					if rv, ok := r.(*Result); ok { return rv }
					return &Result{IsSuccess: true, Value: r}
				}
				return res
			}
		case "否则":
			return func(args []interface{}) interface{} {
				if !res.IsSuccess && len(args) > 0 {
					r := call(args[0], []interface{}{res.Error})
					if rv, ok := r.(*Result); ok { return rv }
					return &Result{IsSuccess: true, Value: r}
				}
				return res
			}
		}
	}
	return nil
}

type Result struct {
	IsSuccess bool
	Value     interface{}
	Error     interface{}
}

func (r *Result) String() string {
	if r.IsSuccess { return fmt.Sprintf("成功(%v)", r.Value) }
	return fmt.Sprintf("失败(%v)", r.Error)
}

type Task struct {
	ch     chan interface{}
	Value  interface{}
	IsDone bool
}

func await(v interface{}) interface{} {
	if t, ok := v.(*Task); ok {
		if t.IsDone { return t.Value }
		t.Value = <-t.ch
		t.IsDone = true
		return t.Value
	}
	return v
}

func serialize(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func deserialize(s interface{}) interface{} {
	str, ok := s.(string)
	if !ok { return nil }
	var res interface{}
	json.Unmarshal([]byte(str), &res)
	return res
}

func merge(base map[string]interface{}, override interface{}) map[string]interface{} {
	if o, ok := override.(map[string]interface{}); ok {
		for k, v := range o {
			base[k] = v
		}
	}
	return base
}

func setAttr(obj, attr, val interface{}) interface{} {
	if dict, ok := obj.(map[string]interface{}); ok {
		if s, ok := attr.(string); ok {
			if visMap, ok := dict["__VIS__"].(map[string]string); ok {
				if vis, ok := visMap[s]; ok && vis != "公" {
					panic(fmt.Sprintf("禁止修改%s属性: %s", vis, s))
				}
			}
			dict[s] = val
			return val
		}
	}
	return nil
}

func main() {
	fmt.Println(inspect("--- v0.9.2 字节处理与系统参数测试 ---"))
	fmt.Println(inspect("\n1. 测试字节处理:"))
	var 文本 interface{} = "玄铁XuanTie"
	_ = 文本
	var 字节数据 interface{} = call(getAttr(字节, "从字"), []interface{}{文本})
	_ = 字节数据
	fmt.Println(inspect(fmt.Sprintf("%v%v", "原始文本: ", 文本)))
	fmt.Println(inspect(fmt.Sprintf("%v%v", "字节数据[DEBUG]: ", 字节数据)))
	fmt.Println(inspect(fmt.Sprintf("%v%v", "字节长度: ", getAttr(字节数据, "长度"))))
	fmt.Println(inspect(fmt.Sprintf("%v%v", "第一个字节 (X): ", index(字节数据, int64(0)))))
	var 还原文本 interface{} = call(getAttr(字节, "到字"), []interface{}{字节数据})
	_ = 还原文本
	fmt.Println(inspect(fmt.Sprintf("%v%v", "还原文本: ", 还原文本)))
	fmt.Println(inspect("\n2. 测试系统参数:"))
	fmt.Println(inspect(fmt.Sprintf("%v%v", "所有参数: ", getAttr(系统, "参数"))))
	fmt.Println(inspect(fmt.Sprintf("%v%v", "当前程序: ", index(getAttr(系统, "参数"), int64(0)))))
	if isTruthy(gt(getAttr(getAttr(系统, "参数"), "长度"), int64(1))) {
		fmt.Println(inspect(fmt.Sprintf("%v%v", "第一个参数: ", index(getAttr(系统, "参数"), int64(1)))))
	} else {
		fmt.Println(inspect("提示：运行此脚本时可以带上参数测试，例如: xuantie Test/test_v092.xt 哈哈"))
	}
}

// 基础算术与逻辑辅助函数
func sub(l, r interface{}) interface{} {
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok { return li - ri }
		if rf, ok := r.(float64); ok { return float64(li) - rf }
	}
	if lf, ok := l.(float64); ok {
		if ri, ok := r.(int64); ok { return lf - float64(ri) }
		if rf, ok := r.(float64); ok { return lf - rf }
	}
	return 0
}
func mul(l, r interface{}) interface{} {
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok { return li * ri }
		if rf, ok := r.(float64); ok { return float64(li) * rf }
	}
	if lf, ok := l.(float64); ok {
		if ri, ok := r.(int64); ok { return lf * float64(ri) }
		if rf, ok := r.(float64); ok { return lf * rf }
	}
	return 0
}
func div(l, r interface{}) interface{} {
	if li, ok := l.(int64); ok {
		if ri, ok := r.(int64); ok {
			if ri == 0 { panic("除零错误") }
			return li / ri
		}
		if rf, ok := r.(float64); ok && rf != 0 { return float64(li) / rf }
	}
	if lf, ok := l.(float64); ok {
		if ri, ok := r.(int64); ok && ri != 0 { return lf / float64(ri) }
		if rf, ok := r.(float64); ok && rf != 0 { return lf / rf }
	}
	return 0
}
