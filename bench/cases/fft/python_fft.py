import math
import time

N = 4096


def fft(re, im, cos_t, sin_t):
    n = len(re)
    i, j = 1, 0
    while i < n:
        bit = n // 2
        while j & bit:
            j ^= bit
            bit //= 2
        j ^= bit
        if i < j:
            re[i], re[j] = re[j], re[i]
            im[i], im[j] = im[j], im[i]
        i += 1

    length = 2
    while length <= n:
        half = length // 2
        step = n // length
        k = 0
        while k < n:
            t = 0
            while t < half:
                idx = k + t
                tw = t * step
                wr = cos_t[tw]
                wi = -sin_t[tw]
                ur = re[idx]
                ui = im[idx]
                vr0 = re[idx + half]
                vi0 = im[idx + half]
                vr = vr0 * wr - vi0 * wi
                vi = vr0 * wi + vi0 * wr
                re[idx] = ur + vr
                im[idx] = ui + vi
                re[idx + half] = ur - vr
                im[idx + half] = ui - vi
                t += 1
            k += length
        length *= 2


re = [math.sin(2.0 * math.pi * i / N) for i in range(N)]
im = [0.0] * N
cos_t = [math.cos(2.0 * math.pi * i / N) for i in range(N // 2)]
sin_t = [math.sin(2.0 * math.pi * i / N) for i in range(N // 2)]

fft(re, im, cos_t, sin_t)
t0 = time.perf_counter_ns()
for _ in range(100):
    fft(re, im, cos_t, sin_t)
us = (time.perf_counter_ns() - t0) / 1000.0 / 100.0
print(f"FFT4096: {us:.1f} 微秒 (校验 {re[1]})")
