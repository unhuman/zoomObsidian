/**
 * Obsidian vault client — writes Zoom meeting summaries into 1:1 note files.
 * The vault uses per-person .md files in "! One on Ones" / "! One on Ones (Other)".
 * Each file has an intro/bio section followed by dated entries in newest-first order.
 */

import { readFile, writeFile, readdir } from "fs/promises";
import path from "path";

export interface ZoomSummaryData {
  meeting_id: string | number;
  meeting_topic?: string;
  overallSummary?: string;
  summaryOverview?: string;   // alias returned by Zoom's internal API
  summary_overview?: string;  // snake_case mapped alias from getSummary()
  summaryItemVOs?: Array<{ label: string; summary: string }>;
  stepList?: string[];
  next_steps?: string[];      // mapped alias from getSummary()
  topic?: string;
  startTime?: string;
  [key: string]: unknown;
}

const DEFAULT_ONE_ON_ONE_FOLDERS = [
  "! One on Ones",
  "! One on Ones (Other)",
];

export interface ObsidianClientOptions {
  /** Subfolder within the vault root where 1:1 folders live (e.g. "MyOrg"). Leave empty to search directly under vault root. */
  vaultSubfolder?: string;
  /** Folder names (relative to vaultSubfolder) that contain 1:1 notes. */
  oneOnOneFolders?: string[];
  /** Owner's Zoom display name (first name or full name). Used to filter self from attendee lists and resolve topic names. */
  ownerName?: string;
}

export class ObsidianClient {
  private vaultPath: string;
  private vaultSubfolder: string;
  private oneOnOneFolders: string[];
  private _fileCache: { name: string; path: string }[] | null = null;
  private ownerName: string;
  private ownerFirst: string;

  constructor(vaultPath: string, options: ObsidianClientOptions = {}) {
    this.vaultPath = vaultPath.replace(/^~/, process.env.HOME ?? "~");
    this.vaultSubfolder = options.vaultSubfolder ?? "";
    this.oneOnOneFolders = options.oneOnOneFolders ?? DEFAULT_ONE_ON_ONE_FOLDERS;
    this.ownerName = options.ownerName ?? "";
    this.ownerFirst = this.ownerName.split(/\s+/)[0].toLowerCase();
  }

  /**
   * Check if a name is the owner (by checking first word).
   */
  private isSelf(name: string): boolean {
    if (!this.ownerFirst) return name.toLowerCase().includes("howard"); // legacy fallback
    return name.toLowerCase().includes(this.ownerFirst);
  }

  /**
   * Sanitize a filename by replacing invalid characters with dashes.
   * Invalid characters: < > : " / \ | ? *
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"\/\\|?*]/g, "-").trim();
  }

  /** Load (and cache) all .md files from both 1:1 folders. */
  async allFiles(): Promise<{ name: string; path: string }[]> {
    if (this._fileCache) return this._fileCache;
    const baseDir = this.vaultSubfolder
      ? path.join(this.vaultPath, this.vaultSubfolder)
      : this.vaultPath;
    const results: { name: string; path: string }[] = [];
    for (const folder of this.oneOnOneFolders) {
      const folderPath = path.join(baseDir, folder);
      try {
        const files = await readdir(folderPath);
        for (const f of files) {
          if (f.endsWith(".md")) {
            results.push({ name: f.replace(/\.md$/, ""), path: path.join(folderPath, f) });
          }
        }
      } catch { /* folder missing */ }
    }
    this._fileCache = results;
    return results;
  }

