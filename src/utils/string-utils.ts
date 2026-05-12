export class StringUtils
{
    public static getTimestampOrNow(value?: string): number
    {
        const parsed = value ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0)
        {
            return Math.floor(Date.now() / 1000);
        }
        return Math.floor(parsed / 1000);
    }

    public static getTrimmedString(value: unknown): string
    {
        return typeof value === 'string' ? value.trim() : '';
    }
}
