#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, statSync } from "fs";
import path from "path";
import { ZoomBrowser } from "./zoom-browser.js";
import { ZoomSummariesClient } from "./zoom-summaries.js";
import { ObsidianClient } from "./obsidian-client.js";

// Configuration via environment variables
const ZOOM_SUBDOMAIN = process.env.ZOOM_SUBDOMAIN || ""; // e.g. "acme" for acme.zoom.us
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "";
const VAULT_SUBFOLDER = process.env.VAULT_SUBFOLDER || ""; // subfolder within vault (e.g. "MyOrg")
const ONE_ON_ONE_FOLDERS_RAW = process.env.ONE_ON_ONE_FOLDERS; // comma-separated folder names
const SHARED_MEETINGS_FOLDER = process.env.SHARED_MEETINGS_FOLDER || ""; // optional folder for shared meetings
const oneOnOneFolders = ONE_ON_ONE_FOLDERS_RAW
  ? ONE_ON_ONE_FOLDERS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

if (!OBSIDIAN_VAULT_PATH) {
  console.error("OBSIDIAN_VAULT_PATH env var is required for the MCP server.");
  process.exit(1);
}

// Validate shared meetings folder if specified
function validateSharedMeetingsFolder(): string | null {
  if (!SHARED_MEETINGS_FOLDER?.trim()) return null;
  
  const folderPath = SHARED_MEETINGS_FOLDER.trim();
  const fullPath = path.join(OBSIDIAN_VAULT_PATH, folderPath);
  
  if (!existsSync(fullPath)) {
    return `Shared Meetings folder does not exist: "${folderPath}"`;
  }
  
  try {
    if (!statSync(fullPath).isDirectory()) {
      return `Shared Meetings path is not a directory: "${folderPath}"`;
    }
  } catch (e) {
    return `Cannot access Shared Meetings folder: "${folderPath}" (${(e as Error).message})`;
  }
  
  return null;
}

const browser = new ZoomBrowser({ zoomSubdomain: ZOOM_SUBDOMAIN || undefined });
const summariesClient = new ZoomSummariesClient(browser);
const obsidianClient = new ObsidianClient(OBSIDIAN_VAULT_PATH, {
  vaultSubfolder: VAULT_SUBFOLDER || undefined,
  oneOnOneFolders,
});

const server = new McpServer({
  name: "zoom-meeting-summaries",
  version: "1.0.0",
});

