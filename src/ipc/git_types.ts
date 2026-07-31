// Type definitions for Git operations
export type GitCommit = {
  oid: string;
  commit: {
    message: string;
    author: {
      timestamp: number;
    };
  };
};
export interface GitBaseParams {
  path: string;
}
export interface GitCommitParams extends GitBaseParams {
  message: string;
  amend?: boolean;
  /** Allow creating a commit with no staged changes (e.g. empty repo) */
  allowEmpty?: boolean;
}
export interface GitFileParams extends GitBaseParams {
  filepath: string;
}
export interface GitCheckoutParams extends GitBaseParams {
  ref: string;
}
export interface GitBranchRenameParams extends GitBaseParams {
  oldBranch: string;
  newBranch: string;
}
export interface GitCloneProgress {
  /** e.g. "Receiving objects", "Resolving deltas" */
  phase: string;
  /** 0-100 when git reports a percentage, otherwise undefined. */
  percent?: number;
}

export interface GitCloneParams {
  path: string; // destination
  url: string;
  depth?: number | null;
  singleBranch?: boolean;
  accessToken?: string;
  signal?: AbortSignal;
  /** Progress from `git clone --progress` stderr (or isomorphic-git's onProgress). */
  onProgress?: (progress: GitCloneProgress) => void;
}
export interface GitLogParams extends GitBaseParams {
  depth?: number;
}

export interface GitPushParams extends GitBaseParams {
  branch: string;
  accessToken: string;
  force?: boolean;
}
export interface GitFileAtCommitParams extends GitBaseParams {
  filePath: string;
  commitHash: string;
}
export interface GitSetRemoteUrlParams extends GitBaseParams {
  remoteUrl: string;
}
export interface GitInitParams extends GitBaseParams {
  ref?: string; // branch name, default = "main"
}
export interface GitStageToRevertParams extends GitBaseParams {
  targetOid: string;
}
