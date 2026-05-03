import fs from 'fs';
import tmp from 'tmp';

export class FileUtils
{
    public static createTmpFile(content: string): tmp.FileResult
    {
        const tempFile = tmp.fileSync();
        fs.writeFileSync(tempFile.name, content, 'utf8');
        return tempFile;
    }

    public static createTmpFileFromBuffer(content: Buffer): tmp.FileResult
    {
        const tempFile = tmp.fileSync();
        fs.writeFileSync(tempFile.name, content, 'utf8');
        return tempFile;
    }
}