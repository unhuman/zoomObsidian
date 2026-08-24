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

import type { ZoomClient } from "./zoom-client";
import type { VaultWriter } from "./vault-writer";
import type { MeetingSummaryItem, MeetingSummaryDetail, ZoomSummaryData } from "./types";
import { notify } from "./types";

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
  /** When true, use the main 1:1 writer instead of the source-specific writer. */
  useMainWriter?: boolean;
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
  updatedLastProcessedShared?: string;
  /** Latest meeting date (YYYY-MM-DD) seen in this source's plan. */
  latestMeetingDate?: string;
}

export class SyncOrchestrator {
  private client: ZoomClient;
  private writer: VaultWriter;
  private debug: boolean;
  private sharedMeetingsFolder?: string;
  /** Lowercased first name of the current user, used to filter self from attendee lists. */
  private selfFirstName: string;

  // In-memory caches (same pattern as the standalone script)
  private attendeesCache: Record<string, string[]> = {};
  private summaryCache: Record<string, MeetingSummaryDetail> = {};

  /** Progress callback for UI updates. */
  onProgress?: (message: string) => void;

  /** Last-processed timestamp for incremental shared-meeting scans. */
  private lastProcessedShared?: string;

  constructor(
    client: ZoomClient,
    writer: VaultWriter,
    opts?: {
      debug?: boolean;
      sharedMeetingsFolder?: string;
      lastProcessedShared?: string;
      myDisplayName?: string;
    }
  ) {
    this.client = client;
    this.writer = writer;
    this.debug = opts?.debug ?? false;
    this.sharedMeetingsFolder = opts?.sharedMeetingsFolder;
    this.lastProcessedShared = opts?.lastProcessedShared;
    this.selfFirstName = (opts?.myDisplayName ?? "").split(/\s+/)[0].toLowerCase();
  }

  private dbg(...args: unknown[]): void {
    if (this.debug) console.log("[sync]", ...args);
  }

  private progress(msg: string): void {
    this.dbg(msg);
    this.onProgress?.(msg);
  }

  /**
   * Run the full sync workflow with timeout protection. Returns a report of all actions taken.
   * Processes both owned and shared meetings (if configured).
   *
   * @param opts.filter   — Optional topic substring filter.
   * @param opts.autoDelete — If true, delete summaries from Zoom after writing.
   * @param opts.timeoutMs — Overall timeout in milliseconds (default: 10 minutes).
   */
  async run(opts?: {
    filter?: string;
    autoDelete?: boolean;
    timeoutMs?: number;
  }): Promise<SyncReport> {
    const timeoutMs = opts?.timeoutMs ?? 600_000; // 10 minutes default

    try {
      return await this.runWithTimeout(opts, timeoutMs);
    } catch (e) {
      const msg = `Sync failed: ${(e as Error).message}`;
      this.progress(msg);
      notify(msg);
      throw e;
    }
  }

