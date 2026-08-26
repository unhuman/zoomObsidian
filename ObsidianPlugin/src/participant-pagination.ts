export interface ParticipantPage<T> {
  items: T[];
  total?: number;
  totalPages?: number;
  pageSize?: number;
}

export interface PaginatedItems<T> {
  items: T[];
  pagesFetched: number;
}

function pageFingerprint<T>(items: T[]): string {
  try {
    return JSON.stringify(items) ?? `length:${items.length}`;
  } catch {
    // Participant API responses are plain objects, but keep pagination safe if
    // a future caller supplies a non-serializable item.
    return `length:${items.length}:${String(items[0])}`;
  }
}

/**
 * Fetch all pages from a paginated endpoint without trusting a single shape of
 * pagination metadata. Zoom has returned total counts, total page counts, and
 * page sizes in different response versions.
 */
export async function collectPaginatedItems<T>(
  fetchPage: (page: number) => Promise<ParticipantPage<T>>,
  options: { maxPages?: number; signal?: AbortSignal } = {}
): Promise<PaginatedItems<T>> {
  const maxPages = Math.max(1, options.maxPages ?? 100);
  const items: T[] = [];
  const seenPages = new Set<string>();
  let pagesFetched = 0;

  for (let page = 1; page <= maxPages; page++) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Operation cancelled.");
    }

    const result = await fetchPage(page);
    pagesFetched++;
    const pageItems = result.items ?? [];
    if (pageItems.length === 0) break;

    // If the endpoint ignores the page parameter, stop rather than duplicating
    // the first page up to the safety cap.
    const fingerprint = pageFingerprint(pageItems);
    if (seenPages.has(fingerprint)) break;
    seenPages.add(fingerprint);
    items.push(...pageItems);

    if (result.total !== undefined && items.length >= result.total) break;
    if (result.totalPages !== undefined && page >= result.totalPages) break;
    if (result.pageSize !== undefined && pageItems.length < result.pageSize) break;
  }

  return { items, pagesFetched };
}
