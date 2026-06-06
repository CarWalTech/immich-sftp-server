import path from "path";
import { BaseLogger, ILogObjMeta, ISettingsParam, ILogObj, Logger } from "tslog";
import { getEnvBoolean } from "./utils/env-utils";
import { createStream } from "rotating-file-stream";
import { config } from "./config";


const IGNORED_COMBINATIONS: Record<string, string[]> = {}




const fileGenerator = (time: any, index: any) =>
{
    const pad = (num: number) => (num > 9 ? "" : "0") + num;

    if (time == null) return "runtime.log";
    var date = (time as Date)
    var month = date.getFullYear() + "" + pad(date.getMonth() + 1);
    var day = pad(date.getDate());
    var hour = pad(date.getHours());
    var minute = pad(date.getMinutes());
    return `logs/runtime-${month}${day}-${hour}${minute}-${index}.log`;
};

const fileStream = createStream(fileGenerator, {
    size: "10M",
    interval: "1d",
    maxFiles: 10,
});

const fileTransport = (logObj: any) =>
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
    fileStream.write(`${date} ${logLevelName}    [${fullFilePath}]\n${output}\n`);
};

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
        if (config.ENABLE_DEBUG_LOGS == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(2, "DEBUG", ...args);
    }
    public info(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.ENABLE_INFO_LOGS == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(3, "INFO", ...args);
    }
    public warn(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.ENABLE_WARN_LOGS == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(4, "WARN", ...args);
    }
    public error(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.ENABLE_ERROR_LOGS == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(5, "ERROR", ...args);
    }
    public explicit(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (config.ENABLE_EXPLICIT_LOGS == false) return;
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(6, "EXPLICIT", ...args)
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
            EXPLICIT: ["bold", "black", "bgGreen"],
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

//logger.attachTransport(fileTransport);
