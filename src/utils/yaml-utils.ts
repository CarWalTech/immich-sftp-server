export function getOptionalNestedString(source: Record<string, unknown>, path: string[], needsTrim: boolean = true): string | undefined
{
    let current: unknown = source;
    for (const part of path)
    {
        if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current))
        {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }

    if (typeof current !== 'string')
    {
        return undefined;
    }
    const normalized = needsTrim ? current.trim() : current;
    return normalized === '' ? undefined : normalized;
}

export function getOptionalNestedBoolean(source: Record<string, unknown>, path: string[]): boolean | undefined
{
    let current: unknown = source;
    for (const part of path)
    {
        if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current))
        {
            return undefined;
        }
        current = (current as Record<string, unknown>)[part];
    }

    if (typeof current === 'boolean')
    {
        return current;
    }
    if (typeof current !== 'string')
    {
        return undefined;
    }

    const normalized = current.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
    {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized))
    {
        return false;
    }
    return undefined;
}