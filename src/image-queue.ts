import { randomUUID } from 'node:crypto';

export class QueueCancelled extends Error { constructor() { super('已取消尚未开始的生图排队'); this.name = 'QueueCancelled'; } }
export interface ImageGate { acquire(taskId: string, sheetIndex: number): Promise<() => void>; cancelPending(taskId: string): void; close?(): void }
interface Ticket { id: string; taskId: string; sheetIndex: number; owner: string; resolve: (release: () => void) => void; reject: (error: Error) => void }

/** One limiter shared across tasks. Lowering it never aborts already-started requests. */
export class ImageQueue implements ImageGate {
  private active = new Map<string, Ticket>();
  private pending: Ticket[] = [];
  constructor(public limit = 2) { this.setLimit(limit); }
  setLimit(limit: number) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 120) throw new Error('生图并发必须为 1–120。');
    this.limit = limit; this.pump();
  }
  acquire(taskId: string, sheetIndex: number, owner = taskId): Promise<() => void> {
    return new Promise((resolve, reject) => { this.pending.push({ id: randomUUID(), taskId, sheetIndex, owner, resolve, reject }); this.pump(); });
  }
  cancelPending(taskId: string) {
    this.pending = this.pending.filter(ticket => { if (ticket.taskId !== taskId) return true; ticket.reject(new QueueCancelled()); return false; });
  }
  detachOwner(owner: string) {
    this.pending = this.pending.filter(ticket => { if (ticket.owner !== owner) return true; ticket.reject(new QueueCancelled()); return false; });
    for (const [id, ticket] of this.active) if (ticket.owner === owner) this.active.delete(id);
    this.pump();
  }
  snapshot() {
    const plain = (t: Ticket) => ({ taskId: t.taskId, sheetIndex: t.sheetIndex });
    return { limit: this.limit, running: this.active.size, pending: this.pending.length,
      runningItems: [...this.active.values()].map(plain), pendingItems: this.pending.map(plain) };
  }
  private pump() {
    while (this.active.size < this.limit && this.pending.length) {
      const ticket = this.pending.shift()!; this.active.set(ticket.id, ticket);
      let released = false;
      ticket.resolve(() => { if (released) return; released = true; this.active.delete(ticket.id); this.pump(); });
    }
  }
}

/** Child processes request permits from the web server instead of having independent limits. */
export function workerImageGate(): ImageGate {
  if (!process.send) return new ImageQueue(2);
  const pending = new Map<string, { resolve: (release: () => void) => void; reject: (error: Error) => void }>();
  const listener = (raw: unknown) => {
    const message = raw as { type?: string; requestId?: string };
    if (!message.requestId || !['image-granted', 'image-cancelled'].includes(message.type ?? '')) return;
    const waiter = pending.get(message.requestId); if (!waiter) return;
    pending.delete(message.requestId);
    if (message.type === 'image-cancelled') { waiter.reject(new QueueCancelled()); return; }
    let released = false;
    waiter.resolve(() => { if (!released) { released = true; process.send?.({ type: 'image-release', requestId: message.requestId }); } });
  };
  process.on('message', listener);
  return {
    acquire(taskId, sheetIndex) {
      const requestId = randomUUID();
      return new Promise((resolve, reject) => { pending.set(requestId, { resolve, reject }); process.send!({ type: 'image-acquire', taskId, sheetIndex, requestId }); });
    },
    cancelPending(taskId) { process.send?.({ type: 'image-cancel-pending', taskId }); },
    close() { process.off('message', listener); if (process.connected) process.disconnect(); },
  };
}
