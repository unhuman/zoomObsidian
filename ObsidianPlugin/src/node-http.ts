/**
 * Minimal HTTP request helper using Node.js https/http modules.
 *
 * Electron's renderer-process fetch() silently strips the Cookie header
 * (it's a "forbidden header name" per the Fetch spec). Since the plugin
 * needs to send Zoom cookies on every request, we use Node's native
 * modules which have no such restriction.
 */

import * as https from "https";
import * as http from "http";

export interface SimpleResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Make an HTTP(S) request using Node.js built-in modules.
 *
 * @param url          Full URL to request
 * @param opts.method  HTTP method (default GET)
 * @param opts.headers Request headers (Cookie allowed)
 * @param opts.body    Request body string
 * @param opts.followRedirects  Follow 3xx redirects (default true)
 */
export function nodeRequest(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    followRedirects?: boolean;
  } = {}
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    const reqOpts: https.RequestOptions = {
      method: opts.method ?? "GET",
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: opts.headers ?? {},
    };

    const req = mod.request(reqOpts, (res) => {
      if (
        opts.followRedirects !== false &&
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        resolve(nodeRequest(redirectUrl, opts));
        return;
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf-8");
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") headers[k] = v;
          else if (Array.isArray(v)) headers[k] = v.join(", ");
        }
        resolve({ status: res.statusCode ?? 0, headers, body });
      });
      res.on("error", reject);
    });

    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
