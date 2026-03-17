/**
 * Sync orchestrator — coordinates listing, fetching, writing, and deleting
 * Zoom meeting summaries into the Obsidian vault.
 *
 * Ported from zoom-meetings-to-obsidian.mjs 7-phase workflow:
 *   1. List meetings from Zoom
 *   2. Resolve attendees for ambiguous matches
 *   3. Build plan (insert / create / skip)
 *   4. Pre-fetch nav IDs + full summaries
 *   5. Write summaries to vault
 *   6. Delete from Zoom (optional)
 *   7. Report results
 */

import { Notice } from "obsidian";
import type { ZoomClient } from "./zoom-client";
import type { VaultWriter } from "./vault-writer";
import type { MeetingSummaryItem, MeetingSummaryDetail, ZoomSummaryData } from "./types";

export interface SyncPlanEntry {
  topic: string;
  rawId: string;
  parsedDate: string;
  /** Raw date text from the table row, used to disambiguate recurring instances. */
  dateHint: string;
  /** Composite key for recurring instances: rawId__parsedDate */
  instanceKey: string;
  vaultFile: string | null;
  action: "insert" | "create" | "skip";
}

export interface SyncResult {
  topic: string;
  file?: string;
  status: string;
}

export interface SyncReport {
  results: SyncResult[];
  written: number;
  skipped: number;
  errors: number;
  deleted: number;
  deleteFailed: number;
  /** Updated scan timestamps — caller should persist these. */
  updatedLastProcessedOwned?: string;
  updatedLastProcessedShared?: string;
}

export class SyncOrchestrator {
  private client: ZoomClient;
  private writer: VaultWriter;
  private debug: boolean;
  private sharedMeetingsFolder?: string;

  // In-memory caches (same pattern as the standalone script)
  private attendeesCache: Record<string, string[]> = {};
  private summaryCache: Record<string, MeetingSummaryDetail> = {};

  /** Progress callback for UI updates. */
  onProgress?: (message: string) => void;

  /** Last-processed timestamps for incremental scans. */
  private lastProcessedOwned?: string;
  private lastProcessedShared?: string;

  constructor(
    client: ZoomClient,
    writer: VaultWriter,
    opts?: {
      debug?: boolean;
      sharedMeetingsFolder?: string;
      lastProcessedOwned?: string;
      lastProcessedShared?: string;
    }
  ) {
    this.client = client;
    this.writer = writer;
    this.debug = opts?.debug ?? false;
    this.sharedMeetingsFolder = opts?.sharedMeetingsFolder;
    this.lastProcessedOwned = opts?.lastProcessedOwned;
    this.lastProcessedShared = opts?.lastProcessedShared;
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.log("[sync]", ...args);
  }

  private progress(msg: string): void {
    this.dbg(msg);
    this.onProgress?.(msg);
  }

