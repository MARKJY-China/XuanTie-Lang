const N = 4096;

function fft(re, im, cosT, sinT) {
  const n = re.length;
  let i = 1;
  let j = 0;
  while (i < n) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;
    if (i < j) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
    i++;
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let k = 0; k < n; k += len) {
      for (let t = 0; t < half; t++) {
        const idx = k + t;
        const tw = t * step;
        const wr = cosT[tw];
        const wi = -sinT[tw];
        const ur = re[idx];
        const ui = im[idx];
        const vr0 = re[idx + half];
        const vi0 = im[idx + half];
        const vr = vr0 * wr - vi0 * wi;
        const vi = vr0 * wi + vi0 * wr;
        re[idx] = ur + vr;
        im[idx] = ui + vi;
        re[idx + half] = ur - vr;
        im[idx + half] = ui - vi;
      }
    }
  }
}

const re = new Float64Array(N);
const im = new Float64Array(N);
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
for (let i = 0; i < N; i++) re[i] = Math.sin((2 * Math.PI * i) / N);
for (let i = 0; i < N / 2; i++) {
  const a = (2 * Math.PI * i) / N;
  cosT[i] = Math.cos(a);
  sinT[i] = Math.sin(a);
}

for (let w = 0; w < 5; w++) fft(re, im, cosT, sinT);
const t0 = process.hrtime.bigint();
for (let r = 0; r < 100; r++) fft(re, im, cosT, sinT);
const us = Number(process.hrtime.bigint() - t0) / 1000 / 100;
console.log(`FFT4096: ${us.toFixed(1)} 微秒 (校验 ${re[1]})`);
