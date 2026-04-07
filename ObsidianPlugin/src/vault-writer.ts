/**
 * Vault writer — inserts Zoom meeting summaries into Obsidian vault files.
 *
 * Ported from the MCP server's ObsidianClient class. All file I/O uses the
 * Obsidian Vault API instead of Node.js fs.
 *
 * Key behaviors (same as original):
 * - Files are searched in configurable 1:1 folders within an optional subfolder.
 * - Match priority: exact full name → starts-with first name → contains first name.
 * - Summaries inserted in newest-first chronological order.
 * - Same-date merge: Zoom summary appended under existing manual notes.
 * - Idempotency: duplicate summaries detected and skipped.
 */

import { type App, TFile, TFolder, normalizePath } from "obsidian";
import type { ZoomSummaryData } from "./types";

const DEFAULT_ONE_ON_ONE_FOLDERS = [
  "! One on Ones",
  "! One on Ones (Other)",
];

export class VaultWriter {
  private app: App;
  private vaultSubfolder: string;
  private oneOnOneFolders: string[];
  private _fileCache: { name: string; path: string }[] | null = null;
  private fileContentCache = new Map<string, string>();

  constructor(
    app: App,
    opts?: { vaultSubfolder?: string; oneOnOneFolders?: string[] }
  ) {
    this.app = app;
    this.vaultSubfolder = opts?.vaultSubfolder ?? "";
    this.oneOnOneFolders = opts?.oneOnOneFolders ?? DEFAULT_ONE_ON_ONE_FOLDERS;
  }

  /** Invalidate cached file list (call after settings change). */
  clearCache(): void {
    this._fileCache = null;
  }

