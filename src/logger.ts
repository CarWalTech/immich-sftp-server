import "fs";
import * as fs from "fs";
import { createStream, RotatingFileStream } from "rotating-file-stream";
import { BaseLogger, ILogObjMeta, ISettingsParam } from "tslog";
import { config } from "./config";


const IGNORED_COMBINATIONS: Record<string, string[]> = {}

export class LogfileUtils
{
    static output(logObj: any)
    {
        var object = JSON.parse(JSON.stringify(logObj))
        const argCount = Object.entries(object).length - 1

        var meta = object["_meta"]
        var date = meta["date"]
        var logLevelName = meta["logLevelName"]
        var fullFilePath = meta["path"]["fullFilePath"]
        var output = ""
        for (var i = 0; i < argCount; i++)
        {
            output += object[`${i}`]
            if (i + 1 < argCount) output += " "
        }

        return `${date} ${logLevelName}    [${fullFilePath}]\n${output}\n`
    }

    static formattedDate(date: Date)
    {
        const pad = (num: number) => (num > 9 ? "" : "0") + num;
        var month = date.getFullYear() + "" + pad(date.getMonth() + 1);
        var day = pad(date.getDate());
        var hour = pad(date.getHours());
        var minute = pad(date.getMinutes());
        return `${month}${day}_${hour}${minute}`
    }
}

export class SessionLogfileGenerator
{
    private static _startup: boolean;
    private static session_id: Date;
    private static session_id_str: string;
    private static rolling_filestream: RotatingFileStream

    static init()
    {
        this._startup = false;
        this.session_id = new Date();
        this.session_id_str = LogfileUtils.formattedDate(SessionLogfileGenerator.session_id);
        this.rolling_filestream = createStream(SessionLogfileGenerator.rolling_filename, {
            size: "10M",
            interval: "1d",
            history: SessionLogfileGenerator.history_filename(),
            maxFiles: 10,
        });
    }

    static sessions_dirname()
    {
        return `logs/sessions`;
    }

    static dirname()
    {
        return `${SessionLogfileGenerator.sessions_dirname()}/${SessionLogfileGenerator.session_id_str}`;
    }

    static history_filename()
    {
        return `${SessionLogfileGenerator.dirname()}/history.log`
    }

    static global_filename()
    {
        return `logs/runtime.log`
    }

    static rolling_filename(time: any, index: any)
    {
        if (time == null)
            return `${SessionLogfileGenerator.dirname()}/session.log`;
        else
            return `${SessionLogfileGenerator.dirname()}/session-${index}.log`;
    };

    static transport(logObj: any)
    {
        if (!SessionLogfileGenerator._startup)
        {
            if (fs.existsSync(SessionLogfileGenerator.global_filename()))
                fs.rmSync(SessionLogfileGenerator.global_filename())
            fs.writeFileSync(SessionLogfileGenerator.global_filename(), "")
            fs.mkdirSync(SessionLogfileGenerator.dirname(), { recursive: true })

            const sessionsDir = SessionLogfileGenerator.sessions_dirname();
            const folders = fs.readdirSync(sessionsDir)
                .filter(f => fs.statSync(`${sessionsDir}/${f}`).isDirectory())
                .sort();
            const excess = folders.length - config.LOGS_MAX_SESSIONS;
            if (excess > 0)
                folders.slice(0, excess).forEach(f => fs.rmSync(`${sessionsDir}/${f}`, { recursive: true }));

            SessionLogfileGenerator._startup = true;
        }

        fs.appendFileSync(SessionLogfileGenerator.global_filename(), LogfileUtils.output(logObj))
        SessionLogfileGenerator.rolling_filestream.write(LogfileUtils.output(logObj));
    }
};
SessionLogfileGenerator.init();

export class CustomLogger<LogObj> extends BaseLogger<LogObj>
{
    constructor(settings?: ISettingsParam<LogObj>, logObj?: LogObj)
    {
        super(settings, logObj, 5);
    }
    private is_ignored(args: unknown[])
    {
        if (args.length >= 3)
        {
            const key_str = `${args[0]}`
            if (IGNORED_COMBINATIONS[key_str] != undefined)
            {
                const val_str = `${args[1]}`
                const key = IGNORED_COMBINATIONS[key_str]
                if (key.length === 0) return true;
                if (key.find(x => x == val_str) !== undefined) return true
                else return false;
            }
        }
        return false;
    }
    private format_args(args: unknown[])
    {
        const new_args = args
        if (new_args.length == 1)
        {
            return new_args
        }
        else if (new_args.length == 2)
        {
            new_args[0] = `[${new_args[0]}]`
            return new_args
        }
        else if (args.length >= 3)
        {
            new_args[0] = `[${new_args[0]}]`
            new_args[1] = `[${new_args[1]}]`
            return new_args
        }
        else
        {
            return new_args
        }

    }

    public debug(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_DEBUG == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(2, "DEBUG", ...args);
    }
    public info(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_INFO == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(3, "INFO", ...args);
    }
    public warn(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_WARN == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(4, "WARN", ...args);
    }
    public error(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_ERROR == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(5, "ERROR", ...args);
    }
    public api(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_API == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(6, "API", ...args)
    }

    public explicit(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_EXPLICIT == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(7, "EXPLICIT", ...args)
    }

    public filesystem(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.LOGS_FILESYSTEM == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(8, "FILESYSTEM", ...args)
    }
}

export const logger = new CustomLogger({
    minLevel: 0,
    prettyLogTemplate: "{{yyyy}}.{{mm}}.{{dd}} {{hh}}:{{MM}}:{{ss}}:{{ms}}\t{{logLevelName}}\t[{{fullFilePath}}{{name}}]\n",
    prettyErrorTemplate: "\n{{errorName}} {{errorMessage}}\nerror stack:\n{{errorStack}}",
    prettyErrorStackTemplate: "  • {{fileName}}\t{{method}}\n\t{{filePathWithLine}}",
    prettyErrorParentNamesSeparator: ":",
    prettyErrorLoggerNameDelimiter: "\t",
    stylePrettyLogs: true,
    prettyLogTimeZone: "UTC",
    prettyLogStyles: {
        logLevelName: {
            "*": ["bold", "black", "bgWhiteBright", "dim"],
            SILLY: ["bold", "white"],
            TRACE: ["bold", "whiteBright"],
            DEBUG: ["bold", "green"],
            INFO: ["bold", "white"],
            WARN: ["bold", "yellow"],
            ERROR: ["bold", "red"],
            FATAL: ["bold", "redBright"],
            API: ["bold", "black", "bgYellow"],
            EXPLICIT: ["bold", "black", "bgGreen"],
            FILESYSTEM: ["bold", "magenta"],
        },
        fileName: ["yellow"],
        dateIsoStr: "white",
        filePathWithLine: "white",
        name: ["white", "bold"],
        nameWithDelimiterPrefix: ["white", "bold"],
        nameWithDelimiterSuffix: ["white", "bold"],
        errorName: ["bold", "bgRedBright", "whiteBright"]
    }
});


logger.attachTransport(SessionLogfileGenerator.transport);
