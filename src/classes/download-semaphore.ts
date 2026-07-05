/**
 * Counting semaphore with two priority levels.
 *
 * Callers that acquire() at 'high' will be served before any queued 'low'
 * callers when a slot becomes free. Within the same priority level the queue
 * is FIFO. Passing no priority defaults to 'low' so existing call sites need
 * no changes.
 */
export class DownloadSemaphore
{
    private readonly limit: number;
    private running = 0;
    private readonly highQueue: Array<() => void> = [];
    private readonly lowQueue: Array<() => void> = [];

    constructor(limit: number) { this.limit = limit; }

    private get hasFreeSpace()
    {
        if (this.limit === 0) return true;
        return this.running < this.limit;
    }

    acquire(priority: 'high' | 'low' = 'low'): Promise<void>
    {
        if (this.hasFreeSpace)
        {
            this.running++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve =>
        {
            const cb = () => { this.running++; resolve(); };
            if (priority === 'high') this.highQueue.push(cb);
            else this.lowQueue.push(cb);
        });
    }

    release(): void
    {
        this.running--;
        // Drain high-priority waiters before low-priority.
        const next = this.highQueue.shift() ?? this.lowQueue.shift();
        if (next) next();
    }
}
