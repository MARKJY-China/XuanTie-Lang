package stdlib

import (
	"fmt"
	"io/ioutil"
	"math"
	"math/rand"
	"net/http"
	"strings"
	"time"
	"xuantie/object"
)

// Builtins 存储所有内置函数和对象
var Builtins = map[string]object.Object{
	"文件": &object.Dict{
		Pairs: map[string]object.Object{
			"开": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 暂时复用读取逻辑作为示例，实际上开/关通常涉及句柄
					if len(args) != 1 {
						return &object.Error{Message: fmt.Sprintf("期望 1 个参数，得到 %d", len(args))}
					}
					return &object.String{Value: "FILE_HANDLE_MOCK"}
				},
			},
			"关": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					return &object.Boolean{Value: true}
				},
			},
			"读": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: fmt.Sprintf("期望 1 个参数，得到 %d", len(args))}
					}
					path, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数必须是字符串，得到 %s", args[0].Type())}
					}
					content, err := ioutil.ReadFile(path.Value)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.Error{Message: fmt.Sprintf("读取文件失败: 找不到文件或无法读取 (%s)", path.Value)}}
					}
					return &object.Result{IsSuccess: true, Value: &object.String{Value: string(content)}}
				},
			},
			"写": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: fmt.Sprintf("期望 2 个参数，得到 %d", len(args))}
					}
					path, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数 1 必须是字符串，得到 %s", args[0].Type())}
					}
					content, ok := args[1].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数 2 必须是字符串，得到 %s", args[1].Type())}
					}
					err := ioutil.WriteFile(path.Value, []byte(content.Value), 0644)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.Error{Message: fmt.Sprintf("写入文件失败: 路径无效或无权限 (%s)", path.Value)}}
					}
					return &object.Result{IsSuccess: true, Value: &object.Boolean{Value: true}}
				},
			},
			"添": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 模拟追加逻辑
					return &object.Boolean{Value: true}
				},
			},
			"删": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 模拟删除逻辑
					return &object.Boolean{Value: true}
				},
			},
			"建": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 模拟创建逻辑
					return &object.Boolean{Value: true}
				},
			},
			"拷": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 模拟复制逻辑
					return &object.Boolean{Value: true}
				},
			},
			"移": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 模拟移动逻辑
					return &object.Boolean{Value: true}
				},
			},
		},
	},
	"网络": &object.Dict{
		Pairs: map[string]object.Object{
			"获取": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: fmt.Sprintf("期望 1 个参数，得到 %d", len(args))}
					}
					url, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数必须是字符串，得到 %s", args[0].Type())}
					}
					resp, err := http.Get(url.Value)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.Error{Message: err.Error()}}
					}
					defer resp.Body.Close()
					content, err := ioutil.ReadAll(resp.Body)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.Error{Message: err.Error()}}
					}
					return &object.Result{IsSuccess: true, Value: &object.String{Value: string(content)}}
				},
			},
		},
	},
	"字符串": &object.Dict{
		Pairs: map[string]object.Object{
			"长度": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: fmt.Sprintf("期望 1 个参数，得到 %d", len(args))}
					}
					str, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数必须是字符串，得到 %s", args[0].Type())}
					}
					return &object.Integer{Value: int64(len(str.Value))}
				},
			},
			"子串": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 3 {
						return &object.Error{Message: fmt.Sprintf("期望 3 个参数，得到 %d", len(args))}
					}
					str, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数 1 必须是字符串，得到 %s", args[0].Type())}
					}
					start, ok := args[1].(*object.Integer)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数 2 必须是整数，得到 %s", args[1].Type())}
					}
					length, ok := args[2].(*object.Integer)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数 3 必须是整数，得到 %s", args[2].Type())}
					}
					s := int(start.Value)
					l := int(length.Value)
					if s < 0 || s > len(str.Value) || s+l > len(str.Value) {
						return &object.Error{Message: "子串索引越界"}
					}
					return &object.String{Value: str.Value[s : s+l]}
				},
			},
			"替换": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 3 {
						return &object.Error{Message: fmt.Sprintf("期望 3 个参数，得到 %d", len(args))}
					}
					str, ok := args[0].(*object.String)
					oldStr, ok2 := args[1].(*object.String)
					newStr, ok3 := args[2].(*object.String)
					if !ok || !ok2 || !ok3 {
						return &object.Error{Message: "所有参数必须是字符串"}
					}
					return &object.String{Value: strings.ReplaceAll(str.Value, oldStr.Value, newStr.Value)}
				},
			},
			"分割": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: fmt.Sprintf("期望 2 个参数，得到 %d", len(args))}
					}
					str, ok := args[0].(*object.String)
					sep, ok2 := args[1].(*object.String)
					if !ok || !ok2 {
						return &object.Error{Message: "所有参数必须是字符串"}
					}
					parts := strings.Split(str.Value, sep.Value)
					elements := make([]object.Object, len(parts))
					for i, p := range parts {
						elements[i] = &object.String{Value: p}
					}
					return &object.Array{Elements: elements}
				},
			},
		},
	},
	"数学": &object.Dict{
		Pairs: map[string]object.Object{
			"绝对值": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					switch v := args[0].(type) {
					case *object.Integer:
						if v.Value < 0 {
							return &object.Integer{Value: -v.Value}
						}
						return v
					case *object.Float:
						return &object.Float{Value: math.Abs(v.Value)}
					default:
						return &object.Error{Message: "参数必须是数值"}
					}
				},
			},
			"正弦": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					var val float64
					if i, ok := args[0].(*object.Integer); ok {
						val = float64(i.Value)
					} else if f, ok := args[0].(*object.Float); ok {
						val = f.Value
					} else {
						return &object.Error{Message: "参数必须是数值"}
					}
					return &object.Float{Value: math.Sin(val)}
				},
			},
			"余弦": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					var val float64
					if i, ok := args[0].(*object.Integer); ok {
						val = float64(i.Value)
					} else if f, ok := args[0].(*object.Float); ok {
						val = f.Value
					} else {
						return &object.Error{Message: "参数必须是数值"}
					}
					return &object.Float{Value: math.Cos(val)}
				},
			},
			"平方根": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					var val float64
					if i, ok := args[0].(*object.Integer); ok {
						val = float64(i.Value)
					} else if f, ok := args[0].(*object.Float); ok {
						val = f.Value
					} else {
						return &object.Error{Message: "参数必须是数值"}
					}
					return &object.Float{Value: math.Sqrt(val)}
				},
			},
			"随机数": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 无参数返回 0-1 之间的小数，1 个参数返回 0-n 之间的整数
					if len(args) == 0 {
						return &object.Float{Value: rand.Float64()}
					}
					if len(args) == 1 {
						if n, ok := args[0].(*object.Integer); ok {
							return &object.Integer{Value: rand.Int63n(n.Value)}
						}
					}
					return &object.Error{Message: "参数错误"}
				},
			},
		},
	},
	"时间": &object.Dict{
		Pairs: map[string]object.Object{
			"现在": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					return &object.Integer{Value: time.Now().Unix()}
				},
			},
			"休眠": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					if ms, ok := args[0].(*object.Integer); ok {
						time.Sleep(time.Duration(ms.Value) * time.Millisecond)
						return &object.Boolean{Value: true}
					}
					return &object.Error{Message: "参数必须是整数(毫秒)"}
				},
			},
			"格式化": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 默认格式化当前时间，或指定时间戳
					t := time.Now()
					layout := "2006-01-02 15:04:05"
					if len(args) >= 1 {
						if ts, ok := args[0].(*object.Integer); ok {
							t = time.Unix(ts.Value, 0)
						}
					}
					if len(args) >= 2 {
						if l, ok := args[1].(*object.String); ok {
							layout = l.Value
						}
					}
					return &object.String{Value: t.Format(layout)}
				},
			},
		},
	},
}
