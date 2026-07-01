export interface RunSpec {
  targetDir: string;
  venvDir: string;
  redModel: string;
  greenModel: string;
  implRelPath: string;
  testRelPath: string;
  redPrompt: string;
  greenPrompt: string;
}

export interface SliceLedger {
  runId: string;
  redSuccess: boolean;
  redGatePassed: boolean;
  greenSuccess: boolean;
  greenGatePassed: boolean;
  diffGuardViolated: boolean;
  diffGuardOffendingPaths: string[];
  completedAt: string;
}

export type WorkflowMode = "feature" | "bugfix" | "harden" | "overhaul";
export type WorkflowScope = "node" | "module" | "package" | "repo";
export type HitlMode = "plan-only" | "confirm-each" | "auto";

export interface ModelRouting {
  plan: string;
  red: string;
  green: string;
  escalation: string;
}

export const DEFAULT_MODELS: ModelRouting = {
  plan: "claude-sonnet-5-thinking-medium",
  red: "claude-sonnet-5-thinking-medium",
  green: "composer-2.5-fast",
  escalation: "claude-sonnet-5-thinking-medium",
};

export interface FeatureRunSpec {
  mode: WorkflowMode;
  targetDir: string;
  venvDir: string;
  scope: WorkflowScope;
  hitl: HitlMode;
  featureDescription: string;
  targetHint?: string;
  models: ModelRouting;
  maxRepairIterations: number;
}

const SUPPORTED_SCOPES: WorkflowScope[] = ["node", "module", "package", "repo"];

export function validateFeatureRunSpec(spec: FeatureRunSpec): void {
  if (spec.mode !== "feature") {
    throw new Error(
      `validateFeatureRunSpec: mode "${spec.mode}" is not supported until a later milestone (only "feature" is implemented in M1)`,
    );
  }
  if (spec.hitl === "confirm-each") {
    throw new Error(
      'validateFeatureRunSpec: hitl "confirm-each" is not supported until a later milestone (no cockpit callback channel yet)',
    );
  }
  if (!SUPPORTED_SCOPES.includes(spec.scope)) {
    throw new Error(`validateFeatureRunSpec: unknown scope "${spec.scope}"`);
  }
  if (spec.maxRepairIterations < 1 || spec.maxRepairIterations > 10) {
    throw new Error(
      `validateFeatureRunSpec: maxRepairIterations must be between 1 and 10, got ${spec.maxRepairIterations}`,
    );
  }
  if (spec.featureDescription.trim().length === 0) {
    throw new Error("validateFeatureRunSpec: featureDescription must not be empty");
  }
}