  /**
   * Given a Zoom meeting topic like "Amit:Howard" or "Jeremy:Howard 1:1",
   * and optionally a list of attendee full names (e.g. ["Amit Kumar", "Howard Uman"]),
   * find the best matching .md file in the 1:1 folders.
   *
   * Match priority:
   *  1. File name starts with the topic first name (exact prefix, case-insensitive)
   *  2. File name starts with the first name of any attendee (minus "Howard Uman")
   *  3. File name contains the first name of any attendee
   */
  async findPersonFile(
    meetingTopic: string,
    attendeeNames?: string[]
  ): Promise<string | null> {
    const topicPartner = this.extractPartnerName(meetingTopic);
    const files = await this.allFiles();

    const norm = (s: string) => s.toLowerCase().trim();

    // Non-owner attendees (full names)
    const nonOwnerAttendees = (attendeeNames ?? []).filter(
      (n) => !this.isSelf(n)
    );

    // Priority 0: exact full attendee name matches file name
    for (const fullName of nonOwnerAttendees) {
      const match = files.find((f) => norm(f.name) === norm(fullName));
      if (match) return match.path;
    }

    // Build candidate first-names from attendees, excluding self
    const attendeeFirstNames: string[] = nonOwnerAttendees
      .map((n) => n.split(/\s+/)[0])
      .filter(Boolean);

    // Also include the topic partner name as a candidate (if not self)
    const candidateFirstNames = [
      ...(topicPartner ? [topicPartner] : []),
      ...attendeeFirstNames,
    ].filter(Boolean);

    // Priority 1 & 2: file name starts with any candidate first name
    // When multiple files match the same prefix, prefer solo (no + & /) over shared files
    for (const first of candidateFirstNames) {
      const matches = files.filter((f) => norm(f.name).startsWith(norm(first)));
      if (matches.length === 0) continue;
      if (matches.length === 1) return matches[0].path;
      // Multiple matches: prefer solo files over shared files (separators: + & /  or double-space)
      const solo = matches.find((f) => !/[+&/]|  /.test(f.name));
      return (solo ?? matches[0]).path;
    }

    // Priority 3: file name contains any candidate first name as a word
    for (const first of candidateFirstNames) {
      const re = new RegExp(`\\b${first}\\b`, "i");
      const match = files.find((f) => re.test(f.name));
      if (match) return match.path;
    }

    return null;
  }

  /**
   * Suggest a file path to create for a meeting that has no existing note.
   * Uses the best available name (attendee full name > topic first name).
   */
  suggestNewFilePath(meetingTopic: string, attendeeNames?: string[]): string | null {
    const baseDir = this.vaultSubfolder
      ? path.join(this.vaultPath, this.vaultSubfolder)
      : this.vaultPath;
    const newFilesFolder = this.oneOnOneFolders[1] ?? this.oneOnOneFolders[0] ?? "! One on Ones (Other)";
    const newFilesDir = path.join(baseDir, newFilesFolder);

    // Prefer the first non-owner attendee full name
    const best = (attendeeNames ?? []).find(
      (n) => !this.isSelf(n)
    );
    if (best) return path.join(newFilesDir, `${best}.md`);

    const partner = this.extractPartnerName(meetingTopic);
    if (!partner) {
      // No colon pattern: use the sanitized topic itself as the filename so that
      // plain-named meetings like "Shared Services Managers Meeting" get a target file.
      const sanitized = this.sanitizeFilename(meetingTopic);
      if (!sanitized) return null;
      return path.join(newFilesDir, `${sanitized}.md`);
    }
    return path.join(newFilesDir, `${partner}.md`);
  }

  private extractPartnerName(topic: string): string | null {
    // "Amit:Howard" → "Amit" (if not self)
    // "Howard:Amit" → "Amit" (returns the non-owner side)
    // "Jeremy:Howard 1:1" → "Jeremy"
    // "Zoom Meeting" → null
    const colonIdx = topic.indexOf(":");
    if (colonIdx <= 0) return null;

    const before = topic.substring(0, colonIdx).trim();
    const afterRaw = topic.substring(colonIdx + 1).trim();
    const after = afterRaw.split(/\s+/)[0]; // first word after colon

    const isValid = (s: string) =>
      s.length > 0 && !/\s/.test(s) && s.toLowerCase() !== "zoom" && !this.isSelf(s);

    if (isValid(before)) return before;
    if (isValid(after)) return after;
    return null;
  }

  /**
   * Parse the meeting date from Zoom's startTime string like
   * "Feb 23, 2026 08:33 AM Eastern Time (US and Canada)" → "2026-02-23"
   */
  parseMeetingDate(startTime: string): string {
    // Try ISO / YYYY-MM-DD first
    const isoMatch = startTime.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    // Try "Feb 23, 2026"
    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };
    const humanMatch = startTime.match(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/i);
    if (humanMatch) {
      const month = months[humanMatch[1].toLowerCase()] ?? "01";
      const day = humanMatch[2].padStart(2, "0");
      return `${humanMatch[3]}-${month}-${day}`;
    }

