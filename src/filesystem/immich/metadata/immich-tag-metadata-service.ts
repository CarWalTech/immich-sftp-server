import { ImmichTagDirectoryInfo } from "../collections/tags/tag-folder";
import { ImmichUser } from "../utils/immich-album-utils";

export const TAG_METADATA_FILE_NAME = 'tag.yaml';

export function buildTagMetadataYamlForTag(tag: ImmichTagDirectoryInfo, currentUser: ImmichUser | null, baseUrl: string): string
{
    let metadata: Array<string> = [
        `id: ${JSON.stringify(tag.id)}`,
        `name: ${JSON.stringify(tag.name)}`,
        `value: ${JSON.stringify(tag.value)}`,
    ];

    return metadata.join('\n');
}