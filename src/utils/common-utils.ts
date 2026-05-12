export function isObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isObjectWithId(value: unknown): value is Record<string, unknown> & { id: unknown }
{
    return typeof value === 'object' && value !== null && !Array.isArray(value) && 'id' in value;
}