  /**
   * Internal: run with timeout protection.
   */
  private async runWithTimeout(
    opts: { filter?: string; autoDelete?: boolean } | undefined,
    timeoutMs: number
  ): Promise<SyncReport> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const msg = `Sync timeout after ${(timeoutMs / 1000).toFixed(0)}s`;
        this.progress(msg);
        reject(new Error(msg));
      }, timeoutMs);

      this.runInternal(opts)
        .then((result) => {
          clearTimeout(timeout);
          resolve(result);
        })
        .catch((e) => {
          clearTimeout(timeout);
          reject(e);
        });
    });
  }

  /**
   * Internal: actual sync implementation.
   */
  private async runInternal(opts?: {
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
    this.dbg(`[scan-dates] lastProcessedShared=${this.lastProcessedShared ?? "(none)"} (owned: always full scan)`);
    this.dbg(`[scan-dates] filter=${filter || "(none)"}, autoDelete=${autoDelete}, hasSharedFolder=${hasSharedFolder}`);

    // Always process owned meetings (full scan every time — owned meetings
    // are deletable, so incremental timestamps aren't needed).
    this.progress("Phase 1-7: Processing owned Zoom meetings...");
    const ownedReport = await this.processMeetingSource(
      "owned",
      filter,
      autoDelete,
      this.writer
    );
    allResults.push(...ownedReport.results);
    totalWritten += ownedReport.written;
    totalSkipped += ownedReport.skipped;
    totalErrors += ownedReport.errors;
    totalDeleted += ownedReport.deleted;
    totalDeleteFailed += ownedReport.deleteFailed;

    // Also process shared meetings when folder is configured.
    let latestSharedMeetingDate: string | undefined;
    if (hasSharedFolder) {
      this.progress("Processing shared Zoom meetings...");
      try {
        // Create a VaultWriter context for shared meetings folder
        const sharedMeetingsWriter = new (this.writer.constructor as any)(
          (this.writer as any).app,
          {
            vaultSubfolder: "", // shared meetings are in the dedicated folder, not in vault subfolder
            oneOnOneFolders: [this.sharedMeetingsFolder!.trim()],
          }
        );
        const sharedReport = await this.processMeetingSource(
          "shared",
          filter,
          false, // never auto-delete shared meetings (Zoom API limitation)
          sharedMeetingsWriter,
          this.lastProcessedShared,
          this.writer  // mainWriter: enables routing shared 1:1s to person's 1:1 file
        );
        allResults.push(...sharedReport.results);
        totalWritten += sharedReport.written;
        totalSkipped += sharedReport.skipped;
        totalErrors += sharedReport.errors;

        // Track latest shared meeting date for scan-date advancement
        if (sharedReport.latestMeetingDate) {
          latestSharedMeetingDate = sharedReport.latestMeetingDate;
        }
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
    // Owned: no timestamp tracking — owned meetings are always fully scanned since
    // they get deleted from Zoom after writing; incremental scanning would miss retries.
    // Shared: advance when no topic filter is active (filter would skip non-matching
    // meetings that haven't been processed yet). autoDelete is irrelevant here —
    // shared meetings are never deleted from Zoom regardless.
    // Uses the latest meeting date seen (not the run timestamp) so that meetings
    // dated after the last-processed date are always picked up.
    if (hasSharedFolder && !filter && latestSharedMeetingDate) {
      report.updatedLastProcessedShared = latestSharedMeetingDate;
      this.dbg(`[scan-dates] Will advance lastProcessedShared → ${latestSharedMeetingDate} (latest meeting date)`);
    } else if (hasSharedFolder) {
      const reasons: string[] = [];
      if (filter) reasons.push("topic filter is active");
      if (!latestSharedMeetingDate) reasons.push("no shared meetings found");
      this.dbg(`[scan-dates] NOT advancing lastProcessedShared (${reasons.join(", ")})`);
    }

    const summary =
      `Sync complete: ${totalWritten} written, ${totalSkipped} skipped, ${totalErrors} errors` +
      (autoDelete
        ? `, ${totalDeleted} deleted, ${totalDeleteFailed} delete failures`
        : "");
    this.progress(summary);
    notify(summary);

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
    fromDate?: string,
    mainWriter?: VaultWriter
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
      let stem = value
        .replace(/[<>:"/\\|?*]/g, "-")
        .replace(/\s+/g, " ")
        .trim();
      // Leading dots make files hidden in Obsidian; replace with "dot"
      stem = stem.replace(/^\.+/, (m) => "dot".repeat(m.length));
      return stem || "Untitled Meeting";
    };

    // Phase 1: list meetings
    this.progress(`[Phase 1] Listing ${sourceType} meeting summaries...`);
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
      `[Phase 1] Found ${allMeetings.length} ${sourceType} meetings${filter ? `, ${meetings.length} match filter "${filter}"` : ""}.`
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
    this.progress(`[Phase 2] Resolving attendees for ambiguous meetings...`);
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
        // Always fetch attendees for shared meetings so we can detect 1:1s.
        if (rawId && !attendeesMap.has(rawId) && !toFetchAttendees.has(rawId)) {
          toFetchAttendees.set(rawId, topic);
        }
        continue;
      }

      const topicFirst = topic.split(":")[0].trim();
      const isCandidate =
        (topic.includes(":") &&
          !topicFirst.includes(" ") &&
          topicFirst.toLowerCase() !== "zoom") ||
        /^zoom\s+meeting\b/i.test(topic);

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
        // Fallback: if nextStepItems gave no names, query the participant report API
        if (names.length === 0) {
          this.dbg(`[attendees] nextStepItems empty for ${rawId}; trying participant report API`);
          try {
            const participantNames = await this.client.getMeetingParticipants(rawId, sourceType);
            names.push(...participantNames);
          } catch (pe) {
            this.dbg(`[attendees] participant API error for ${rawId}: ${(pe as Error).message}`);
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
    this.progress(`[Phase 3] Building sync plan for ${meetings.length} meetings...`);
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
      // Scan columns for whichever one contains a recognizable date string —
      // the table layout varies (e.g. owned meetings have seen topic/topic/ID/email/date).
      const datePatterns = [
        /\d{4}-\d{2}-\d{2}/,
        /[A-Za-z]{3,}\s+\d{1,2},\s+\d{4}/,
        /\d{1,2}\/\d{1,2}\/\d{4}/,
      ];
      let date = "";
      let dateCol = "(none)";
      for (let ci = 0; ci <= 6; ci++) {
        const val = ((m as Record<string, unknown>)[`column_${ci}`] ?? "").toString().trim();
        if (val && datePatterns.some((p) => p.test(val))) {
          date = val;
          dateCol = `column_${ci}`;
          break;
        }
      }
      const attendees = attendeesMap.get(rawId) ?? [];
      const parsedDate = writer.parseMeetingDate(date);
      const instanceKey = `${rawId}__${date || parsedDate}`;

      console.log(`[sync][phase3] topic="${topic}" rawId=${rawId} parsedDate=${parsedDate} instanceKey=${instanceKey}`);
      this.dbg(`[plan] topic="${topic}" rawId=${rawId} dateCol=${dateCol} rawDate="${date}" parsedDate=${parsedDate} instanceKey=${instanceKey} cols={c0=${(m as any).column_0?.toString().substring(0,30)}, c1=${(m as any).column_1?.toString().substring(0,30)}, c2=${(m as any).column_2?.toString().substring(0,30)}, c3=${(m as any).column_3?.toString().substring(0,30)}, c4=${(m as any).column_4}}`);

      if (!rawId) {
        plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: null, action: "skip" });
        continue;
      }

      // Group meeting: topic is 3+ colon-separated single-word names (e.g. "d:c:b").
      // Sort alphabetically and route to a file named with the sorted parts (e.g. "b:c:d").
      const topicPartsForGroup = topic.split(":").map((s) => s.trim()).filter((s) => s && /[a-zA-Z]{2,}/.test(s) && !/\s/.test(s));
      const isGroupTopic = topicPartsForGroup.length >= 3 && sourceType === "owned";
      if (isGroupTopic) {
        const sortedParts = [...topicPartsForGroup].sort((a, b) =>
          a.toLowerCase().localeCompare(b.toLowerCase())
        );
        const groupFileName = sortedParts.join("-");
        const existingGroup = allFiles.find(
          (f) => f.name.toLowerCase() === groupFileName.toLowerCase()
        );
        if (existingGroup) {
          plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: existingGroup.path, action: "insert" });
        } else {
          const suggestedGroup = writer.suggestNewFilePath(groupFileName, [groupFileName]);
          plan.push({
            topic, rawId, parsedDate, dateHint: date, instanceKey,
            vaultFile: suggestedGroup,
            action: suggestedGroup ? "create" : "skip",
          });
        }
        continue;
      }

      // Exact topic match anywhere in vault — route to that file regardless of attendees.
      if (sourceType === "owned") {
        const exactMatch = await writer.findFileByExactName(topic);
        if (exactMatch) {
          plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: exactMatch, action: "insert" });
          continue;
        }
      }

      // Compute self/other attendees — used for both owned and shared 1:1 detection.
      const resolvedSelfFirst =
        this.selfFirstName ||
        (this.client.getDetectedMyName().split(/\s+/)[0] ?? '').toLowerCase();
      const isSelf = (n: string) =>
        resolvedSelfFirst ? n.toLowerCase().includes(resolvedSelfFirst) : false;
      const otherAttendees = attendees.filter((n) => !isSelf(n) && !/\d/.test(n));
      // Use single-word colon parts only for the multi-person topic check.
      // Multi-word parts like "Howard (alternate)" are parenthetical suffixes, not
      // additional people — so they must not inflate topicNonSelf and trigger a skip.
      const topicNonSelf = topicPartsForGroup.filter((s) => !isSelf(s));

      if (sourceType === "shared") {
        // Route shared 1:1s to the person's 1:1 vault file when possible.
        if (otherAttendees.length === 1 && mainWriter) {
          const vaultFile1on1 = await mainWriter.findPersonFile(topic, otherAttendees);
          if (vaultFile1on1) {
            plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: vaultFile1on1, action: "insert", useMainWriter: true });
            continue;
          }
          const suggested1on1 = mainWriter.suggestNewFilePath(topic, otherAttendees);
          if (suggested1on1) {
            plan.push({ topic, rawId, parsedDate, dateHint: date, instanceKey, vaultFile: suggested1on1, action: "create", useMainWriter: true });
            continue;
          }
        }
        // Fall back to shared meetings folder.
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

      // Skip multi-person owned meetings.
      // When self identity is unknown (no myDisplayName set and name not yet auto-detected),
      // isSelf() returns false for everyone — including the user — so otherAttendees
      // can't be used reliably. Fall back to topic structure only in that case.
      const isMultiPerson = resolvedSelfFirst
        ? otherAttendees.length > 1 || topicNonSelf.length > 1
        : topicNonSelf.length > 1;
      if (isMultiPerson) {
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

    for (const p of plan) {
      console.log(`[sync][phase3-result] topic="${p.topic}" action=${p.action} vaultFile=${p.vaultFile} parsedDate=${p.parsedDate}`);
    }
    const active = plan.filter((p) => p.action !== "skip");
    const inserts = active.filter((p) => p.action === "insert");
    const creates = active.filter((p) => p.action === "create");
    this.progress(
      `Plan: ${inserts.length} insert, ${creates.length} create, ${plan.length - active.length} skip.`
    );

    // Phase 4: pre-fetch summaries
    this.progress(`[Phase 4] Fetching summaries for ${active.length} meetings...`);
    writer.clearFileCache();
    mainWriter?.clearFileCache();
    // Use instanceKey (rawId__date) to distinguish recurring meeting instances
    const toFetchFull = new Map<string, { rawId: string; topic: string; dateHint: string }>();
    const alreadyInVault = new Set<string>();

    const hasCachedContent = (key: string): boolean => {
      const s = this.summaryCache[key] as ZoomSummaryData | undefined;
      if (!s) return false;
      return writer.hasSummaryContent(s);
    };

    for (const { rawId, topic, instanceKey, dateHint, vaultFile, parsedDate, useMainWriter: entryUsesMain } of active) {
      console.log(`[sync][phase4] topic="${topic}" rawId=${rawId} instanceKey=${instanceKey} vaultFile=${vaultFile} parsedDate=${parsedDate} hasCached=${hasCachedContent(instanceKey)} inToFetch=${toFetchFull.has(instanceKey)}`);
      if (rawId && !hasCachedContent(instanceKey) && !toFetchFull.has(instanceKey)) {
        // Skip fetch if the vault file already has a non-placeholder summary for this date.
        // Applies to all source types. For owned meetings, if auto-delete is on and the
        // meeting is still in Zoom, Phase 5 will still attempt deletion via toDelete.
        if (vaultFile && parsedDate) {
          const entryWriter = entryUsesMain && mainWriter ? mainWriter : writer;
          const alreadyWritten = await entryWriter.hasExistingSummary(vaultFile, parsedDate, rawId);
          if (alreadyWritten) {
            this.dbg(`[fetch-plan] Already in vault, skipping fetch: instanceKey=${instanceKey} file=${vaultFile} date=${parsedDate}`);
            alreadyInVault.add(instanceKey);
            continue;
          }
        }
        toFetchFull.set(instanceKey, { rawId, topic, dateHint });
        this.dbg(`[fetch-plan] Will fetch: instanceKey=${instanceKey} rawId=${rawId} dateHint="${dateHint}" topic="${topic}"`);
      }
    }

    if (toFetchFull.size > 0 && sourceType !== "shared") {
      this.progress(
        `[Phase 4] Pre-fetching nav IDs for ${toFetchFull.size} meetings...`
      );
      const uniqueIds = [...new Set([...toFetchFull.values()].map(v => v.rawId))];
      await this.client.prefetchNavIds(uniqueIds, sourceType);
    }

    for (const [instanceKey, { rawId, topic, dateHint }] of toFetchFull) {
      this.progress(`[Phase 4] Fetching: ${topic} (${rawId})...`);
      try {
        this.summaryCache[instanceKey] = await this.client.getSummary(rawId, sourceType, topic, dateHint);
      } catch (e) {
        this.progress(`[Phase 4] Error: ${(e as Error).message}`);
      }
    }

    // Phase 5: write summaries
    this.progress(`[Phase 5] Writing ${active.length} summaries to vault...`);
    let written = 0;
    let skipped = plan.length - active.length;
    let errors = 0;
    let latestMeetingDate: string | undefined;
    const results: SyncResult[] = [];
    const toDelete: Array<{ topic: string; rawId: string }> = [];

    for (const { topic, rawId, parsedDate, instanceKey, vaultFile, action, useMainWriter: entryUsesMain } of active) {
      const entryWriter = entryUsesMain && mainWriter ? mainWriter : writer;
      // Track latest meeting date for scan-date bookkeeping
      if (parsedDate && (!latestMeetingDate || parsedDate > latestMeetingDate)) {
        latestMeetingDate = parsedDate;
      }
      if (!vaultFile || !rawId) {
        results.push({ topic, status: `SKIP (no file) @ ${parsedDate}` });
        skipped++;
        continue;
      }
      const summary = this.summaryCache[instanceKey] as ZoomSummaryData | undefined;
      if (!summary) {
        if (alreadyInVault.has(instanceKey)) {
          results.push({ topic, status: `SKIP (already synced) @ ${parsedDate}` });
          // Still queue for deletion — if auto-delete is on and the meeting is still
          // in Zoom (e.g. a previous deletion failed), retry the delete now.
          toDelete.push({ topic, rawId });
        } else {
          results.push({ topic, status: `SKIP (no summary) @ ${parsedDate}` });
        }
        skipped++;
        continue;
      }
      if (!entryWriter.hasSummaryContent(summary)) {
        if (entryWriter.isTranscriptMissing(summary)) {
          this.dbg(`[info] No transcript for "${topic}" (${rawId}) — marking MISSING`);
          skipped++;
          results.push({ topic, status: `MISSING @ ${parsedDate}` });
          toDelete.push({ topic, rawId });
        } else {
          const errorDetail = (summary as Record<string, unknown>).error
            ? ` error=${String((summary as Record<string, unknown>).error)}`
            : "";
          this.dbg(`[warn] Empty summary for "${topic}" (${rawId})${errorDetail} — skipping write until data is ready`);
          skipped++;
          results.push({ topic, status: `PENDING @ ${parsedDate}` });
          // CRITICAL: Do NOT add to toDelete — pending meetings are retried on next sync when data is ready.
          // Deleting now would lose the meeting without capturing its summary.
        }
        continue;
      }
      try {
        const r = await entryWriter.insertSummary(vaultFile, parsedDate, summary);
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

    this.dbg(`[info] Phase 6: autoDelete=${autoDelete}, toDelete.length=${toDelete.length}, meetings to delete: ${toDelete.map(d => `"${d.topic}" (${d.rawId})`).join(", ")}`);
    if (autoDelete && toDelete.length > 0) {
      this.progress(`[Phase 6] Deleting ${toDelete.length} summaries from Zoom...`);
      for (const { topic, rawId } of toDelete) {
        try {
          this.dbg(`[debug] Deleting "${topic}" (${rawId})...`);
          const r = await this.client.deleteSummary(rawId);
          if (r.success) {
            deleted++;
            this.progress(`[Phase 6] ✓ Deleted: ${topic}`);
            this.dbg(`[debug] Successfully deleted "${topic}" (${rawId})`);
          } else {
            deleteFailed++;
            this.progress(`[Phase 6] ✗ Failed: ${topic}: ${r.message}`);
            this.dbg(`[warn] Failed to delete "${topic}" (${rawId}): ${r.message}`);
          }
        } catch (e) {
          deleteFailed++;
          this.progress(`[Phase 6] ✗ Error: ${topic}: ${(e as Error).message}`);
          this.dbg(`[error] Exception deleting "${topic}" (${rawId}): ${(e as Error).message}`);
        }
      }
    } else if (toDelete.length > 0) {
      this.dbg(`[info] autoDelete is disabled; skipping deletion of ${toDelete.length} meetings`);
    }

    // Phase 7: report
    this.progress(`[Phase 7] Sync complete: ${written} written, ${skipped} skipped, ${errors} errors`);
    const report: SyncReport = {
      results,
      written,
      skipped,
      errors,
      deleted,
      deleteFailed,
      latestMeetingDate,
    };

    return report;
  }
}
