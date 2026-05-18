export function requireEnv(name: string): string
{
    const val = process.env[name];
    if (!val)
    {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return val;
}

export function getEnvOrDefault(name: string, defaultValue: string): string
{
    const val = process.env[name];
    if (!val)
    {
        return defaultValue;
    }
    return val;
}

export function getOptionalEnv(name: string): string | undefined
{
    const val = process.env[name];
    if (!val)
    {
        return undefined;
    }
    const normalized = val.trim();
    return normalized === '' ? undefined : normalized;
}

export function getEnvBoolean(name: string, defaultValue: boolean): boolean
{
    const val = process.env[name];
    if (!val)
    {
        return defaultValue;
    }

    const normalized = val.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
    {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized))
    {
        return false;
    }

    throw new Error(`Invalid boolean environment variable ${name}: ${val}`);
}

export function getEnvByteSize(name: string, defaultValue: string): number
{
    const input = process.env[name] ?? defaultValue;
    if (!input) return 0;

    const trimmed = input.trim().toUpperCase();

    const match = trimmed.match(/^(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)?$/);
    if (!match)
    {
        throw new Error(`Invalid byte size format: "${input}"`);
    }

    const value = parseFloat(match[1]);
    const unit = match[2] ?? "B";

    const multipliers: Record<string, number> = {
        B: 1,
        KB: 1024,
        MB: 1024 ** 2,
        GB: 1024 ** 3,
        TB: 1024 ** 4,
    };

    return Math.floor(value * multipliers[unit]);

}


export function getEnvNumber(name: string, defaultValue: number): number
{
    const val = process.env[name];
    if (!val)
    {
        return defaultValue;
    }

    const parsed = Number(val);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535)
    {
        throw new Error(`Invalid numeric environment variable ${name}: ${val}. Expected an integer in range 1-65535.`);
    }
    return parsed;
}

export function getOptionalEnvNumber(name: string): number | undefined
{
    const val = process.env[name];
    if (!val)
    {
        return undefined;
    }

    const parsed = Number(val);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535)
    {
        throw new Error(`Invalid numeric environment variable ${name}: ${val}. Expected an integer in range 1-65535.`);
    }
    return parsed;
}