// Tool: Login to Zoom
server.tool(
  "zoom_login",
  "Open a browser window to log into Zoom. Call this first if you get authentication errors. Saves session cookies for reuse.",
  {},
  async () => {
    try {
      await browser.ensureAuthenticated();
      return {
        content: [
          {
            type: "text" as const,
            text: "Successfully authenticated with Zoom. Session cookies saved for future use.",
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Login failed: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: List meeting summaries
server.tool(
  "list_meeting_summaries",
  "List Zoom meeting summaries. Optionally filter by date range and source (owned or shared).",
  {
    source: z
      .enum(["owned", "shared"])
      .optional()
      .default("owned")
      .describe("'owned' for your meetings, 'shared' for meetings shared with you"),
    from: z
      .string()
      .optional()
      .describe("Start date (e.g. 2025-01-01)"),
    to: z
      .string()
      .optional()
      .describe("End date (e.g. 2025-02-01)"),
  },
  async ({ source = "owned", from, to }) => {
    try {
      const result = await summariesClient.listSummaries(source as "owned" | "shared", { from, to });
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${result.length} ${source} meetings:\n\n${JSON.stringify(result, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}. Try calling zoom_login first.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Get a specific meeting summary
server.tool(
  "get_meeting_summary",
  "Get the full AI-generated summary for a specific Zoom meeting.",
  {
    meeting_id: z
      .string()
      .describe("The Zoom meeting ID"),
  },
  async ({ meeting_id }) => {
    try {
      const result = await summariesClient.getSummary(meeting_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}. Try calling zoom_login first.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Write a single meeting summary to Obsidian
server.tool(
  "write_summary_to_obsidian",
  "Fetch a Zoom meeting summary and append it to the matching person's note in the Obsidian vault. Finds the file by matching the first name in the meeting topic (e.g. 'Amit:Howard' → Amit Kumar.md).",
  {
    meeting_id: z
      .string()
      .describe("The numeric Zoom meeting ID (e.g. '96980348286')"),
  },
  async ({ meeting_id }) => {
    // Validate shared meetings folder if specified
    const folderError = validateSharedMeetingsFolder();
    if (folderError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${folderError}. Cannot proceed with sync.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const summary = await summariesClient.getSummary(meeting_id);
      const result = await obsidianClient.writeSummary(summary);
      return {
        content: [
          {
            type: "text" as const,
            text: result.message + (result.filePath ? `\nFile: ${result.filePath}` : ""),
          },
        ],
        isError: !result.success,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}. Try calling zoom_login first.`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Write all summaries from the list to Obsidian
server.tool(
  "write_all_summaries_to_obsidian",
  "Fetch every Zoom meeting summary (owned and shared) and write each one to the matching Obsidian note. Skips meetings with no matching file and skips duplicates. Shared meetings are never deleted from Zoom.",
  {
    from: z.string().optional().describe("Optional start date filter (e.g. '2026-01-01')"),
    to: z.string().optional().describe("Optional end date filter (e.g. '2026-02-23')"),
  },
  async ({ from, to }) => {
    // Validate shared meetings folder if specified
    const folderError = validateSharedMeetingsFolder();
    if (folderError) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${folderError}. Cannot proceed with sync.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const allResults: string[] = [];
      let totalWritten = 0, totalSkipped = 0, totalFailed = 0;

      // Helper to process a single source (owned or shared)
      const processSource = async (sourceType: 'owned' | 'shared', client: ObsidianClient, shouldDelete: boolean) => {
        const sourceResults: string[] = [];
        let written = 0, skipped = 0, failed = 0;

        allResults.push(`\n--- ${sourceType === 'owned' ? 'Owned' : 'Shared'} Meetings ---`);

        const meetings = await summariesClient.listSummaries(sourceType, { from, to });
        for (const meeting of meetings) {
          const rawId = (meeting.column_2 ?? meeting.meeting_id ?? "") as string;
          const numericId = rawId.replace(/[\s-]/g, "");
          if (!numericId) { skipped++; continue; }
          // Extract date hint for recurring meeting disambiguation
          const dateHint = ((meeting as Record<string, unknown>).column_3 ?? (meeting as Record<string, unknown>).column_1 ?? "").toString().trim();
          try {
            const summary = await summariesClient.getSummary(numericId, sourceType, dateHint);
            const result = await client.writeSummary(summary);
            sourceResults.push(result.message);
            if (result.success || result.action === "skipped_duplicate") {
              if (result.action !== "skipped_duplicate") written++; else skipped++;
              // Only delete owned meetings; shared meetings cannot be deleted (Zoom API limitation)
              if (shouldDelete) {
                const del = await summariesClient.deleteSummary(numericId);
                sourceResults.push(`  → ${del.message}`);
              }
            } else {
              skipped++;
            }
          } catch (e) {
            const msg = `Failed for ${meeting.meeting_topic ?? numericId}: ${e instanceof Error ? e.message : String(e)}`;
            sourceResults.push(msg);
            failed++;
          }
        }

        allResults.push(...sourceResults);
        return { written, skipped, failed };
      };

      // Process owned meetings
      const ownedStats = await processSource('owned', obsidianClient, true);
      totalWritten += ownedStats.written;
      totalSkipped += ownedStats.skipped;
      totalFailed += ownedStats.failed;

      // Process shared meetings if folder is configured
      if (SHARED_MEETINGS_FOLDER?.trim()) {
        try {
          const sharedObsidianClient = new ObsidianClient(OBSIDIAN_VAULT_PATH, {
            vaultSubfolder: "", // shared meetings are in the dedicated folder, not in vault subfolder
            oneOnOneFolders: [SHARED_MEETINGS_FOLDER.trim()],
          });
          const sharedStats = await processSource('shared', sharedObsidianClient, false); // never delete shared
          totalWritten += sharedStats.written;
          totalSkipped += sharedStats.skipped;
          totalFailed += sharedStats.failed;
        } catch (e) {
          allResults.push(`\nError processing shared meetings: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Done. Written: ${totalWritten}, Skipped: ${totalSkipped}, Failed: ${totalFailed}\n${allResults.join("\n")}`,
          },
        ],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}. Try calling zoom_login first.`,
          },
        ],
        isError: true,
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Zoom Meeting Summaries MCP server running on stdio");
  console.error(`Zoom URL: ${browser.baseUrl}`);

  // Cleanup on exit
  process.on("SIGINT", async () => {
    await browser.close();
    process.exit(0);
  });
  process.on("SIGTERM", async () => {
    await browser.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
