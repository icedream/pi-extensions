package main

import (
	"fmt"

	"example.com/myapp/pkg/math"
)

type Calculator struct {
	ops []string
}

func NewCalculator() *Calculator {
	return &Calculator{}
}

func main() {
	fmt.Println(math.Add(1, 2))
}
