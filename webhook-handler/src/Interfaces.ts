export interface INulabAccount {
  nulabId: string;
  name: string;
  uniqueId: string;
}

export interface IUser {
  id: number;
  userId: string;
  name: string;
  roleType: number;
  lang: string;
  mailAddress: string;
  nulabAccount: INulabAccount;
}

export interface IRepository {
  id: number;
  name: string;
  description: string;
}

export interface IAssignee {
  id: number;
  userId: string;
  name: string;
  roleType: number;
  lang: string;
}

export interface IGitPushedContent {
  change_type: string,
  ref: string,
  repository: {
    id: number,
    name: string,
    description: any
  },
  revision_count: number,
  revision_type: string,
  revisions: []
}

export interface IPullRequestContent {
  id: number,
  number: number,
  summary: string,
  description: string,
  base: string,
  branch: string,
  diff: any,
  assignee: any,
  comment: any,
  changes: [],
  issue: any,
  repository: IRepository
}

export interface IProject {
  id: number;
  projectKey: string;
  name: string;
  chartEnabled: boolean;
  subtaskingEnabled: boolean;
  projectLeaderCanEditProjectLeader: boolean;
  useWikiTreeView: boolean;
  textFormattingRule: string;
  archived: boolean;
}

export enum EventType {
  GitPushed = 12,
  PullRequestCreated = 18,
  PullRequestUpdated = 19,
}

export interface IWebHookEvent {
  id: number;
  project: IProject;
  type: EventType;
  content: IGitPushedContent | IPullRequestContent;
  notifications: any[];
  createdUser: IUser;
  created: string;
}

export interface IArchiveMapping {
  objectKey: string,
  archivedFile: string
}

export interface IEventHandler {
  execute(): void;
}

export interface ISSHKey {
  /** Path to SecretKey */
  SecretKey: string;
  /** Path to PublicKey */
  PublicKey: string;
}

export interface IS3ArchiveConfigs {
  git_branch_pushed_trigger: string[],
  archive_by_subfolders: string[]
}