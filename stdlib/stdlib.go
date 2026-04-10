package stdlib

import (
	"bufio"
	"fmt"
	"io/ioutil"
	"math"
	"math/rand"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"xuantie/object"
)

// Builtins 存储所有内置函数和对象
var Builtins = map[string]object.Object{
	"输入": &object.Builtin{
		Fn: func(args ...object.Object) object.Object {
			if len(args) > 0 {
				fmt.Print(args[0].Inspect())
			}
			reader := bufio.NewReader(os.Stdin)
			text, _ := reader.ReadString('\n')
			return &object.String{Value: strings.TrimSpace(text)}
		},
	},
	"输": &object.Builtin{
		Fn: func(args ...object.Object) object.Object {
			if len(args) > 0 {
				fmt.Print(args[0].Inspect())
			}
			reader := bufio.NewReader(os.Stdin)
			text, _ := reader.ReadString('\n')
			return &object.String{Value: strings.TrimSpace(text)}
		},
	},
	"文件": &object.Dict{
		Pairs: map[string]object.Object{
			"开": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: fmt.Sprintf("期望 1 个参数，得到 %d", len(args))}
					}
					path, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: fmt.Sprintf("参数必须是字符串，得到 %s", args[0].Type())}
					}
					_, err := os.Open(path.Value)
					if err != nil {
						return &object.Result{IsSuccess: false, Error: &object.Error{Message: err.Error()}}
					}
					// 返回一个包装了 *os.File 的字典
					res := &object.Dict{Pairs: make(map[string]object.Object)}
					res.Pairs["__HANDLE__"] = &object.String{Value: "FILE"}
					res.Pairs["路径"] = path
					// 暂时用 Mock 值代表底层句柄，实际操作通过 stdlib 的方法进行
					return &object.Result{IsSuccess: true, Value: res}
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
				Fn: func(args ...object.Object) object.Object { return &object.Boolean{Value: true} },
			},
			"删": &object.Builtin{
				Fn: func(args ...object.Object) object.Object { return &object.Boolean{Value: true} },
			},
			"建": &object.Builtin{
				Fn: func(args ...object.Object) object.Object { return &object.Boolean{Value: true} },
			},
			"拷": &object.Builtin{
				Fn: func(args ...object.Object) object.Object { return &object.Boolean{Value: true} },
			},
			"移": &object.Builtin{
				Fn: func(args ...object.Object) object.Object { return &object.Boolean{Value: true} },
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
			"包含": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: "期望 2 个参数 (字符串, 子串)"}
					}
					return &object.Boolean{Value: strings.Contains(args[0].Inspect(), args[1].Inspect())}
				},
			},
			"分割": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: "期望 2 个参数 (字符串, 分隔符)"}
					}
					s := args[0].Inspect()
					if str, ok := args[0].(*object.String); ok {
						s = str.Value
					}
					sep := args[1].Inspect()
					if str, ok := args[1].(*object.String); ok {
						sep = str.Value
					}
					parts := strings.Split(s, sep)
					elements := make([]object.Object, len(parts))
					for i, p := range parts {
						elements[i] = &object.String{Value: p}
					}
					return &object.Array{Elements: elements}
				},
			},
			"替换": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 3 {
						return &object.Error{Message: "期望 3 个参数 (源串, 旧串, 新串)"}
					}
					return &object.String{Value: strings.ReplaceAll(args[0].Inspect(), args[1].Inspect(), args[2].Inspect())}
				},
			},
			"修剪": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.String{Value: strings.TrimSpace(args[0].Inspect())}
				},
			},
		},
	},
	"数学": &object.Dict{
		Pairs: map[string]object.Object{
			"随机": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					return &object.Integer{Value: int64(rand.Intn(100))}
				},
			},
			"绝对值": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					if val, ok := args[0].(*object.Integer); ok {
						return &object.Integer{Value: int64(math.Abs(float64(val.Value)))}
					}
					if val, ok := args[0].(*object.Float); ok {
						return &object.Float{Value: math.Abs(val.Value)}
					}
					return &object.Error{Message: "参数必须是数字"}
				},
			},
			"正弦": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Float{Value: math.Sin(getFloat(args[0]))}
				},
			},
			"余弦": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Float{Value: math.Cos(getFloat(args[0]))}
				},
			},
			"平方根": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Float{Value: math.Sqrt(getFloat(args[0]))}
				},
			},
			"幂次": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: "期望 2 个参数 (底数, 指数)"}
					}
					return &object.Float{Value: math.Pow(getFloat(args[0]), getFloat(args[1]))}
				},
			},
			"对数": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Float{Value: math.Log(getFloat(args[0]))}
				},
			},
			"最大值": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: "期望 2 个参数"}
					}
					return &object.Float{Value: math.Max(getFloat(args[0]), getFloat(args[1]))}
				},
			},
			"最小值": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 2 {
						return &object.Error{Message: "期望 2 个参数"}
					}
					return &object.Float{Value: math.Min(getFloat(args[0]), getFloat(args[1]))}
				},
			},
			"向上取整": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Integer{Value: int64(math.Ceil(getFloat(args[0])))}
				},
			},
			"向下取整": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数"}
					}
					return &object.Integer{Value: int64(math.Floor(getFloat(args[0])))}
				},
			},
		},
	},
	"时": &object.Dict{
		Pairs: map[string]object.Object{
			"睡": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "期望 1 个参数（毫秒）"}
					}
					ms, ok := args[0].(*object.Integer)
					if !ok {
						return &object.Error{Message: "参数必须是整数"}
					}
					time.Sleep(time.Duration(ms.Value) * time.Millisecond)
					return &object.Null{}
				},
			},
			"现": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					return &object.Integer{Value: time.Now().UnixNano() / int64(time.Millisecond)}
				},
			},
		},
	},
	"整": &object.Builtin{
		Fn: func(args ...object.Object) object.Object {
			if len(args) != 1 {
				return &object.Error{Message: "期望 1 个参数"}
			}
			switch arg := args[0].(type) {
			case *object.Integer:
				return &object.Result{IsSuccess: true, Value: arg}
			case *object.Float:
				return &object.Result{IsSuccess: true, Value: &object.Integer{Value: int64(arg.Value)}}
			case *object.String:
				val, err := strconv.ParseInt(arg.Value, 0, 64)
				if err != nil {
					return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
				}
				return &object.Result{IsSuccess: true, Value: &object.Integer{Value: val}}
			default:
				return &object.Result{IsSuccess: false, Error: &object.String{Value: fmt.Sprintf("无法转换为整数: %s", arg.Type())}}
			}
		},
	},
	"小数": &object.Builtin{
		Fn: func(args ...object.Object) object.Object {
			if len(args) != 1 {
				return &object.Error{Message: "期望 1 个参数"}
			}
			switch arg := args[0].(type) {
			case *object.Integer:
				return &object.Result{IsSuccess: true, Value: &object.Float{Value: float64(arg.Value)}}
			case *object.Float:
				return &object.Result{IsSuccess: true, Value: arg}
			case *object.String:
				val, err := strconv.ParseFloat(arg.Value, 64)
				if err != nil {
					return &object.Result{IsSuccess: false, Error: &object.String{Value: err.Error()}}
				}
				return &object.Result{IsSuccess: true, Value: &object.Float{Value: val}}
			default:
				return &object.Result{IsSuccess: false, Error: &object.String{Value: fmt.Sprintf("无法转换为小数: %s", arg.Type())}}
			}
		},
	},
	"字": &object.Builtin{
		Fn: func(args ...object.Object) object.Object {
			if len(args) != 1 {
				return &object.Error{Message: "期望 1 个参数"}
			}
			return &object.String{Value: args[0].Inspect()}
		},
	},
	"外": &object.Dict{
		Pairs: map[string]object.Object{
			"加载": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					// 这是一个占位实现，实际 FFI 逻辑将在 Evaluator 中配合具体平台实现
					if len(args) != 1 {
						return &object.Error{Message: "加载期望 1 个参数（库路径）"}
					}
					return &object.Result{IsSuccess: true, Value: &object.String{Value: "LIB_HANDLE_" + args[0].Inspect()}}
				},
			},
		},
	},
	"系统": &object.Dict{
		Pairs: map[string]object.Object{
			"参数": &object.Array{
				Elements: func() []object.Object {
					args := os.Args
					res := make([]object.Object, len(args))
					for i, a := range args {
						res[i] = &object.String{Value: a}
					}
					return res
				}(),
			},
		},
	},
	"字节": &object.Dict{
		Pairs: map[string]object.Object{
			"从字": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "从字期望 1 个参数"}
					}
					s, ok := args[0].(*object.String)
					if !ok {
						return &object.Error{Message: "参数必须是字符串"}
					}
					return &object.Bytes{Value: []byte(s.Value)}
				},
			},
			"到字": &object.Builtin{
				Fn: func(args ...object.Object) object.Object {
					if len(args) != 1 {
						return &object.Error{Message: "到字期望 1 个参数"}
					}
					b, ok := args[0].(*object.Bytes)
					if !ok {
						return &object.Error{Message: "参数必须是字节"}
					}
					return &object.String{Value: string(b.Value)}
				},
			},
		},
	},
}

func getFloat(obj object.Object) float64 {
	if i, ok := obj.(*object.Integer); ok {
		return float64(i.Value)
	}
	if f, ok := obj.(*object.Float); ok {
		return f.Value
	}
	return 0
}
