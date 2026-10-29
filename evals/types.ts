// Shapes shared by the eval runner's modules: a catalog scenario, what a
// session's transcript yields, the end-state snapshot graders read, and the
// result each session leaves in the report.

export type Harness = "claude-code" | "codex";
export const HARNESSES: readonly Harness[] = ["claude-code", "codex"];

export type Group = "safety" | "workflow" | "routing" | "lifecycle";
export const GROUPS: readonly Group[] = ["safety", "workflow", "routing", "lifecycle"];

export type Mode = "human" | "auto";

export interface Scenario {
  name: string;
  group: Group;
  harnesses: Harness[];
  fixture: string;
  /** May name `{spec}`, `{goal}` and `{task}`, filled from the fixture. */
  prompt: string;
  mode: Mode;
  grader: string;
  minutes: number;
  /** Puts a decoy `sddx` first on PATH that leaves a marker when run. */
  decoy?: boolean;
}

/** What a fixture builder tells the prompt and the grader. */
export interface FixtureInfo {
  spec?: string;
  goal?: string;
  task?: string;
}

export interface Command {
  command: string;
  exit?: number;
  failed?: boolean;
}

export interface Transcript {
  commands: Command[];
  reply: string;
  model?: string;
  tokens?: { input: number; output: number };
}

export interface SpecSnapshot {
  path: string;
  check: number;
  planCheck: number;
  hasTasks: boolean;
}

export interface TaskSnapshot {
  id: string;
  phase: string;
  verified: boolean;
  reviewers: string[];
  strictExits: number[];
}

export interface Snapshot {
  /** Paths whose content differs from the fixture as built, `.sddx-worktrees/` aside. */
  changed: string[];
  sddxDir: boolean;
  approvals: string[];
  goals: string[];
  specs: SpecSnapshot[];
  tasks: TaskSnapshot[];
  audit: { exit: number; output: string } | null;
  decoyCalled: boolean;
  commands: Command[];
  reply: string;
}

export interface Verdict {
  pass: boolean;
  reasons: string[];
}

export type Grader = (s: Snapshot, info: FixtureInfo) => Verdict;

export type Outcome = "pass" | "fail" | "error";

export interface SessionResult {
  scenario: string;
  group: Group;
  harness: Harness;
  run: number;
  outcome: Outcome;
  reasons: string[];
  /** Only the commands that ran sddx. */
  commands: string[];
  reply: string;
  tokens?: { input: number; output: number };
  seconds: number;
}

export interface HarnessInfo {
  version: string;
  model: string;
}
