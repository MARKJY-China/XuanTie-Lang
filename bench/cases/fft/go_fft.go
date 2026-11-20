package main

import (
	"fmt"
	"math"
	"time"
)

const n = 4096

func fft(re, im, cosT, sinT []float64) {
	i := 1
	j := 0
	for i < n {
		bit := n / 2
		for j&bit != 0 {
			j ^= bit
			bit /= 2
		}
		j ^= bit
		if i < j {
			re[i], re[j] = re[j], re[i]
			im[i], im[j] = im[j], im[i]
		}
		i++
	}

	for length := 2; length <= n; length *= 2 {
		half := length / 2
		step := n / length
		for k := 0; k < n; k += length {
			for t := 0; t < half; t++ {
				idx := k + t
				tw := t * step
				wr := cosT[tw]
				wi := -sinT[tw]
				ur := re[idx]
				ui := im[idx]
				vr0 := re[idx+half]
				vi0 := im[idx+half]
				vr := vr0*wr - vi0*wi
				vi := vr0*wi + vi0*wr
				re[idx] = ur + vr
				im[idx] = ui + vi
				re[idx+half] = ur - vr
				im[idx+half] = ui - vi
			}
		}
	}
}

func main() {
	re := make([]float64, n)
	im := make([]float64, n)
	cosT := make([]float64, n/2)
	sinT := make([]float64, n/2)
	for i := 0; i < n; i++ {
		re[i] = math.Sin(2 * math.Pi * float64(i) / n)
	}
	for i := 0; i < n/2; i++ {
		a := 2 * math.Pi * float64(i) / n
		cosT[i] = math.Cos(a)
		sinT[i] = math.Sin(a)
	}

	fft(re, im, cosT, sinT)
	t := time.Now()
	for r := 0; r < 100; r++ {
		fft(re, im, cosT, sinT)
	}
	us := time.Since(t).Microseconds() / 100
	fmt.Printf("FFT4096: %d 微秒 (校验 %v)\n", us, re[1])
}
