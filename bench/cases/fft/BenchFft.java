public class BenchFft {
    static final int N = 4096;

    static void fft(double[] re, double[] im, double[] cosT, double[] sinT) {
        int n = re.length;
        int i = 1;
        int j = 0;
        while (i < n) {
            int bit = n / 2;
            while ((j & bit) != 0) {
                j ^= bit;
                bit /= 2;
            }
            j ^= bit;
            if (i < j) {
                double tr = re[i]; re[i] = re[j]; re[j] = tr;
                double ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
            i++;
        }

        for (int len = 2; len <= n; len *= 2) {
            int half = len / 2;
            int step = n / len;
            for (int k = 0; k < n; k += len) {
                for (int t = 0; t < half; t++) {
                    int idx = k + t;
                    int tw = t * step;
                    double wr = cosT[tw];
                    double wi = -sinT[tw];
                    double ur = re[idx];
                    double ui = im[idx];
                    double vr0 = re[idx + half];
                    double vi0 = im[idx + half];
                    double vr = vr0 * wr - vi0 * wi;
                    double vi = vr0 * wi + vi0 * wr;
                    re[idx] = ur + vr;
                    im[idx] = ui + vi;
                    re[idx + half] = ur - vr;
                    im[idx + half] = ui - vi;
                }
            }
        }
    }

    public static void main(String[] args) {
        double[] re = new double[N];
        double[] im = new double[N];
        double[] cosT = new double[N / 2];
        double[] sinT = new double[N / 2];
        for (int i = 0; i < N; i++) {
            re[i] = Math.sin(2.0 * Math.PI * i / N);
        }
        for (int i = 0; i < N / 2; i++) {
            double a = 2.0 * Math.PI * i / N;
            cosT[i] = Math.cos(a);
            sinT[i] = Math.sin(a);
        }

        for (int w = 0; w < 10; w++) fft(re, im, cosT, sinT);
        long t0 = System.nanoTime();
        for (int r = 0; r < 100; r++) fft(re, im, cosT, sinT);
        double us = (System.nanoTime() - t0) / 1000.0 / 100.0;
        System.out.printf("FFT4096: %.1f 微秒 (校验 %s)%n", us, re[1]);
    }
}
