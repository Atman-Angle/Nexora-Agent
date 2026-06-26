package main

import (
	"fmt"
	"os"

	"example.com/bugfix/math"
)

func main() {
	if math.Add(2, 3) != 5 {
		fmt.Fprintf(os.Stderr, "Expected 5 but got %d\n", math.Add(2, 3))
		os.Exit(1)
	}
	fmt.Println("go math test passed")
}
