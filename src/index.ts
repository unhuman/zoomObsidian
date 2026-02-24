#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ZoomBrowser } from "./zoom-browser.js";
import { ZoomSummariesClient } from "./zoom-summaries.js";
import { ObsidianClient } from "./obsidian-client.js";

// Configuration via environment variables
const ZOOM_SUBDOMAIN = process.env.ZOOM_SUBDOMAIN || ""; // e.g. "acme" for acme.zoom.us
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || "";
const VAULT_SUBFOLDER = process.env.VAULT_SUBFOLDER || ""; // subfolder within vault (e.g. "MyOrg")
const ONE_ON_ONE_FOLDERS_RAW = process.env.ONE_ON_ONE_FOLDERS; // comma-separated folder names
const oneOnOneFolders = ONE_ON_ONE_FOLDERS_RAW
  ? ONE_ON_ONE_FOLDERS_RAW.split(",").map((s) => s.trim()).filter(Boolean)
  : undefined;

if (!OBSIDIAN_VAULT_PATH) {
  console.error("OBSIDIAN_VAULT_PATH env var is required for the MCP server.");
  process.exit(1);
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
  "List Zoom meeting summaries. Optionally filter by date range.",
  {
    from: z
      .string()
      .optional()
      .describe("Start date (e.g. 2025-01-01)"),
    to: z
      .string()
      .optional()
      .describe("End date (e.g. 2025-02-01)"),
  },
  async ({ from, to }) => {
    try {
      const result = await summariesClient.listSummaries({ from, to });
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
  "Fetch every Zoom meeting summary in the list and write each one to the matching Obsidian 1:1 note. Skips meetings with no matching file and skips duplicates.",
  {
    from: z.string().optional().describe("Optional start date filter (e.g. '2026-01-01')"),
    to: z.string().optional().describe("Optional end date filter (e.g. '2026-02-23')"),
  },
  async ({ from, to }) => {
    try {
      const meetings = await summariesClient.listSummaries({ from, to });
      const results: string[] = [];
      let written = 0, skipped = 0, failed = 0;

      for (const meeting of meetings) {
        const rawId = (meeting.column_2 ?? meeting.meeting_id ?? "") as string;
        const numericId = rawId.replace(/[\s-]/g, "");
        if (!numericId) { skipped++; continue; }
        try {
          const summary = await summariesClient.getSummary(numericId);
          const result = await obsidianClient.writeSummary(summary);
          results.push(result.message);
          if (result.success || result.action === "skipped_duplicate") {
            if (result.action !== "skipped_duplicate") written++; else skipped++;
            const del = await summariesClient.deleteSummary(numericId);
            results.push(`  → ${del.message}`);
          } else {
            skipped++;
          }
        } catch (e) {
          const msg = `Failed for ${meeting.meeting_topic ?? numericId}: ${e instanceof Error ? e.message : String(e)}`;
          results.push(msg);
          failed++;
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Done. Written: ${written}, Skipped: ${skipped}, Failed: ${failed}\n\n${results.join("\n")}`,
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