  /**
   * Run the full sync workflow. Returns a report of all actions taken.
   * Processes both owned and shared meetings (if configured).
   *
   * @param opts.filter   — Optional topic substring filter.
   * @param opts.autoDelete — If true, delete summaries from Zoom after writing.
   */
  async run(opts?: {
    filter?: string;
    autoDelete?: boolean;
  }): Promise<SyncReport> {
    const filter = opts?.filter ?? "";
    const autoDelete = opts?.autoDelete ?? false;

    // Reset caches for this run
    this.attendeesCache = {};
    this.summaryCache = {};

    const allResults: SyncResult[] = [];
    let totalWritten = 0,
      totalSkipped = 0,
      totalErrors = 0,
      totalDeleted = 0,
      totalDeleteFailed = 0;

    const hasSharedFolder = !!this.sharedMeetingsFolder?.trim();
    const runTimestamp = new Date().toISOString();

    this.dbg(`[scan-dates] Run starting at ${runTimestamp}`);
    this.dbg(`[scan-dates] lastProcessedOwned=${this.lastProcessedOwned ?? "(none)"}, lastProcessedShared=${this.lastProcessedShared ?? "(none)"}`);
    this.dbg(`[scan-dates] filter=${filter || "(none)"}, autoDelete=${autoDelete}, hasSharedFolder=${hasSharedFolder}`);

    // Process owned meetings only when shared-only mode is not enabled.
    if (!hasSharedFolder) {
      this.progress("Processing owned Zoom meetings...");
      const ownedReport = await this.processMeetingSource(
        "owned",
        filter,
        autoDelete,
        this.writer,
        this.lastProcessedOwned
      );
      allResults.push(...ownedReport.results);
      totalWritten += ownedReport.written;
      totalSkipped += ownedReport.skipped;
      totalErrors += ownedReport.errors;
      totalDeleted += ownedReport.deleted;
      totalDeleteFailed += ownedReport.deleteFailed;
    }

    // Process shared meetings when folder is configured.
    if (hasSharedFolder) {
      this.progress("Processing shared Zoom meetings...");
      try {
        // Create a VaultWriter context for shared meetings folder
        const sharedMeetingsWriter = new (this.writer.constructor as any)(
          (this.writer as any).app,
          {
            vaultSubfolder: "", // shared meetings are in the dedicated folder, not in vault subfolder
            oneOnOneFolders: [this.sharedMeetingsFolder.trim()],
          }
        );
        const sharedReport = await this.processMeetingSource(
          "shared",
          filter,
          false, // never auto-delete shared meetings (Zoom API limitation)
          sharedMeetingsWriter,
          this.lastProcessedShared
        );
        allResults.push(...sharedReport.results);
        totalWritten += sharedReport.written;
        totalSkipped += sharedReport.skipped;
        totalErrors += sharedReport.errors;
        // Note: skip delete stats for shared (they're never deleted)
      } catch (e) {
        this.progress(
          `Skipping shared meetings: ${(e as Error).message}`
        );
      }
    }

    // Combine and report
    const report: SyncReport = {
      results: allResults,
      written: totalWritten,
      skipped: totalSkipped,
      errors: totalErrors,
      deleted: totalDeleted,
      deleteFailed: totalDeleteFailed,
    };

    // Update scan timestamps.
    // Owned: only advance when autoDelete is enabled (meetings are removed from
    // Zoom, so they won't appear on the next list). Without delete, the same
    // meetings persist and the timestamp must stay so they're re-scanned.
    // Shared: only advance when NO topic filter is active, because a filter
    // would skip non-matching meetings that haven't been processed yet.
    // Shared meetings are never deleted, but each is written idempotently.
    if (!hasSharedFolder && autoDelete) {
      report.updatedLastProcessedOwned = runTimestamp;
      this.dbg(`[scan-dates] Will advance lastProcessedOwned → ${runTimestamp}`);
    } else if (!hasSharedFolder) {
      this.dbg(`[scan-dates] NOT advancing lastProcessedOwned (autoDelete is off)`);
    }
    if (hasSharedFolder && !filter) {
      report.updatedLastProcessedShared = runTimestamp;
      this.dbg(`[scan-dates] Will advance lastProcessedShared → ${runTimestamp}`);
    } else if (hasSharedFolder) {
      this.dbg(`[scan-dates] NOT advancing lastProcessedShared (topic filter is active)`);
    }

    const summary =
      `Sync complete: ${totalWritten} written, ${totalSkipped} skipped, ${totalErrors} errors` +
      (autoDelete
        ? `, ${totalDeleted} deleted, ${totalDeleteFailed} delete failures`
        : "");
    this.progress(summary);
    new Notice(summary);

    return report;
  }

