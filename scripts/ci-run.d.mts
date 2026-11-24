export interface CiStep {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  stream?: boolean;
}

export interface CiPlan {
  phase1: CiStep[];
  phase2: CiStep[];
  phase3: CiStep[];
}

export interface CiStepResult {
  id: string;
  ok: boolean;
  code: number;
  durationMs: number;
  output: string;
  streamed: boolean;
}

export function parseCliArgs(argv: readonly string[]): {
  withE2e: boolean;
  skipRepoStatics: boolean;
};

export function buildCiPlan(options?: { withE2e?: boolean; skipRepoStatics?: boolean }): CiPlan;

export function buildChildEnv(
  baseEnv?: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): NodeJS.ProcessEnv;

export function runCiPlan(
  plan: CiPlan,
  options?: {
    runStep?: (step: CiStep) => Promise<CiStepResult>;
    writeLine?: (line: string) => void;
    writeError?: (line: string) => void;
  },
): Promise<{ ok: boolean; results: CiStepResult[] }>;
