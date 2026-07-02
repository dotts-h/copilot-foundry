package kata

import "testing"

func TestAddPositive(t *testing.T) {
	if got := Add(2, 3); got != 5 {
		t.Fatalf("Add(2, 3) = %d, want 5", got)
	}
}

func TestAddWithZero(t *testing.T) {
	if got := Add(0, 7); got != 7 {
		t.Fatalf("Add(0, 7) = %d, want 7", got)
	}
}
