import { DateTime } from "luxon"

export class DateUtils
{
    public static getDateNow()
    {
        return Date.now()
    }

    public static getEarliestTimeStringISO()
    {
        return this.getTimeStringISO(DateTime.local(1990, 1, 1, 0, 0, 0, 0))
    }

    public static getTimeStringISO(time: DateTime)
    {
        return time.toJSDate().toISOString()
    }
    public static getTimeStringNowISO()
    {
        return DateTime.now().toJSDate().toISOString()
    }

    public static getTimestampNow()
    {
        return Math.floor(Date.now() / 1000)
    }
    public static getTimestampOrNow(value?: string): number
    {
        const parsed = value ? Date.parse(value) : Number.NaN;
        if (!Number.isFinite(parsed) || parsed <= 0)
        {
            return this.getTimestampNow();
        }
        return Math.floor(parsed / 1000);
    }
}