  /**
   * Process meetings from a single source (owned or shared).
   * Executes the 7-phase workflow for the given source.
   */
  private async processMeetingSource(
    sourceType: "owned" | "shared",
    filter: string,
    autoDelete: boolean,
    writer: VaultWriter,
    fromDate?: string
  ): Promise<SyncReport> {
    const extractMeetingId = (m: MeetingSummaryItem): string => {
      const candidates = [
        m.meeting_id,
        (m as Record<string, unknown>).column_2,
        (m as Record<string, unknown>).column_3,
        (m as Record<string, unknown>).column_4,
        (m as Record<string, unknown>).column_1,
      ];
      for (const c of candidates) {
        const raw = (c ?? "").toString().trim();
        if (!raw) continue;
        const digits = raw.replace(/\D/g, "");
        if (digits.length >= 9 && digits.length <= 14) return digits;
      }
      return "";
    };

    const sanitizeFileStem = (value: string): string => {
      const stem = value
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      return stem || "Untitled Meeting";
    };

    // Phase 1: list meetings
    this.progress(`Listing ${sourceType} meeting summaries...`);
    const listOpts: { from?: string } = {};
    if (fromDate) {
      listOpts.from = fromDate;
      this.dbg(`[list] Using fromDate=${fromDate} for ${sourceType}`);
    }
    const allMeetings = await this.client.listSummaries(sourceType as any, listOpts);
    const meetings = filter
      ? allMeetings.filter((m) =>
          (m.meeting_topic ?? (m as Record<string, unknown>).column_1 ?? "")
            .toString()
            .toLowerCase()
            .includes(filter.toLowerCase())
        )
      : allMeetings;
    this.progress(
      `  Found ${allMeetings.length} ${sourceType} meetings${filter ? `, ${meetings.length} match filter "${filter}"` : ""}.`
    );

    const allFiles = await writer.allFiles();

    // Helper: check if first name matches multiple files (ambiguous)
    const isAmbiguousMatch = (firstName: string | null): boolean => {
      if (!firstName) return false;
      return (
        allFiles.filter((f) =>
          f.name.toLowerCase().startsWith(firstName.toLowerCase())
        ).length > 1
      );
    };

    // Phase 2: resolve attendees for ambiguous/unmatched meetings
    this.progress("Resolving attendees...");
    const attendeesMap = new Map<string, string[]>(
      Object.entries(this.attendeesCache)
    );
    const toFetchAttendees = new Map<string, string>();

    for (const m of meetings) {
      const topic = (
        m.meeting_topic ??
        (m as Record<string, unknown>).column_1 ??
        ""
      )
        .toString()
        .replace(/^Select /, "");
      const rawId = extractMeetingId(m);

      if (sourceType === "shared") {
        continue;
      }

      const topicFirst = topic.split(":")[0].trim();
      const isCandidate =
        (topic.includes(":") &&
          !topicFirst.includes(" ") &&
          topicFirst.toLowerCase() !== "zoom") ||
        /^zoom meeting$/i.test(topic);

      if (
        !isCandidate ||
        !rawId ||
        attendeesMap.has(rawId) ||
        toFetchAttendees.has(rawId)
      )
        continue;

      const quickMatch = allFiles.find((f) =>
        f.name.toLowerCase().startsWith(topicFirst.toLowerCase())
      );
      if (!quickMatch || isAmbiguousMatch(topicFirst))
        toFetchAttendees.set(rawId, topic);
    }

    for (const [rawId, topic] of toFetchAttendees) {
      this.progress(`  Fetching attendees: ${topic} (${rawId})...`);
      try {
        const data = await this.client.getSummary(rawId, sourceType);
        const names: string[] = [];
        for (const item of (data?.nextStepItems ?? data?.next_step_items ?? []) as Array<{
          assignees?: Array<{ username?: string }>;
        }>) {
          for (const a of item.assignees ?? []) {
            if (a.username && !names.includes(a.username)) names.push(a.username);
          }
        }
        attendeesMap.set(rawId, names);
        this.attendeesCache[rawId] = names;
        if (!this.summaryCache[rawId]) this.summaryCache[rawId] = data;
      } catch (e) {
        this.progress(`  Error fetching attendees for ${rawId}: ${(e as Error).message}`);
        attendeesMap.set(rawId, []);
      }
    }

    // Phase 3: build plan
    this.progress("Building sync plan...");
    const plan: SyncPlanEntry[] = [];

    for (const m of meetings) {
      const topic = (
        m.meeting_topic ??
        (m as Record<string, unknown>).column_1 ??
        ""
      )
        .toString()
        .replace(/^Select /, "");
      const rawId = extractMeetingId(m);
      // Owned table: topic(0)/date(1)/ID(2). Shared table: topic(0)/ID(1)/owner(2)/date(3).
      const dateCol = sourceType === 'shared' ? 'column_3' : 'column_1';
      const date = ((m as Record<string, unknown>)[dateCol] ?? "").toString().trim();
      const attendees = attendeesMap.get(rawId) ?? [];
      const parsedDate = writer.parseMeetingDate(date);
      const instanceKey = `${rawId}__${parsedDate}`;

      this.dbg(`[plan] topic="${topic}" rawId=${rawId} dateCol=${dateCol} rawDate="${date}" parsedDate=${parsedDate} instanceKey=${instanceKey} cols={c0=${(m as any).column_0?.toString().substring(0,30)}, c1=${(m as any).column_1?.toString().substring(0,30)}, c2=${(m as any).column_2?.toString().substring(0,30)}, c3=${(m as any).column_3?.toString().substring(0,30)}, c4=${(m as any).column_4}}`);

      if (!rawId) {
        plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: null, action: "skip" });
        continue;
      }

