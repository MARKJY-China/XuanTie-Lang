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
	lastDef := ""
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "define ") {
			lastDef = line
		} else if strings.Contains(line, "\"类型\" = alloca i64") {
			fmt.Println(lastDef)
			fmt.Println(line)
		}
	}
}