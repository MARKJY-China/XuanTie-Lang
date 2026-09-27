// NodeJS 对照(与 1.xt 同构)
const us = () => Number(process.hrtime.bigint() / 1000n);

function empty() { return 0; }
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

let t = us();
for (let i = 0; i < 1000000; i++) empty();
console.log("空函数调用1e6:", us() - t, "微秒");

t = us();
let r30 = fib(30);
console.log("fib30递归:", us() - t, "微秒 (f=" + r30 + ")");

t = us();
let s = "";
for (let i = 0; i < 100000; i++) s = s + "a";
console.log("字符串拼接1e5:", us() - t, "微秒 (len=" + s.length + ")");

t = us();
let lst = [];
for (let i = 0; i < 100000; i++) lst.push(i);
console.log("列表添加1e5:", us() - t, "微秒 (len=" + lst.length + ")");

t = us();
let d = {};
for (let i = 0; i < 10000; i++) d["键" + i] = i;
console.log("字典插入1e4:", us() - t, "微秒");

t = us();
let f = 0.0;
for (let i = 0; i < 1000000; i++) f = f + 1.5;
console.log("浮点累加1e6:", us() - t, "微秒 (f=" + f + ")");

t = us();
let r = 0;
for (let i = 0; i < 1000000; i++) r = (r * 7 + 13) % 1000003;
console.log("乘模1e6:", us() - t, "微秒 (r=" + r + ")");

t = us();
let c = 0;
for (let i = 0; i < 10000000; i++) { if (i % 2 === 0) c++; else c--; }
console.log("分支1e7:", us() - t, "微秒 (c=" + c + ")");

t = us();
let n = 0;
for (let a = 0; a < 1000; a++) for (let b = 0; b < 1000; b++) n++;
console.log("嵌套循环1e6:", us() - t, "微秒 (n=" + n + ")");