  /**
   * Sanitize a filename by replacing invalid characters with dashes.
   * Invalid characters: < > : " / \ | ? *
   */
  private sanitizeFilename(name: string): string {
    return name.replace(/[<>:"\/\\|?*]/g, "-").trim();
  }

  /**
   * Load (and cache) all .md files from the 1:1 folders.
   * Returns objects with `name` (no extension) and vault-relative `path`.
   */
  async allFiles(): Promise<{ name: string; path: string }[]> {
    if (this._fileCache) return this._fileCache;

    const results: { name: string; path: string }[] = [];

    for (const folder of this.oneOnOneFolders) {
      const folderPath = this.vaultSubfolder
        ? normalizePath(`${this.vaultSubfolder}/${folder}`)
        : normalizePath(folder);

      const abstract = this.app.vault.getAbstractFileByPath(folderPath);
      if (!(abstract instanceof TFolder)) continue;

      for (const child of abstract.children) {
        if (child instanceof TFile && child.extension === "md") {
          results.push({ name: child.basename, path: child.path });
        }
      }
    }

    this._fileCache = results;
    return results;
  }

  /**
   * Given a Zoom meeting topic like "Amit:Howard" or "Jeremy:Howard 1:1",
   * and optionally a list of attendee full names, find the best matching
   * .md file in the 1:1 folders.
   *
   * Match priority:
   *  0. Exact full attendee name matches file name
   *  1. File name starts with topic first name (prefer solo over shared)
   *  2. File name starts with any attendee first name
   *  3. File name contains first name as word boundary
   */
  async findPersonFile(
    meetingTopic: string,
    attendeeNames?: string[]
  ): Promise<string | null> {
    const topicFirst = this.extractFirstName(meetingTopic);
    const files = await this.allFiles();
    const norm = (s: string) => s.toLowerCase().trim();

    // Non-Howard attendees
    const nonHowardAttendees = (attendeeNames ?? []).filter(
      (n) => !/howard/i.test(n)
    );

    // Priority 0: exact full attendee name matches file name
    for (const fullName of nonHowardAttendees) {
      const match = files.find((f) => norm(f.name) === norm(fullName));
      if (match) return match.path;
    }

    // Build candidate first-names
    const attendeeFirstNames = nonHowardAttendees
      .map((n) => n.split(/\s+/)[0])
      .filter(Boolean);
    const candidateFirstNames = [
      ...(topicFirst ? [topicFirst] : []),
      ...attendeeFirstNames,
    ].filter(Boolean);

    // Priority 1 & 2: file name starts with any candidate first name
    for (const first of candidateFirstNames) {
      const matches = files.filter((f) =>
        norm(f.name).startsWith(norm(first))
      );
      if (matches.length === 0) continue;
      if (matches.length === 1) return matches[0].path;
      const solo = matches.find((f) => !/[+&/]|  /.test(f.name));
      return (solo ?? matches[0]).path;
    }

    // Priority 3: file name contains first name as word
    for (const first of candidateFirstNames) {
      const re = new RegExp(`\\b${first}\\b`, "i");
      const match = files.find((f) => re.test(f.name));
      if (match) return match.path;
    }

    return null;
  }

  /**
   * Suggest a vault-relative path for a new 1:1 note file.
   */
  suggestNewFilePath(
    meetingTopic: string,
    attendeeNames?: string[]
  ): string | null {
    const newFilesFolder =
      this.oneOnOneFolders[1] ?? this.oneOnOneFolders[0] ?? "! One on Ones (Other)";
    const base = this.vaultSubfolder
      ? `${this.vaultSubfolder}/${newFilesFolder}`
      : newFilesFolder;

    const best = (attendeeNames ?? []).find((n) => !/howard/i.test(n));
    if (best) return normalizePath(`${base}/${best}.md`);

    const first = this.extractFirstName(meetingTopic);
    if (!first) return null;
    return normalizePath(`${base}/${first}.md`);
  }

  private extractFirstName(topic: string): string | null {
    const colonIdx = topic.indexOf(":");
    if (colonIdx <= 0) return null;
    const firstName = topic.substring(0, colonIdx).trim();
    if (/\s/.test(firstName) || firstName.toLowerCase() === "zoom") return null;
    return firstName;
  }

  /**
   * Parse Zoom's startTime into "YYYY-MM-DD".
   */
  parseMeetingDate(startTime: string): string {
    // ISO: 2026-03-31 or 2026-03-31T...
    const isoMatch = startTime.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

    const months: Record<string, string> = {
      jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
      jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
    };

    // "Mar 31, 2026" or "March 31, 2026"
    const humanMatch = startTime.match(/([A-Za-z]{3,})\s+(\d{1,2}),\s+(\d{4})/);
    if (humanMatch) {
      const month = months[humanMatch[1].toLowerCase().substring(0, 3)] ?? "01";
      const day = humanMatch[2].padStart(2, "0");
      return `${humanMatch[3]}-${month}-${day}`;
    }

    // MM/DD/YYYY or M/D/YYYY (Zoom web UI table format)
    const slashMatch = startTime.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (slashMatch) {
      return `${slashMatch[3]}-${slashMatch[1].padStart(2, "0")}-${slashMatch[2].padStart(2, "0")}`;
    }

    return new Date().toISOString().substring(0, 10);
  }

  /**
   * Returns true if the summary has at least some actual content to write.
   */
  hasSummaryContent(summary: ZoomSummaryData): boolean {
    const overall = (
      (summary.overallSummary ?? summary.summaryOverview ?? summary.summary_overview) as
        | string
        | undefined
    )?.trim();
    if (overall) return true;
    const sections = summary.summaryItemVOs;
    if (sections && sections.length > 0) return true;
    const steps = (summary.stepList ?? summary.next_steps);
    if (steps && steps.length > 0) return true;
    return false;
  }

  /**
   * Format the Zoom AI Summary body (no date header), indented at baseIndent.
   */
  private formatSummaryBody(
    summary: ZoomSummaryData,
    baseIndent: string,
    includeLabel = true
  ): string {
    const i1 = baseIndent + "\t";
    const i2 = baseIndent + "\t\t";
    const lines: string[] = [];

    if (includeLabel) lines.push(`${baseIndent}Zoom AI Summary`);

    const overall = (
      (summary.overallSummary ?? summary.summaryOverview ?? summary.summary_overview) as
        | string
        | undefined
    )?.trim();
    if (overall) lines.push(`${i1}${overall}`);

    const sections = summary.summaryItemVOs;
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

    const steps = (summary.stepList ?? summary.next_steps);
    if (steps && steps.length > 0) {
      lines.push(i1);
      lines.push(`${i1}Next Steps`);
      for (const step of steps) lines.push(`${i2}- ${step.trim()}`);
    }

    if (
      !overall &&
      (!sections || sections.length === 0) &&
      (!steps || steps.length === 0)
    ) {
      lines.push(`${i1}(No summary available)`);
    }

    lines.push("");
    return lines.join("\n");
  }

  /**
   * Format the summary as a standalone dated section.
   *
   * If hasMeetingIdSuffix is true, appends " (ID: {meeting_id})" to the date header
   * to distinguish same-named meetings occurring on the same date.
   */
  formatSummarySection(dateStr: string, summary: ZoomSummaryData, hasMeetingIdSuffix = false): string {
    const headerDate = hasMeetingIdSuffix 
      ? `${dateStr} - Zoom AI Summary (ID: ${summary.meeting_id})`
      : `${dateStr} - Zoom AI Summary`;
    return (
      `${headerDate}\n` +
      this.formatSummaryBody(summary, "", false)
    );
  }

  /**
   * Insert the formatted summary into the file at the correct chronological
   * position (newest-first), creating the file if it doesn't exist.
   *
   * If another Zoom summary with the same date already exists, appends an ID suffix
   * to distinguish them (e.g., "2026-03-17 - Zoom AI Summary (ID: 12345)").
   *
   * Returns { inserted, position, filePath }.
   */
  async insertSummary(
    filePath: string,
    dateStr: string,
    summary: ZoomSummaryData
  ): Promise<{
    inserted: boolean;
    position: "top" | "middle" | "end";
    filePath: string;
  }> {
    const normalizedPath = normalizePath(filePath);
    let content: string;
    // Track whether we have a TFile reference (for vault.modify) or need adapter.write
    let existingFile: TFile | null = null;

    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (abstractFile instanceof TFile) {
      existingFile = abstractFile;
      content = await this.app.vault.read(existingFile);
    } else if (await this.app.vault.adapter.exists(normalizedPath)) {
      // File exists on disk but isn't in Obsidian's index (e.g. dot-files like .Net)
      content = await this.app.vault.adapter.read(normalizedPath);
    } else {
      // File doesn't exist — create with standalone section
      const newSection = this.formatSummarySection(dateStr, summary, false);
      await this.ensureParentFolder(normalizedPath);
      await this.app.vault.create(normalizedPath, newSection);
      return { inserted: true, position: "top", filePath: normalizedPath };
    }

    // Helper to write content — uses vault.modify when we have a TFile, adapter.write otherwise
    const writeContent = async (data: string) => {
      if (existingFile) {
        await this.app.vault.modify(existingFile, data);
      } else {
        await this.app.vault.adapter.write(normalizedPath, data);
      }
    };

    // Idempotency: already written with content — skip, unless this is a different meeting on the same day
    const headerRegex = new RegExp(
      `^${dateStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - Zoom AI Summary`,
      "m"
    );
    const hasHeader = headerRegex.test(content) || this.dateBlockContains(content, dateStr, "Zoom AI Summary");
    if (hasHeader && !this.zoomBlockIsEmpty(content, dateStr)) {
      // If this exact meeting ID is already written, skip (idempotent re-sync)
      // Otherwise fall through — hasSameDateZoom below will trigger ID-suffix insertion
      const meetingId = String(summary.meeting_id ?? "");
      if (!meetingId || content.includes(`(ID: ${meetingId})`)) {
        return { inserted: false, position: "top", filePath: normalizedPath };
      }
    }

    // Strip empty or placeholder block so real content can be inserted cleanly
    if (hasHeader && this.zoomBlockIsEmpty(content, dateStr)) {
      content = this.stripZoomBlock(content, dateStr);
      if (!content.trim()) {
        const newSection = this.formatSummarySection(dateStr, summary, false);
        await writeContent(newSection);
        return { inserted: true, position: "top", filePath: normalizedPath };
      }
    }

    const lines = content.split("\n");
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;

    // Check if another Zoom summary with the same date already exists in the file
    const existingSameDateZoomHeaderRegex = new RegExp(
      `^${dateStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - Zoom AI Summary`
    );
    const hasSameDateZoom = lines.some((l) => existingSameDateZoomHeaderRegex.test(l));

    // Same-date merge
    const sameDateIdx = lines.findIndex(
      (l) => l.startsWith(dateStr) && dateRegex.test(l)
    );

    if (sameDateIdx !== -1 && !hasSameDateZoom) {
      let blockEnd = lines.length;
      for (let i = sameDateIdx + 1; i < lines.length; i++) {
        if (dateRegex.test(lines[i])) {
          blockEnd = i;
          break;
        }
      }
      let trimEnd = blockEnd;
      while (
        trimEnd > sameDateIdx + 1 &&
        lines[trimEnd - 1].trim() === ""
      )
        trimEnd--;

      const body = this.formatSummaryBody(summary, "\t");
      const before = lines.slice(0, trimEnd).join("\n");
      const after = lines.slice(blockEnd).join("\n");
      const newContent = before + "\n\n" + body + (after ? "\n" + after : "");
      await writeContent(newContent);
      return { inserted: true, position: "middle", filePath: normalizedPath };
    }

    // Chronological insertion (newest-first)
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
      const after = lines.slice(insertLineIdx).join("\n");
      newContent = before.trimEnd() + "\n\n" + newSection + "\n" + after;
      position = "middle";
    }

    await writeContent(newContent);
    return { inserted: true, position, filePath: normalizedPath };
  }

  /** Ensure all parent folders exist for a vault path. */
  private async ensureParentFolder(filePath: string): Promise<void> {
    const parts = filePath.split("/");
    parts.pop(); // remove file name
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }

  private dateBlockContains(
    content: string,
    dateStr: string,
    marker: string
  ): boolean {
    const lines = content.split("\n");
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    let inBlock = false;
    for (const line of lines) {
      if (line.startsWith(dateStr) && dateRegex.test(line)) {
        inBlock = true;
        continue;
      }
      if (inBlock) {
        if (dateRegex.test(line)) break;
        if (line.includes(marker)) return true;
      }
    }
    return false;
  }

  private zoomBlockIsEmpty(content: string, dateStr: string): boolean {
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`${dateStr} - Zoom AI Summary`)) {
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (/^\d{4}-\d{2}-\d{2}/.test(next)) break;
          if (next.trim()) blockLines.push(next.trim());
        }
        if (blockLines.length === 0) return true;
        // Treat a placeholder-only block as empty so real content can replace it
        return blockLines.every((l) => l === "(No summary available)");
      }
    }
    return false;
  }

  /** Remove an entire Zoom summary block (header + body) for the given date. */
  private stripZoomBlock(content: string, dateStr: string): string {
    const lines = content.split("\n");
    const blockStart = lines.findIndex((l) =>
      l.includes(`${dateStr} - Zoom AI Summary`)
    );
    if (blockStart === -1) return content;

    let blockEnd = lines.length;
    for (let i = blockStart + 1; i < lines.length; i++) {
      if (/^\d{4}-\d{2}-\d{2}/.test(lines[i])) {
        blockEnd = i;
        break;
      }
    }
    // Consume trailing blank lines that belong to the block
    while (blockEnd < lines.length && lines[blockEnd].trim() === "") blockEnd++;

    return [...lines.slice(0, blockStart), ...lines.slice(blockEnd)]
      .join("\n")
      .trimStart();
  }

  clearFileCache(): void {
    this.fileContentCache.clear();
  }

  /**
   * Check if a vault file already contains a non-empty Zoom AI Summary for the given date.
   * Used to skip expensive network fetches for meetings already written.
   */
  async hasExistingSummary(filePath: string, dateStr: string): Promise<boolean> {
    const normalizedPath = normalizePath(filePath);
    let content: string | undefined = this.fileContentCache.get(normalizedPath);

    if (content === undefined) {
      const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (abstractFile instanceof TFile) {
        content = await this.app.vault.read(abstractFile);
      } else if (await this.app.vault.adapter.exists(normalizedPath)) {
        content = await this.app.vault.adapter.read(normalizedPath);
      } else {
        return false;
      }
      this.fileContentCache.set(normalizedPath, content);
    }

    const headerRegex = new RegExp(
      `^${dateStr.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} - Zoom AI Summary`,
      "m"
    );
    const hasHeader = headerRegex.test(content) || this.dateBlockContains(content, dateStr, "Zoom AI Summary");
    return hasHeader && !this.zoomBlockIsEmpty(content, dateStr);
  }
}
