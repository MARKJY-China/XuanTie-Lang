use std::collections::HashMap;
use std::hint::black_box;
use std::time::Instant;

#[inline(never)]
fn empty_call() -> i64 {
    0
}

fn fib(n: i64) -> i64 {
    if n < 2 {
        n
    } else {
        fib(n - 1) + fib(n - 2)
    }
}

fn main() {
    let t = Instant::now();
    let f = fib(30);
    println!("fib30递归: {} 微秒 (f={})", t.elapsed().as_micros(), black_box(f));

    let t = Instant::now();
    let mut s = String::new();
    for _ in 0..100_000 {
        s = s + "a";
    }
    println!("字符串拼接1e5: {} 微秒 (len={})", t.elapsed().as_micros(), s.len());

    let t = Instant::now();
    let mut f64v = 0.0f64;
    for _ in 0..1_000_000 {
        f64v += 1.5;
    }
    println!("浮点累加1e6: {} 微秒 (f={})", t.elapsed().as_micros(), black_box(f64v));

    let t = Instant::now();
    let mut d: HashMap<String, i64> = HashMap::new();
    for i in 0..10_000 {
        d.insert(format!("键{}", i), i);
    }
    println!("字典插入1e4: {} 微秒 (len={})", t.elapsed().as_micros(), d.len());

    let t = Instant::now();
    let mut c = 0i64;
    for i in 0..10_000_000 {
        if i % 2 == 0 {
            c += 1;
        } else {
            c -= 1;
        }
    }
    println!("分支1e7: {} 微秒 (c={})", t.elapsed().as_micros(), black_box(c));

    // 与 Go/Node/Java/Python 对齐的 4 项补充。
    let t = Instant::now();
    for _ in 0..1_000_000 {
        black_box(empty_call());
    }
    println!("空函数调用1e6: {} 微秒", t.elapsed().as_micros());

    let t = Instant::now();
    let mut xs: Vec<i64> = Vec::new();
    for i in 0..100_000 {
        xs.push(i);
    }
    println!("列表添加1e5: {} 微秒 (len={})", t.elapsed().as_micros(), black_box(xs.len()));

    let t = Instant::now();
    let mut r = 0i64;
    for _ in 0..1_000_000 {
        r = (r * 7 + 13) % 1_000_003;
    }
    println!("乘模1e6: {} 微秒 (r={})", t.elapsed().as_micros(), black_box(r));

    let t = Instant::now();
    let limit = black_box(1000i64);
    let mut n = 0i64;
    for _a in 0..limit {
        for _b in 0..limit {
            // black_box 阻止 LLVM 把双重循环折叠成 n = limit*limit。
            n = n.wrapping_add(black_box(1));
        }
    }
    println!("嵌套循环1e6: {} 微秒 (n={})", t.elapsed().as_micros(), black_box(n));
}
