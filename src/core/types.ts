export type GroupColor = 'grey' | 'blue' | 'red' | 'yellow' | 'green' | 'pink' | 'purple' | 'cyan' | 'orange';

export const GROUP_COLORS: GroupColor[] = ['blue', 'green', 'purple', 'orange', 'cyan', 'pink', 'yellow', 'red', 'grey'];

export const NO_GROUP = -1;

/** The subset of chrome.tabs.Tab the planner needs, so it can run without Chrome in tests. */
export interface TabInfo {
  id: number;
  windowId: number;
  index: number;
  url: string;
  title: string;
  groupId: number;
  pinned: boolean;
  audible: boolean;
  active: boolean;
  incognito: boolean;
  openerTabId?: number;
  lastAccessed?: number;
}

export interface GroupInfo {
  id: number;
  windowId: number;
  title: string;
  color: GroupColor;
}

export interface LiveState {
  tabs: TabInfo[];
  groups: GroupInfo[];
}

export interface Project {
  /** Our own stable id. Chrome group ids only live for one browser session. */
  id: string;
  name: string;
  color: GroupColor;
  keywords: string[];
  createdAt: number;
  lastActiveAt: number;
  archived?: boolean;
}

export type UrlRuleKind = 'exact' | 'path' | 'domain';

export interface UrlRule {
  id: string;
  kind: UrlRuleKind;
  /** exact: full URL without hash; path: origin + path prefix; domain: hostname. */
  pattern: string;
  projectId: string;
  createdAt: number;
}

export type Trust = 'high' | 'low';

export interface Correction {
  id?: number;
  at: number;
  url: string;
  title: string;
  fromGroupTitle: string | null;
  toGroupTitle: string | null;
  toProjectId: string | null;
  kind: 'move' | 'ungroup';
  trust: Trust;
}

export interface PageSummary {
  url: string;
  text: string;
  fetchedAt: number;
}

/** Recorded when a tab is created; lives in storage.session. */
export interface TabMeta {
  openedAt: number;
  openerTabId?: number;
  /** The opener had been active within the last 5 minutes when this tab was opened. */
  openerRecent: boolean;
}

/** Where an assignment sends a tab. Candidate ids are `p_<projectId>` or `g_<groupId>`; new projects use a tempId. */
export type Destination =
  | { kind: 'group'; groupId: number }
  | { kind: 'project'; projectId: string }
  | { kind: 'new'; tempId: string };

export type AssignSource = 'rule' | 'opener' | 'model' | 'domain';

export interface Assignment {
  tabId: number;
  dest: Destination;
  source: AssignSource;
  confidence?: number;
  reason?: string;
}

export interface NewProjectProposal {
  tempId: string;
  name: string;
  color: GroupColor;
}

export interface TabMove {
  tabId: number;
  windowId: number;
  beforeGroupId: number;
  beforeIndex: number;
  afterGroupId: number;
}

export interface ClosedTab {
  tabId: number;
  url: string;
  title: string;
  windowId: number;
  index: number;
  groupId: number;
}

export interface OpLogEntry {
  id: string;
  at: number;
  kind: 'organize' | 'domain' | 'cleanup';
  moves: TabMove[];
  closed: ClosedTab[];
  /** Projects this run created; undo removes them again if nothing else uses them. */
  createdProjectIds?: string[];
  undone?: boolean;
}

export interface GroupSummary {
  title: string;
  color: GroupColor;
  added: number;
  isNew: boolean;
}

export interface CleanupItem {
  tabId: number;
  title: string;
  url: string;
  reason: 'duplicate' | 'blank';
  /** For duplicates: the tab that is kept. */
  keepTabId?: number;
}

export interface RuleSuggestion {
  pattern: string;
  projectId: string;
  projectName: string;
}

export interface OrganizeResult {
  at: number;
  opLogId: string | null;
  groups: GroupSummary[];
  undecidedTabIds: number[];
  skippedChanged: number;
  cleanup: CleanupItem[];
  ruleSuggestions: RuleSuggestion[];
  /** A note for the user, e.g. why the model could not run. Not an error: rules still applied. */
  notice?: string;
}

export interface UndoReport {
  restored: number;
  skippedModified: number;
  missing: number;
  reopened: number;
}

export type TaskState =
  | { status: 'idle' }
  | { status: 'running'; startedAt: number; step: string }
  | { status: 'done'; result: OrganizeResult }
  | { status: 'error'; message: string };
