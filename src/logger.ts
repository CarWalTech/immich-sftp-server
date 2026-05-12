import path from "path";
import { BaseLogger, ILogObjMeta, ISettingsParam, ILogObj, Logger } from "tslog";

const IGNORED_COMBINATIONS: Record<string, string[]> = {
    "SFTP": [
        "LSTAT"
    ]
}


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

    public info(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        if (this.is_ignored(args)) return;
        args = this.format_args(args)
        return super.log(0, "INFO", ...args);
    }
    public warn(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        return super.log(1, "WARN", ...args);
    }
    public error(...args: unknown[]): LogObj & ILogObjMeta | undefined
    {
        return super.log(2, "ERROR", ...args);
    }

}
const srcFilename = path.join(__dirname, "../");

export const logger = new CustomLogger({
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