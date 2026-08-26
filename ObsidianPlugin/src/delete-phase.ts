export interface DeletionTarget {
  topic: string;
  rawId: string;
  /** Raw Zoom date text used to disambiguate recurring meeting IDs. */
  dateHint?: string;
}

export interface DeleteSummaryResult {
  success: boolean;
  message: string;
}

export interface DeletePhaseEvent {
  type: "start" | "success" | "failed";
  target: DeletionTarget;
  message?: string;
  exception?: boolean;
}

export interface DeletePhaseReport {
  deleted: number;
  deleteFailed: number;
}

/** Run deletion attempts while preserving the date hint for each instance. */
export async function runDeletePhase(
  targets: readonly DeletionTarget[],
  deleteSummary: (
    meetingId: string,
    dateHint: string | undefined,
    signal?: AbortSignal
  ) => Promise<DeleteSummaryResult>,
  options: {
    signal?: AbortSignal;
    onEvent?: (event: DeletePhaseEvent) => void;
  } = {}
): Promise<DeletePhaseReport> {
  let deleted = 0;
  let deleteFailed = 0;

  for (const target of targets) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error("Sync cancelled.");
    }
    options.onEvent?.({ type: "start", target });

    try {
      const result = await deleteSummary(target.rawId, target.dateHint, options.signal);
      if (result.success) {
        deleted++;
        options.onEvent?.({ type: "success", target, message: result.message });
      } else {
        deleteFailed++;
        options.onEvent?.({ type: "failed", target, message: result.message });
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      deleteFailed++;
      options.onEvent?.({
        type: "failed",
        target,
        message: error instanceof Error ? error.message : String(error),
        exception: true,
      });
    }
  }

  return { deleted, deleteFailed };
}
