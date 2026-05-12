export class DateUtils
{
    static getDateTimeNow()
    {
        return Math.floor(Date.now() / 1000)
    }
}