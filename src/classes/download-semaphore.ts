/**
 * Lightweight counting semaphore for concurrency control.
 */
export class DownloadSemaphore
{
    private readonly limit: number;
    private running = 0;
    private readonly queue: Array<() => void> = [];

    constructor(limit: number) { this.limit = limit; }

    private get hasFreeSpace()
    {
        if (this.limit == 0) return true;
        return this.running < this.limit;
    }

    acquire(): Promise<void>
    {
        if (this.hasFreeSpace)
        {
            this.running++;
            return Promise.resolve();
        }
        return new Promise<void>(resolve =>
        {
            this.queue.push(() => { this.running++; resolve(); });
        });
    }

    release(): void
    {
        this.running--;
        const next = this.queue.shift();
        if (next) next();
    }
}
