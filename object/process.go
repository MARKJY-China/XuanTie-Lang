package object

import (
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
)

type Process struct {
	Cmd      *exec.Cmd
	Stdin    io.WriteCloser
	closeErr error
	waited   bool
	exitCode int
	waitErr  error
}

func (p *Process) Type() ObjectType { return PROCESS_OBJ }
func (p *Process) Inspect() string  { return "进程句柄" }

func NewProcess(command string) (*Process, error) {
	if command == "" {
		return nil, fmt.Errorf("命令不能为空")
	}
	var cmd *exec.Cmd
	if os.PathSeparator == '\\' {
		cmd = exec.Command("cmd", "/c", command)
	} else {
		cmd = exec.Command("/bin/sh", "-c", command)
	}
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return nil, err
	}
	p := &Process{Cmd: cmd, Stdin: stdin, exitCode: -1}
	runtime.SetFinalizer(p, func(proc *Process) {
		_, _ = proc.Wait()
	})
	return p, nil
}

func (p *Process) Write(data []byte) error {
	if p == nil || p.Stdin == nil {
		return fmt.Errorf("子进程句柄无效或标准输入已关闭")
	}
	for len(data) > 0 {
		n, err := p.Stdin.Write(data)
		if n > 0 {
			data = data[n:]
		}
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}

func (p *Process) CloseInput() error {
	if p == nil {
		return fmt.Errorf("不是子进程句柄")
	}
	if p.Stdin == nil {
		return p.closeErr
	}
	p.closeErr = p.Stdin.Close()
	p.Stdin = nil
	return p.closeErr
}

func (p *Process) Wait() (int, error) {
	if p == nil {
		return -1, fmt.Errorf("不是子进程句柄")
	}
	if p.waited {
		return p.exitCode, p.waitErr
	}
	p.waited = true
	closeErr := p.CloseInput()
	err := p.Cmd.Wait()
	p.exitCode = p.Cmd.ProcessState.ExitCode()
	if err != nil {
		if _, ok := err.(*exec.ExitError); !ok {
			p.exitCode = -1
			p.waitErr = err
		}
	}
	if p.waitErr == nil && closeErr != nil {
		p.waitErr = closeErr
	}
	runtime.SetFinalizer(p, nil)
	return p.exitCode, p.waitErr
}
