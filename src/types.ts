export type GitError = { kind: string; message: string };
export type Reference = {
  name: string;
  fullName: string;
  hash: string;
  kind: "branch" | "remote" | "tag";
};
export type FileState = {
  path: string;
  oldPath: string | null;
  xy: string;
  untracked: boolean;
  conflict: boolean;
  staged: boolean;
  unstaged: boolean;
};
export type Worktree = {
  id: string;
  path: string;
  branch: string;
  current: boolean;
  available: boolean;
  bare: boolean;
};
export type Snapshot = {
  path: string;
  name: string;
  branch: string | null;
  head: string | null;
  refs: Reference[];
  files: FileState[];
  historyRevision: string;
  changesRevision: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  operation: string | null;
  worktrees: Worktree[];
  stashes: { reference: string; subject: string }[];
};
export type Project = { repoId: string; snapshot: Snapshot };
export type Commit = {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
};
export type HistoryPage = {
  commits: Commit[];
  offset: number;
  hasMore: boolean;
  revision: string;
};
export type CommitFile = {
  path: string;
  oldPath: string | null;
  status: string;
};
export type CommitDetail = Commit & { files: CommitFile[]; comparison: string };
export type ConflictLine = { line: number; text: string };
export type Diff = {
  patch: string;
  truncated: boolean;
  binary: boolean;
  note: string | null;
  conflict: null | {
    kind: string;
    note: string | null;
    blocks: {
      startLine: number;
      endLine: number;
      ours: ConflictLine[];
      base: ConflictLine[];
      theirs: ConflictLine[];
      incoming: string;
    }[];
  };
};
export type Selection =
  | { kind: "stashes" }
  | { kind: "commit"; hash: string }
  | null;
export type DiffMode = "unstaged" | "staged" | "conflict" | "commit";
