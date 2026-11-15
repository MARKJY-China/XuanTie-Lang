package stdlib

import (
	"fmt"
	"xuantie/object"
)

func processStart(args ...object.Object) object.Object {
	if len(args) != 1 {
		return processError("进程.启动 期望 1 个参数", -1)
	}
	command, ok := args[0].(*object.String)
	if !ok {
		return processError("进程.启动 的命令必须是字符串", -1)
	}
	process, err := object.NewProcess(command.Value)
	if err != nil {
		return processError(fmt.Sprintf("启动子进程失败: %v", err), -1)
	}
	return &object.Result{IsSuccess: true, Value: process, Error: &object.Null{}}
}

func processFrom(args []object.Object, want int, method string) (*object.Process, *object.Result) {
	if len(args) != want {
		return nil, processError(fmt.Sprintf("%s 期望 %d 个参数", method, want), -1)
	}
	process, ok := args[0].(*object.Process)
	if !ok {
		return nil, processError("不是子进程句柄", -1)
	}
	return process, nil
}

func processWrite(args ...object.Object) object.Object {
	process, failure := processFrom(args, 2, "进程.写")
	if failure != nil {
		return failure
	}
	var data []byte
	switch content := args[1].(type) {
	case *object.String:
		data = []byte(content.Value)
	case *object.Bytes:
		data = content.Value
	default:
		return processError("写入内容必须是字符串或字节", -1)
	}
	if err := process.Write(data); err != nil {
		return processError(fmt.Sprintf("写入子进程标准输入失败: %v", err), -1)
	}
	return processSuccess(true)
}

func processFlush(args ...object.Object) object.Object {
	process, failure := processFrom(args, 1, "进程.刷新")
	if failure != nil {
		return failure
	}
	if process.Stdin == nil {
		return processError("子进程标准输入已关闭", -1)
	}
	return processSuccess(true)
}

func processCloseInput(args ...object.Object) object.Object {
	process, failure := processFrom(args, 1, "进程.关闭输入")
	if failure != nil {
		return failure
	}
	if err := process.CloseInput(); err != nil {
		return processError(fmt.Sprintf("关闭子进程标准输入失败: %v", err), -1)
	}
	return processSuccess(true)
}

func processWait(args ...object.Object) object.Object {
	process, failure := processFrom(args, 1, "进程.等退出")
	if failure != nil {
		return failure
	}
	code, err := process.Wait()
	if err != nil {
		return processError(fmt.Sprintf("等待子进程退出失败: %v", err), int64(code))
	}
	return processSuccess(int64(code))
}

func processSuccess(value interface{}) *object.Result {
	result := &object.Result{IsSuccess: true, Error: &object.Null{}}
	switch v := value.(type) {
	case bool:
		result.Value = &object.Boolean{Value: v}
	case int64:
		result.Value = &object.Integer{Value: v}
	case object.Object:
		result.Value = v
	default:
		result.Value = &object.Null{}
	}
	return result
}

func processError(message string, code int64) *object.Result {
	return &object.Result{
		IsSuccess: false,
		Value:     &object.Integer{Value: code},
		Error:     &object.String{Value: message},
	}
}