      if (sourceType === "shared") {
        const sharedFolder = this.sharedMeetingsFolder?.trim() ?? "";
        const targetPath = `${sharedFolder}/${sanitizeFileStem(topic)}.md`;
        const existing = allFiles.find(
          (f) => f.path.toLowerCase() === targetPath.toLowerCase()
        );
        plan.push({
          topic,
          rawId,
          parsedDate,
          dateHint: date,
          instanceKey,
          vaultFile: existing?.path ?? targetPath,
          action: existing ? "insert" : "create",
        });
        continue;
      }

      // Skip multi-person meetings
      const otherAttendees = attendees.filter(
        (n) => !n.toLowerCase().includes("howard") && !/\d/.test(n)
      );
      const topicNonHoward = topic
        .split(":")
        .map((s) => s.trim())
        .filter(
          (s) =>
            s &&
            /[a-zA-Z]{2,}/.test(s) &&
            !s.toLowerCase().includes("howard")
        );
      if (otherAttendees.length > 1 || topicNonHoward.length > 1) {
        plan.push({
          topic,
          rawId,
          parsedDate,
          dateHint: date,
          instanceKey,
          vaultFile: null,
          action: "skip",
        });
        continue;
      }

      const vaultFile = await writer.findPersonFile(
        topic,
        attendees.length ? attendees : undefined
      );