    // Fallback to today
    return new Date().toISOString().substring(0, 10);
  }

  /**
   * Returns true if the summary has at least some actual content to write.
   * Summaries with summaryStatus=0 or not-yet-generated AI text have empty
   * overallSummary, summaryItemVOs, and stepList.
   */
  hasSummaryContent(summary: ZoomSummaryData): boolean {
    // overallSummary is the canonical field; summaryOverview / summary_overview are
    // aliases returned by Zoom's internal API and mapped by getSummary().
    const overall = ((summary.overallSummary ?? summary.summaryOverview ?? summary.summary_overview) as string | undefined)?.trim();
    if (overall) return true;
    const sections = summary.summaryItemVOs as Array<{ label: string; summary: string }> | undefined;
    if (sections && sections.length > 0) return true;
    const steps = (summary.stepList ?? summary.next_steps) as string[] | undefined;
    if (steps && steps.length > 0) return true;
    return false;
  }

  /**
   * Returns true if the summary indicates an insufficient transcript (no summary will ever be generated).
   * Searches all string fields in the summary object for Zoom's error messages.
   */
  isTranscriptMissing(summary: ZoomSummaryData): boolean {
    const missingPatterns = [
      /insufficient transcript/i,
      /summary was not generated/i,
    ];
    for (const val of Object.values(summary as Record<string, unknown>)) {
      if (typeof val === "string" && missingPatterns.some(p => p.test(val))) {
        return true;
      }
    }
    return false;
  }

  /**
   * Format just the Zoom AI Summary content (no date header), indented at `baseIndent`.
   * Used both for standalone sections (baseIndent='') and for appending under an
   * existing same-day manual note block (baseIndent='\t').
   */
  private formatSummaryBody(summary: ZoomSummaryData, baseIndent: string, includeLabel = true): string {
    const i1 = baseIndent + "\t";
    const i2 = baseIndent + "\t\t";
    const lines: string[] = [];

    if (includeLabel) lines.push(`${baseIndent}Zoom AI Summary`);

    // Zoom's API may return the overview under different field names
    const overall = ((summary.overallSummary ?? summary.summaryOverview ?? summary.summary_overview) as string | undefined)?.trim();
    if (overall) lines.push(`${i1}${overall}`);

    const sections = summary.summaryItemVOs as Array<{ label: string; summary: string }> | undefined;
    if (sections && sections.length > 0) {
      lines.push(i1);
      for (const sec of sections) {
        lines.push(`${i1}${sec.label}`);
        for (const line of sec.summary.split(/\n+/)) {
          const trimmed = line.trim();
          if (trimmed) lines.push(`${i2}${trimmed}`);
        }
      }
    }

    // stepList (raw from API spread) or next_steps (mapped field name)
    const steps = (summary.stepList ?? summary.next_steps) as string[] | undefined;
    if (steps && steps.length > 0) {
      lines.push(i1);
      lines.push(`${i1}Next Steps`);
      for (const step of steps) lines.push(`${i2}- ${step.trim()}`);
    }

    // If nothing was written (Zoom has no summary for this meeting), say so explicitly
    if (!overall && (!sections || sections.length === 0) && (!steps || steps.length === 0)) {
      lines.push(`${i1}(No summary available)`);
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Format the summary as a standalone dated section (used only when the date
   * does not yet appear in the file at all).
   * 
   * If hasMeetingIdSuffix is true, appends " (ID: {meeting_id})" to the date header
   * to distinguish same-named meetings occurring on the same date.
   */
  formatSummarySection(dateStr: string, summary: ZoomSummaryData, hasMeetingIdSuffix = false): string {
    const headerDate = hasMeetingIdSuffix 
      ? `${dateStr} - Zoom AI Summary (ID: ${summary.meeting_id})`
      : `${dateStr} - Zoom AI Summary`;
    return `${headerDate}\n` + this.formatSummaryBody(summary, "", false);
  }

  /**
   * Insert the formatted section into the file at the correct chronological position
   * (newest-first), creating the file if it doesn't exist.
   * 
   * If another Zoom summary with the same date already exists, appends an ID suffix
   * to distinguish them (e.g., "2026-03-17 - Zoom AI Summary (ID: 12345)").
   */
  async insertSummary(
    filePath: string,
    dateStr: string,
    summary: ZoomSummaryData
  ): Promise<{ inserted: boolean; position: "top" | "middle" | "end"; filePath: string }> {
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      // File doesn't exist — create with standalone section
      const newSection = this.formatSummarySection(dateStr, summary, false);
      await writeFile(filePath, newSection, "utf-8");
      return { inserted: true, position: "top", filePath };
    }

    // Idempotency: already written with actual content — skip
    // But allow rewrite if a bare header exists with no body (previous bug)
    const headerRegex = new RegExp(
      `^${dateStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - Zoom AI Summary`,
      "m"
    );
    const hasHeader = headerRegex.test(content) || this.dateBlockContains(content, dateStr, "Zoom AI Summary");
    if (hasHeader && !this.zoomBlockIsEmpty(content, dateStr)) {
      return { inserted: false, position: "top", filePath };
    }

    // If a bare header exists with no body, strip it so we can rewrite cleanly
    if (hasHeader && this.zoomBlockIsEmpty(content, dateStr)) {
      content = content.replace(/^.*\d{4}-\d{2}-\d{2}.*Zoom AI Summary.*\n(\n)?/m, "").trimStart();
      // If the file becomes empty after stripping, write fresh
      if (!content.trim()) {
        const newSection = this.formatSummarySection(dateStr, summary, false);
        await writeFile(filePath, newSection, "utf-8");
        return { inserted: true, position: "top", filePath };
      }
    }

    const lines = content.split("\n");
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;

    // Check if another Zoom summary with the same date already exists in the file
    const existingSameDateZoomHeaderRegex = new RegExp(
      `^${dateStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - Zoom AI Summary`
    );
    const hasSameDateZoom = lines.some((l) => existingSameDateZoomHeaderRegex.test(l));

    // Check if the same date already exists (for manual notes) — if so, append under it
    const sameDateIdx = lines.findIndex(
      (l) => l.startsWith(dateStr) && dateRegex.test(l)
    );

    if (sameDateIdx !== -1 && !hasSameDateZoom) {
      // Find end of this date's block (next line at level 0 matching a date, or EOF)
      let blockEnd = lines.length;
      for (let i = sameDateIdx + 1; i < lines.length; i++) {
        if (dateRegex.test(lines[i])) {
          blockEnd = i;
          break;
        }
      }
      // Trim trailing blank lines from the block, then append Zoom body indented one level
      let trimEnd = blockEnd;
      while (trimEnd > sameDateIdx + 1 && lines[trimEnd - 1].trim() === "") trimEnd--;

      const body = this.formatSummaryBody(summary, "\t");
      const before = lines.slice(0, trimEnd).join("\n");
      const after  = lines.slice(blockEnd).join("\n");
      const newContent = before + "\n\n" + body + (after ? "\n" + after : "");
      await writeFile(filePath, newContent, "utf-8");
      return { inserted: true, position: "middle", filePath };
    }

    // Date not present, or same-date Zoom summary already exists
    // If same-date Zoom summary exists, add ID suffix to distinguish
    const needsIdSuffix = hasSameDateZoom;
    const newSection = this.formatSummarySection(dateStr, summary, needsIdSuffix);
    let insertLineIdx: number | null = null;
    for (let i = 0; i < lines.length; i++) {
      if (dateRegex.test(lines[i])) {
        const existingDate = lines[i].substring(0, 10);
        if (existingDate <= dateStr) {
          insertLineIdx = i;
          break;
        }
      }
    }

    let newContent: string;
    let position: "top" | "middle" | "end";

    if (insertLineIdx === null) {
      newContent = content.trimEnd() + "\n\n" + newSection;
      position = "end";
    } else if (insertLineIdx === 0) {
      newContent = newSection + "\n" + content;
      position = "top";
    } else {
      const before = lines.slice(0, insertLineIdx).join("\n");
      const after  = lines.slice(insertLineIdx).join("\n");
      newContent = before.trimEnd() + "\n\n" + newSection + "\n" + after;
      position = "middle";
    }

    await writeFile(filePath, newContent, "utf-8");
    return { inserted: true, position, filePath };
  }

  /** Check if the block belonging to `dateStr` contains `marker` on an indented line. */
  private dateBlockContains(content: string, dateStr: string, marker: string): boolean {
    const lines = content.split("\n");
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    let inBlock = false;
    for (const line of lines) {
      if (line.startsWith(dateStr) && dateRegex.test(line)) { inBlock = true; continue; }
      if (inBlock) {
        if (dateRegex.test(line)) break; // next date block started
        if (line.includes(marker)) return true;
      }
    }
    return false;
  }

  /**
   * Returns true if the Zoom AI Summary header line for `dateStr` exists but
   * has no indented body underneath it (a bare/empty header from a previous bug).
   */
  private zoomBlockIsEmpty(content: string, dateStr: string): boolean {
    const lines = content.split("\n");
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`${dateStr} - Zoom AI Summary`)) {
        // Check the next non-blank line: if it's another date or EOF, the block is empty
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.trim() === "") continue;
          // Has indented content → not empty
          if (next.startsWith("\t") || /^\s+\S/.test(next)) return false;
          // Another date or un-indented content → block was bare
          return true;
        }
        return true; // nothing after the header → bare
      }
    }
    return false;
  }

  /**
   * High-level: find the right file for a meeting topic and insert the summary.
   * Creates the file if no existing note is found.
   */
  async writeSummary(
    summary: ZoomSummaryData,
    options: { dryRun?: boolean } = {}
  ): Promise<{
    success: boolean;
    message: string;
    filePath?: string;
    action?: "wrote" | "skipped_duplicate" | "would_write" | "would_create" | "no_match" | "created";
  }> {
    const topic = (summary.topic ?? summary.meeting_topic ?? "") as string;
    const dateStr = this.parseMeetingDate((summary.startTime ?? "") as string);

    // Extract attendee names from next step assignees AND participants list
    const attendeeNames: string[] = [];
    const items = summary.nextStepItems as Array<{ assignees?: Array<{ username?: string }> }> | undefined;
    if (items) {
      for (const item of items) {
        for (const a of item.assignees ?? []) {
          if (a.username && !attendeeNames.includes(a.username)) {
            attendeeNames.push(a.username);
          }
        }
      }
    }
    // Also check participants / attendees field (Zoom API returns full names here)
    const participants = (summary.participants ?? summary.attendees ?? summary.attendeeList) as Array<{ name?: string; userName?: string; displayName?: string }> | undefined;
    if (participants) {
      for (const p of participants) {
        const name = p.name ?? p.userName ?? p.displayName;
        if (name && !attendeeNames.includes(name)) attendeeNames.push(name);
      }
    }

    // Skip multi-person meetings (more than 1 non-owner attendee = not a 1:1)
    const otherAttendees = attendeeNames.filter(
      (n) => !this.isSelf(n) && !/\d/.test(n)
    );
    if (otherAttendees.length > 1) {
      return {
        success: false,
        message: `"${topic}" has ${otherAttendees.length} non-owner attendees — skipping multi-person meeting.`,
        action: "no_match",
      };
    }

    // Fallback: check topic for 3+ colon-separated names (e.g. "Gaetan:Howard:Tony")
    const topicParts = topic.split(":").map((s) => s.trim()).filter(Boolean);
    const topicNonOwner = topicParts.filter((p) => /[a-zA-Z]{2,}/.test(p) && !this.isSelf(p));
    if (topicNonOwner.length > 1) {
      return {
        success: false,
        message: `"${topic}" has multiple people in topic — skipping multi-person meeting.`,
        action: "no_match",
      };
    }

    let filePath = await this.findPersonFile(topic, attendeeNames);
    let willCreate = false;

    if (!filePath) {
      const suggested = this.suggestNewFilePath(topic, attendeeNames);
      if (!suggested) {
        return {
          success: false,
          message: `No matching file and no suitable name for "${topic}" — skipped.`,
          action: "no_match",
        };
      }
      filePath = suggested;
      willCreate = true;
    }

    if (options.dryRun) {
      const action = willCreate ? "would_create" : "would_write";
      const fileLabel = path.relative(this.vaultPath, filePath);
      return {
        success: true,
        message: willCreate
          ? `WOULD CREATE ${fileLabel} and insert ${dateStr}`
          : `WOULD INSERT into ${fileLabel} at ${dateStr}`,
        filePath,
        action,
      };
    }

    const result = await this.insertSummary(filePath, dateStr, summary);

    // If a new file was created, bust the cache so subsequent lookups find it
    if (willCreate && result.inserted) {
      this._fileCache = null;
    }

    if (!result.inserted) {
      return {
        success: true,
        message: `Summary for ${topic} on ${dateStr} already exists in ${path.basename(filePath)} — skipped.`,
        filePath: result.filePath,
        action: "skipped_duplicate",
      };
    }

    return {
      success: true,
      message: `${willCreate ? "Created" : "Wrote"} summary for "${topic}" (${dateStr}) into ${path.basename(filePath)} at position: ${result.position}.`,
      filePath: result.filePath,
      action: willCreate ? "created" : "wrote",
    };
  }
}
