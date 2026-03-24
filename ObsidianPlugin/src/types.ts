/**
 * Shared type definitions for the Zoom Obsidian plugin.
 * Ported from the MCP server's zoom-summaries.ts and obsidian-client.ts.
 */

import { Notice } from "obsidian";

const LOG_PREFIX = "[zoom-obsidian]";
const DEFAULT_NOTICE_DURATION = 8000; // ms

/**
 * Show an Obsidian Notice and mirror the message to the console.
 * Use duration=0 for a persistent notice that must be hidden manually.
 */
export function notify(message: string, duration = DEFAULT_NOTICE_DURATION): Notice {
  console.log(LOG_PREFIX, message);
  return new Notice(message, duration);
}

/** A row from the Zoom meeting summaries list page. */
export interface MeetingSummaryItem {
  meeting_topic: string;
  meeting_id: string | number;
  meeting_uuid: string;
  meeting_start_time: string;
  meeting_end_time: string;
  host_name?: string;
  host_email?: string;
  summary_created_time?: string;
  /** Raw column data when scraped from HTML table */
  column_0?: string;
  column_1?: string;
  column_2?: string;
  column_3?: string;
  column_4?: string;
  [key: string]: unknown;
}

/** Full summary detail from Zoom's internal REST API. */
export interface MeetingSummaryDetail {
  meeting_topic: string;
  meeting_id: string | number;
  summary_overview?: string;
  summary_details?: string;
  next_steps?: string[];
  next_step_items?: NextStepItem[];
  nextStepItems?: NextStepItem[];
  error?: string;
  raw?: unknown;
  overallSummary?: string;
  summaryOverview?: string;
  summaryItemVOs?: SummarySection[];
  stepList?: string[];
  topic?: string;
  startTime?: string;
  [key: string]: unknown;
}

export interface SummarySection {
  label: string;
  summary: string;
}

export interface NextStepItem {
  assignees?: { username?: string; [key: string]: unknown }[];
  [key: string]: unknown;
}

/** Data shape used by the vault writer for formatting/inserting summaries. */
export interface ZoomSummaryData {
  meeting_id: string | number;
  meeting_topic?: string;
  overallSummary?: string;
  summaryOverview?: string;
  summary_overview?: string;
  summaryItemVOs?: SummarySection[];
  stepList?: string[];
  next_steps?: string[];
  topic?: string;
  startTime?: string;
  [key: string]: unknown;
}

/** Nav-ID pair for direct-navigating to summary detail. */
export interface NavIdEntry {
  uuidMeetingId: string;
  summaryId: string;
  isShared?: boolean;
}

/** Plugin settings stored in data.json. */
export interface ZoomObsidianSettings {
  zoomSubdomain: string;
  vaultSubfolder: string;
  oneOnOneFolders: string;
  autoDelete: boolean;
  /** Serialized cookies from Zoom auth session. */
  cookies: SerializedCookie[];
  /** Filter string for meeting topics (optional). */
  filter: string;
  /** Enable debug logging to console. */
  debug: boolean;
  /** Folder for shared Zoom meetings (optional). If not set, shared meetings are not processed. */
  sharedMeetingsFolder: string;
}

export interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

export const DEFAULT_SETTINGS: ZoomObsidianSettings = {
  zoomSubdomain: "",
  vaultSubfolder: "",
  oneOnOneFolders: "! One on Ones, ! One on Ones (Other)",
  autoDelete: false,
  cookies: [],
  filter: "",
  debug: false,
  sharedMeetingsFolder: "",
};

/** Per-source config file state (separate from data.json). */
export interface ObsidianConfigState {
  lastProcessedOwned?: string; // ISO timestamp
  lastProcessedShared?: string; // ISO timestamp
}

export const DEFAULT_CONFIG_STATE: ObsidianConfigState = {};
