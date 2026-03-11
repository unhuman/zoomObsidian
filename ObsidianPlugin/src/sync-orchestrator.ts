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
}

export class SyncOrchestrator {
  private client: ZoomClient;
  private writer: VaultWriter;
  private debug: boolean;

  // In-memory caches (same pattern as the standalone script)
  private attendeesCache: Record<string, string[]> = {};
  private summaryCache: Record<string, MeetingSummaryDetail> = {};

  /** Progress callback for UI updates. */
  onProgress?: (message: string) => void;

  constructor(
    client: ZoomClient,
    writer: VaultWriter,
    opts?: { debug?: boolean }
  ) {
    this.client = client;
    this.writer = writer;
    this.debug = opts?.debug ?? false;
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

    // Phase 1: list meetings
    this.progress("Listing Zoom meeting summaries...");
    const allMeetings = await this.client.listSummaries();
    const meetings = filter
      ? allMeetings.filter((m) =>
          (m.meeting_topic ?? (m as Record<string, unknown>).column_1 ?? "")
            .toString()
            .toLowerCase()
            .includes(filter.toLowerCase())
        )
      : allMeetings;
    this.progress(
      `Found ${allMeetings.length} meetings${filter ? `, ${meetings.length} match filter "${filter}"` : ""}.`
    );

    const allFiles = await this.writer.allFiles();

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
      const rawId = (
        (m as Record<string, unknown>).column_2 ?? ""
      )
        .toString()
        .replace(/[\s-]/g, "");

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
        const data = await this.client.getSummary(rawId);
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
      const rawId = (
        (m as Record<string, unknown>).column_2 ?? ""
      )
        .toString()
        .replace(/[\s-]/g, "");
      const date = ((m as Record<string, unknown>).column_4 ?? "").toString().trim();
      const attendees = attendeesMap.get(rawId) ?? [];
      const parsedDate = this.writer.parseMeetingDate(date);

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
          vaultFile: null,
          action: "skip",
        });
        continue;
      }

      const vaultFile = await this.writer.findPersonFile(
        topic,
        attendees.length ? attendees : undefined
      );

      if (vaultFile) {
        plan.push({ topic, rawId, parsedDate, vaultFile, action: "insert" });
      } else {
        const suggested = this.writer.suggestNewFilePath(
          topic,
          attendees.length ? attendees : undefined
        );
        if (!suggested) {
          plan.push({
            topic,
            rawId,
            parsedDate,
            vaultFile: null,
            action: "skip",
          });
        } else {
          plan.push({
            topic,
            rawId,
            parsedDate,
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
    const toFetchFull = new Map<string, string>();

    const hasCachedContent = (rawId: string): boolean => {
      const s = this.summaryCache[rawId] as ZoomSummaryData | undefined;
      if (!s) return false;
      return this.writer.hasSummaryContent(s);
    };

    for (const { rawId, topic } of active) {
      if (rawId && !hasCachedContent(rawId) && !toFetchFull.has(rawId)) {
        toFetchFull.set(rawId, topic);
      }
    }

    if (toFetchFull.size > 0) {
      this.progress(
        `Pre-fetching nav IDs for ${toFetchFull.size} meetings...`
      );
      await this.client.prefetchNavIds([...toFetchFull.keys()]);
    }

    for (const [rawId, topic] of toFetchFull) {
      this.progress(`  Fetching: ${topic} (${rawId})...`);
      try {
        this.summaryCache[rawId] = await this.client.getSummary(rawId);
      } catch (e) {
        this.progress(`  Error: ${(e as Error).message}`);
      }
    }

    // Phase 5: write summaries
    this.progress("Writing summaries...");
    let written = 0;
    let skipped = 0;
    let errors = 0;
    const results: SyncResult[] = [];
    const toDelete: Array<{ topic: string; rawId: string }> = [];

    for (const { topic, rawId, parsedDate, vaultFile, action } of active) {
      if (!vaultFile || !rawId) {
        results.push({ topic, status: "SKIP (no file)" });
        skipped++;
        continue;
      }
      const summary = this.summaryCache[rawId] as ZoomSummaryData | undefined;
      if (!summary) {
        results.push({ topic, status: "SKIP (no summary)" });
        skipped++;
        continue;
      }
      try {
        const r = await this.writer.insertSummary(vaultFile, parsedDate, summary);
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

    const summary = `Sync complete: ${written} written, ${skipped} skipped, ${errors} errors` +
      (autoDelete ? `, ${deleted} deleted, ${deleteFailed} delete failures` : "");
    this.progress(summary);
    new Notice(summary);

    return report;
  }
}
