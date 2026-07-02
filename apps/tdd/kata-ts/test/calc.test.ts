import { describe, expect, it } from "vitest";
import { add } from "../src/calc.js";

describe("add", () => {
  it("sums positive integers", () => {
    expect(add(2, 3)).toBe(5);
  });

  it("sums with zero", () => {
    expect(add(0, 7)).toBe(7);
  });
});
