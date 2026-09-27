import time

def us(): return int(time.perf_counter() * 1_000_000)

def empty(): return 0

t = us()
i = 0
while i < 1000000: empty(); i += 1
print("空函数调用1e6:", us() - t, "微秒")

t = us()
s = ""
i = 0
while i < 100000: s = s + "a"; i += 1
print("字符串拼接1e5:", us() - t, "微秒 (len=%d)" % len(s))

t = us()
lst = []
i = 0
while i < 100000: lst.append(i); i += 1
print("列表添加1e5:", us() - t, "微秒 (len=%d)" % len(lst))

t = us()
d = {}
i = 0
while i < 10000: d["键" + str(i)] = i; i += 1
print("字典插入1e4:", us() - t, "微秒")

t = us()
f = 0.0
i = 0
while i < 1000000: f = f + 1.5; i += 1
print("浮点累加1e6:", us() - t, "微秒 (f=%s)" % f)

t = us()
r = 0
i = 0
while i < 1000000: r = (r * 7 + 13) % 1000003; i += 1
print("乘模1e6:", us() - t, "微秒 (r=%d)" % r)

t = us()
c = 0
i = 0
while i < 10000000:
    if i % 2 == 0: c += 1
    else: c -= 1
    i += 1
print("分支1e7:", us() - t, "微秒 (c=%d)" % c)

t = us()
n = 0
a = 0
while a < 1000:
    b = 0
    while b < 1000: n += 1; b += 1
    a += 1
print("嵌套循环1e6:", us() - t, "微秒 (n=%d)" % n)

def fib(x): return x if x < 2 else fib(x-1) + fib(x-2)
t = us()
f30 = fib(30)
print("fib30递归:", us() - t, "微秒 (f=%d)" % f30)
