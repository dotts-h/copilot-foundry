import { describe, expect, it } from "vitest";
import { add } from "../src/lib.js";

describe("add", () => {
  it("sums positive integers", () => {
    expect(add(2, 3)).toBe(5);
  });
});
