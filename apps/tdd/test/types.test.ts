import { describe, expect, it } from "vitest";
import { DEFAULT_MODELS, validateFeatureRunSpec, type FeatureRunSpec } from "../src/types.js";

function baseSpec(overrides: Partial<FeatureRunSpec> = {}): FeatureRunSpec {
  return {
    mode: "feature",
    targetDir: "/tmp/whatever",
    venvDir: "/tmp/whatever/.venv",
    scope: "repo",
    hitl: "auto",
    featureDescription: "add string utilities",
    targetHint: undefined,
    models: DEFAULT_MODELS,
    maxRepairIterations: 5,
    ...overrides,
  };
}

describe("validateFeatureRunSpec", () => {
  it("accepts a well-formed feature spec", () => {
    expect(() => validateFeatureRunSpec(baseSpec())).not.toThrow();
  });

  it("rejects a mode other than feature, naming the milestone gap", () => {
    expect(() => validateFeatureRunSpec(baseSpec({ mode: "bugfix" }))).toThrow(/mode "bugfix"/);
  });

  it("rejects hitl confirm-each as not yet supported", () => {
    expect(() => validateFeatureRunSpec(baseSpec({ hitl: "confirm-each" }))).toThrow(/confirm-each/);
  });

  it("rejects maxRepairIterations out of the 1-10 range", () => {
    expect(() => validateFeatureRunSpec(baseSpec({ maxRepairIterations: 0 }))).toThrow(/maxRepairIterations/);
    expect(() => validateFeatureRunSpec(baseSpec({ maxRepairIterations: 11 }))).toThrow(/maxRepairIterations/);
  });

  it("rejects an empty featureDescription", () => {
    expect(() => validateFeatureRunSpec(baseSpec({ featureDescription: "   " }))).toThrow(/featureDescription/);
  });

  it("rejects an unknown scope value", () => {
    expect(() =>
      validateFeatureRunSpec(baseSpec({ scope: "galaxy" as unknown as FeatureRunSpec["scope"] })),
    ).toThrow(/unknown scope/);
  });
});
