export interface Step {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  needsBuild?: boolean;
}
export interface Plan {
  docsOnly: boolean;
  statics: Step[];
  build: Step[];
  after: Step[];
  actionlint: boolean;
  modelsDev: boolean;
}
export interface PushUpdate {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}
export function isDocsOnly(files: readonly string[]): boolean;
export function planChecks(
  files: readonly string[],
  options?: { base: string | null; exists?: (file: string) => boolean },
): Plan;
export function parsePushLines(text: string): PushUpdate[];
export function refsToCheck(updates: readonly PushUpdate[]): PushUpdate[];
export function parseSkip(value: string | undefined): { all: boolean; steps: Set<string> };
