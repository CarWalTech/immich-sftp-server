/**
 * Bounded-concurrency map.
 *
 * `Promise.all(items.map(fn))` starts every task at once — fine for a handful of
 * nodes, catastrophic for a 5,000-asset album where each task may open a socket
 * or a file descriptor.  mapLimit keeps at most `limit` tasks in flight while
 * preserving input order in the result array.
 *
 * A rejection propagates (same semantics as Promise.all) but in-flight workers
 * are allowed to settle first so nothing is left dangling.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]>
{
    const total = items.length;
    if (total === 0) return [];

    const effectiveLimit = Math.max(1, Math.min(Math.floor(limit) || 1, total));
    if (effectiveLimit >= total) return Promise.all(items.map((item, i) => fn(item, i)));

    const results = new Array<R>(total);
    let next = 0;
    let firstError: unknown;
    let failed = false;

    const worker = async (): Promise<void> =>
    {
        while (true)
        {
            const index = next++;
            if (index >= total || failed) return;
            try
            {
                results[index] = await fn(items[index], index);
            }
            catch (err)
            {
                if (!failed) { failed = true; firstError = err; }
                return;
            }
        }
    };

    await Promise.all(Array.from({ length: effectiveLimit }, () => worker()));
    if (failed) throw firstError;
    return results;
}

/**
 * Like mapLimit but never rejects — mirrors Promise.allSettled.  Used where a
 * single bad node (deleted mid-listing, permission error) must not abort the
 * whole directory.
 */
export async function mapLimitSettled<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]>
{
    return mapLimit(items, limit, async (item, index) =>
    {
        try { return { status: 'fulfilled', value: await fn(item, index) } as PromiseFulfilledResult<R>; }
        catch (reason) { return { status: 'rejected', reason } as PromiseRejectedResult; }
    });
}