      if (vaultFile) {
        plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile, action: "insert" });
      } else {
        const suggested = writer.suggestNewFilePath(
          topic,
          attendees.length ? attendees : undefined
        );
        if (!suggested) {
          plan.push({
            topic,
            rawId,
            parsedDate,
            dateHint: date,
            instanceKey,
            vaultFile: null,
            action: "skip",
          });
        } else {
          plan.push({
            topic,
            rawId,
            parsedDate,
            dateHint: date,
            instanceKey,
            vaultFile: suggested,
            action: "create",
          });
        }
      }
    }

    const active = plan.filter((p) => p.action !== "skip");
    const inserts = active.filter((p) => p.action === "insert");
    const creates = active.filter((p) => p.action === "create");
    this.progress(
      `Plan: ${inserts.length} insert, ${creates.length} create, ${plan.length - active.length} skip.`
    );

    // Phase 4: pre-fetch summaries
    this.progress("Fetching summaries...");
    // Use instanceKey (rawId__date) to distinguish recurring meeting instances
    const toFetchFull = new Map<string, { rawId: string; topic: string; dateHint: string }>();

    const hasCachedContent = (key: string): boolean => {
      const s = this.summaryCache[key] as ZoomSummaryData | undefined;
      if (!s) return false;
      return writer.hasSummaryContent(s);
    };

    for (const { rawId, topic, instanceKey, dateHint } of active) {
      if (rawId && !hasCachedContent(instanceKey) && !toFetchFull.has(instanceKey)) {
        toFetchFull.set(instanceKey, { rawId, topic, dateHint });
        this.dbg(`[fetch-plan] Will fetch: instanceKey=${instanceKey} rawId=${rawId} dateHint="${dateHint}" topic="${topic}"`);
      }
    }

    if (toFetchFull.size > 0 && sourceType !== "shared") {
      this.progress(
        `Pre-fetching nav IDs for ${toFetchFull.size} meetings...`
      );
      const uniqueIds = [...new Set([...toFetchFull.values()].map(v => v.rawId))];
      await this.client.prefetchNavIds(uniqueIds, sourceType);
    }

    for (const [instanceKey, { rawId, topic, dateHint }] of toFetchFull) {
      this.progress(`  Fetching: ${topic} (${rawId}) date=${dateHint}...`);
      try {
        this.summaryCache[instanceKey] = await this.client.getSummary(rawId, sourceType, topic, dateHint);
      } catch (e) {
        this.progress(`  Error: ${(e as Error).message}`);
      }
    }

    // Phase 5: write summaries
    this.progress("Writing summaries...");
    let written = 0;
    let skipped = plan.length - active.length;
    let errors = 0;
    const results: SyncResult[] = [];
    const toDelete: Array<{ topic: string; rawId: string }> = [];

    for (const { topic, rawId, parsedDate, instanceKey, vaultFile, action } of active) {
      if (!vaultFile || !rawId) {
        results.push({ topic, status: "SKIP (no file)" });
        skipped++;
        continue;
      }
      const summary = this.summaryCache[instanceKey] as ZoomSummaryData | undefined;
      if (!summary) {
        results.push({ topic, status: "SKIP (no summary)" });
        skipped++;
        continue;
      }
      if (!writer.hasSummaryContent(summary)) {
        const errorDetail = (summary as Record<string, unknown>).error
          ? ` error=${String((summary as Record<string, unknown>).error)}`
          : "";
        this.dbg(`[warn] Empty summary for "${topic}" (${rawId})${errorDetail} — writing placeholder`);
      }
      try {
        const r = await writer.insertSummary(vaultFile, parsedDate, summary);
        if (r.inserted) {
          written++;
          toDelete.push({ topic, rawId });
          results.push({
            topic,
            file: r.filePath,
            status: `✓ ${action} @ ${parsedDate} (${r.position})`,
          });
        } else {
          skipped++;
          toDelete.push({ topic, rawId });
          results.push({
            topic,
            file: r.filePath,
            status: `= duplicate @ ${parsedDate}`,
          });
        }
      } catch (e) {
        errors++;
        results.push({
          topic,
          file: vaultFile,
          status: `✗ ERROR: ${(e as Error).message}`,
        });
      }
    }

    // Phase 6: delete from Zoom (optional)
    let deleted = 0;
    let deleteFailed = 0;

    if (autoDelete && toDelete.length > 0) {
      this.progress(`Deleting ${toDelete.length} summaries from Zoom...`);
      for (const { topic, rawId } of toDelete) {
        try {
          const r = await this.client.deleteSummary(rawId);
          if (r.success) {
            deleted++;
            this.progress(`  ✓ ${rawId} ${topic}`);
          } else {
            deleteFailed++;
            this.progress(`  ✗ ${rawId} ${topic}: ${r.message}`);
          }
        } catch (e) {
          deleteFailed++;
          this.progress(`  ✗ ${rawId} ${topic}: ${(e as Error).message}`);
        }
      }
    }

    // Phase 7: report
    const report: SyncReport = {
      results,
      written,
      skipped,
      errors,
      deleted,
      deleteFailed,
    };

    return report;
  }
}
