/**
 * Synchronous single-operation lock used by the plugin command handlers.
 *
 * The lock is deliberately synchronous: callers acquire it before their first
 * await, so two UI events in the same turn cannot both start an operation.
 */
export class OperationLock {
  private active: string | null = null;

  tryAcquire(operation: string): boolean {
    if (this.active !== null) return false;
    this.active = operation;
    return true;
  }

  release(operation: string): void {
    if (this.active === operation) this.active = null;
  }

  get activeOperation(): string | null {
    return this.active;
  }
}
