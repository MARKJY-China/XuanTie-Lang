use std::hint::black_box;
use std::time::Instant;

const N: usize = 4096;

fn fft(re: &mut [f64], im: &mut [f64], cos_t: &[f64], sin_t: &[f64]) {
    let n = re.len();
    let mut i = 1usize;
    let mut j = 0usize;
    while i < n {
        let mut bit = n / 2;
        while j & bit != 0 {
            j ^= bit;
            bit /= 2;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
        i += 1;
    }

    let mut len = 2usize;
    while len <= n {
        let half = len / 2;
        let step = n / len;
        let mut k = 0usize;
        while k < n {
            let mut t = 0usize;
            while t < half {
                let idx = k + t;
                let tw = t * step;
                let wr = cos_t[tw];
                let wi = -sin_t[tw];
                let ur = re[idx];
                let ui = im[idx];
                let vr0 = re[idx + half];
                let vi0 = im[idx + half];
                let vr = vr0 * wr - vi0 * wi;
                let vi = vr0 * wi + vi0 * wr;
                re[idx] = ur + vr;
                im[idx] = ui + vi;
                re[idx + half] = ur - vr;
                im[idx + half] = ui - vi;
                t += 1;
            }
            k += len;
        }
        len *= 2;
    }
}

fn main() {
    let mut re = vec![0.0f64; N];
    let mut im = vec![0.0f64; N];
    let mut cos_t = vec![0.0f64; N / 2];
    let mut sin_t = vec![0.0f64; N / 2];
    for i in 0..N {
        re[i] = (std::f64::consts::TAU * i as f64 / N as f64).sin();
    }
    for i in 0..N / 2 {
        let a = std::f64::consts::TAU * i as f64 / N as f64;
        cos_t[i] = a.cos();
        sin_t[i] = a.sin();
    }

    fft(&mut re, &mut im, &cos_t, &sin_t);
    let t = Instant::now();
    for _ in 0..100 {
        fft(black_box(&mut re), black_box(&mut im), &cos_t, &sin_t);
    }
    let us = t.elapsed().as_micros() / 100;
    println!("FFT4096: {} 微秒 (校验 {})", us, black_box(re[1]));
}
