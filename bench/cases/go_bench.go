package main

import (
	"fmt"
	"os"
	"time"
)

func fib(n int64) int64 {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

//go:noinline
func emptyCall() {}

// 全局变量阻止编译器把嵌套循环折叠成 n=1e6。
var loopLimit = 1000

// Windows 上 Go 的计时器粒度约 0.5ms:短用例单跑会被截成 0/524 的跳变。
// 短用例重复 10 次后取平均,仍是每次 1e6/1e5 次操作的耗时。
const shortReps = 10

func main() {
	// 用运行期参数个数做一次不可折叠的赋值，避免编译器把 1000×1000 循环常量折叠成 0µs。
	loopLimit = 1000 + len(os.Args) - 1

	t := time.Now()
	f := fib(30)
	_ = f
	fmt.Println("fib30递归:", time.Since(t).Microseconds(), "微秒 (f=832040)")

	t = time.Now()
	s := ""
	for i := 0; i < 100000; i++ {
		s = s + "a"
	}
	fmt.Println("字符串拼接1e5:", time.Since(t).Microseconds(), "微秒 (len=100000)")

	t = time.Now()
	f64 := 0.0
	for i := 0; i < 1000000; i++ {
		f64 = f64 + 1.5
	}
	fmt.Println("浮点累加1e6:", time.Since(t).Microseconds(), "微秒")

	t = time.Now()
	d := map[string]int{}
	for i := 0; i < 10000; i++ {
		d[fmt.Sprintf("键%d", i)] = i
	}
	fmt.Println("字典插入1e4:", time.Since(t).Microseconds(), "微秒")

	t = time.Now()
	c := 0
	for i := 0; i < 10000000; i++ {
		if i%2 == 0 {
			c++
		} else {
			c--
		}
	}
	fmt.Println("分支1e7:", time.Since(t).Microseconds(), "微秒")

	// issue #168 补充:与 XuanTie/Node/Java/Python/Rust 对齐的 4 项覆盖。
	t = time.Now()
	for r := 0; r < shortReps; r++ {
		for i := 0; i < 1000000; i++ {
			emptyCall()
		}
	}
	fmt.Println("空函数调用1e6:", time.Since(t).Microseconds()/shortReps, "微秒")

	t = time.Now()
	var xs []int
	for r := 0; r < shortReps; r++ {
		xs = []int{}
		for i := 0; i < 100000; i++ {
			xs = append(xs, i)
		}
	}
	fmt.Println("列表添加1e5:", time.Since(t).Microseconds()/shortReps, "微秒 (len="+fmt.Sprint(len(xs))+")")

	t = time.Now()
	var r int64 = 0
	for i := 0; i < 1000000; i++ {
		r = (r*7 + 13) % 1000003
	}
	fmt.Println("乘模1e6:", time.Since(t).Microseconds(), "微秒 (r="+fmt.Sprint(r)+")")

	t = time.Now()
	n := 0
	for rep := 0; rep < shortReps; rep++ {
		n = 0
		for a := 0; a < loopLimit; a++ {
			for b := 0; b < loopLimit; b++ {
				// 读内层下标 b(而非只 n++),阻止编译器把双重循环折叠成乘法。
				n += b
			}
		}
	}
	fmt.Println("嵌套循环1e6:", time.Since(t).Microseconds()/shortReps, "微秒 (n="+fmt.Sprint(n)+")")
}
