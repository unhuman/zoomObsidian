export type TimeoutHandler = (error: Error) => void;

/**
 * Run a task with an AbortSignal-backed timeout. The task receives the signal
 * and is responsible for passing it to every cancellable operation it starts.
 */
export async function runWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  onTimeout?: TimeoutHandler
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const taskPromise = task(controller.signal);
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`Sync timeout after ${(timeoutMs / 1000).toFixed(0)}s`);
      controller.abort(error);
      onTimeout?.(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([taskPromise, timeoutPromise]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
