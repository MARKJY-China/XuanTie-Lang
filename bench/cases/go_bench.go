package main

import (
	"fmt"
	"time"
)

func fib(n int64) int64 {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	t := time.Now()
	f := fib(30); _ = f
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
}
