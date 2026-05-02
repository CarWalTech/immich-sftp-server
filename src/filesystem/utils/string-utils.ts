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

    public static looksLikeEmail(value: string): boolean
    {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    public static getTrimmedString(value: unknown): string
    {
        return typeof value === 'string' ? value.trim() : '';
    }

    public static redactSensitiveFields(data: unknown): unknown
    {
        const sensitiveKeys = new Set(['password', 'token', 'accessToken', 'authorization', 'x-api-key', 'apiKey']);

        if (Array.isArray(data))
        {
            return data.map(item => this.redactSensitiveFields(item));
        }

        if (typeof data !== 'object' || data === null)
        {
            return data;
        }

        const redacted: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(data))
        {
            if (sensitiveKeys.has(key))
            {
                redacted[key] = '[REDACTED]';
                continue;
            }
            redacted[key] = this.redactSensitiveFields(value);
        }
        return redacted;
    }
}
