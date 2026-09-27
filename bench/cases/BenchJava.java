public class BenchJava {
    static long us() { return System.nanoTime() / 1000; }
    static int empty() { return 0; }
    static long fib(long n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }

    public static void main(String[] a) {
        long t = us();
        for (int i = 0; i < 1000000; i++) empty();
        System.out.println("空函数调用1e6: " + (us() - t) + " 微秒");

        t = us();
        long r30 = fib(30);
        System.out.println("fib30递归: " + (us() - t) + " 微秒 (f=" + r30 + ")");

        t = us();
        String s = "";
        for (int i = 0; i < 100000; i++) s = s + "a";
        System.out.println("字符串拼接1e5: " + (us() - t) + " 微秒 (len=" + s.length() + ")");

        t = us();
        java.util.ArrayList<Integer> lst = new java.util.ArrayList<>();
        for (int i = 0; i < 100000; i++) lst.add(i);
        System.out.println("列表添加1e5: " + (us() - t) + " 微秒 (len=" + lst.size() + ")");

        t = us();
        java.util.HashMap<String, Integer> d = new java.util.HashMap<>();
        for (int i = 0; i < 10000; i++) d.put("键" + i, i);
        System.out.println("字典插入1e4: " + (us() - t) + " 微秒");

        t = us();
        double f = 0.0;
        for (int i = 0; i < 1000000; i++) f = f + 1.5;
        System.out.println("浮点累加1e6: " + (us() - t) + " 微秒 (f=" + f + ")");

        t = us();
        long r = 0;
        for (int i = 0; i < 1000000; i++) r = (r * 7 + 13) % 1000003;
        System.out.println("乘模1e6: " + (us() - t) + " 微秒 (r=" + r + ")");

        t = us();
        int c = 0;
        for (int i = 0; i < 10000000; i++) { if (i % 2 == 0) c++; else c--; }
        System.out.println("分支1e7: " + (us() - t) + " 微秒 (c=" + c + ")");

        t = us();
        int n = 0;
        for (int x = 0; x < 1000; x++) for (int y = 0; y < 1000; y++) n++;
        System.out.println("嵌套循环1e6: " + (us() - t) + " 微秒 (n=" + n + ")");
    }
}
