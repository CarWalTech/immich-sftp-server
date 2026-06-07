import { DateTime } from "luxon"

export class DateUtils
{
    public static getEarliestTimeStringISO()
    {
        return this.getTimeStringISO(DateTime.local(1970, 1, 1, 0, 0, 0, 0))
    }
    public static getTimeStringISO(time: DateTime)
    {
        return time.toJSDate().toISOString()
    }
    public static getTimeStringNowISO()
    {
        return DateTime.now().toJSDate().toISOString()
    }
}

export class Timestamp
{
    private raw: number

    constructor(input: number)
    {
        this.raw = input
    }

    static now()
    {
        return new Timestamp(Date.now())
    }

    static currentTime()
    {
        return Math.floor(Date.now() / 1000)
    }

    static fromNullableString(value?: string)
    {
        const parsed = value ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) return null
        return new Timestamp(parsed)
    }

    static fromString(value?: string)
    {
        const parsed = value ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0) return Timestamp.now()
        return new Timestamp(parsed);
    }

    datetime(tz: string)
    {
        return DateTime.fromSeconds(this.value(), { zone: tz });
    }

    value(floored: boolean = false)
    {
        if (floored) return this.raw;
        return Math.floor(this.raw / 1000);
    }
}


