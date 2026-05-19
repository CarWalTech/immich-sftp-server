
export class StringUtils2
{
    public static getTrimmedString(value: unknown): string
    {
        return typeof value === 'string' ? value.trim() : '';
    }
}

