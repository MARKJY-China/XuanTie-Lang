package main
import (
	"bufio"
	"fmt"
	"os"
	"strings"
)
func main() {
	f, _ := os.Open("xuantie_compiler/入口.ll")
	scanner := bufio.NewScanner(f)
	inFunc := false
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "define i64 @\"编译器_编译若语句\"") {
			inFunc = true
		}
		if inFunc {
			fmt.Println(line)
			if strings.Contains(line, "entry:") {
				break
			}
		}
	}
}