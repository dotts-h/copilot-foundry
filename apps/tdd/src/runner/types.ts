import type { BaselineTestResult } from "../phases/baseline.js";
import type { FileSymbols } from "../phases/map.js";
import type { MutationScoreResult } from "../gates/mutationGate.js";

export type TargetLanguage = "python" | "js" | "go";
export type RunClassification = "passed" | "failed" | "harness_error";

export interface TestRunResult {
  exitCode: number;
  raw: string;
}

export interface MutationOptions {
  workDir: string;
  implRelPath: string;
  functionName: string;
  testRelPath: string;
}

export interface StaticGateResult {
  name: string;
  passed: boolean;
  raw: string;
}

export interface TargetRunner {
  readonly language: TargetLanguage;
  /** Human name of the test framework, used in prompts ("pytest", "vitest", "jest", "go test"). */
  readonly testFrameworkName: string;
  /** Language-specific RED-phase rules appended to the RED prompt (e.g. the python
   *  "import the target inside the test function" rule). */
  readonly redPromptRules: string;
  /** Appended to the RED prompt's target-existence line when the target symbol does not exist yet. */
  readonly missingSymbolRedNote: string;

  /** One-time environment preparation inside the run worktree. No-op for python. */
  ensureEnv(workDir: string): Promise<void>;

  runTests(workDir: string, targetRelPath?: string): Promise<TestRunResult>;
  runTestsOnPaths(workDir: string, paths: string[]): Promise<TestRunResult>;
  runTestsVerbose(workDir: string): Promise<{ exitCode: number; tests: BaselineTestResult[] }>;

  /** Map a raw run to passed / failed / harness_error (harness_error = collection/compile-level). */
  classifyRun(result: TestRunResult): RunClassification;
  /** Does this raw output show the run failed because `functionName` does not exist yet? */
  isMissingSymbolError(raw: string, functionName: string): boolean;
  /** Map a test file relPath to the path-key used in verbose-output nodeIds
   *  (python/js: identity; go later: package dir). */
  testPathKey(relPath: string): string;

  isSourceFile(relPath: string): boolean;
  isTestFile(relPath: string): boolean;
  extractSymbols(targetDir: string, files: string[]): Promise<Record<string, FileSymbols>>;

  computeMutationScore(opts: MutationOptions): Promise<MutationScoreResult>;

  /** Deterministic non-test gates run at the end of verify (e.g. tsc --noEmit, go vet). Empty for python. */
  runStaticGates(workDir: string): Promise<StaticGateResult[]>;
}
