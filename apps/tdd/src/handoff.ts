import type { Backend } from "./backend/types.js";
import { runFeature, type FeatureLedger } from "./featureFsm.js";
import { DEFAULT_MODELS, validateFeatureRunSpec, type FeatureRunSpec } from "./types.js";

export interface QaHandoffRequest {
  targetDir: string;
  venvDir: string;
  featureDescription: string;
  targetHint?: string;
  commit?: boolean;
}

export interface QaHandoffResult {
  ledger: FeatureLedger;
}

export async function handoffFromQa(
  request: QaHandoffRequest,
  backend: Backend,
  artifactRoot: string,
  runId: string,
): Promise<QaHandoffResult> {
  const spec: FeatureRunSpec = {
    mode: "feature",
    targetDir: request.targetDir,
    venvDir: request.venvDir,
    scope: "repo",
    hitl: "auto",
    featureDescription: request.featureDescription,
    targetHint: request.targetHint,
    models: DEFAULT_MODELS,
    maxRepairIterations: 5,
    commit: request.commit ?? false,
  };
  validateFeatureRunSpec(spec);

  const ledger = await runFeature(spec, backend, artifactRoot, runId);
  return { ledger };
}
