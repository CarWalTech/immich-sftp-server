import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { getEnvBoolean, getEnvNumber, getEnvOrDefault, getOptionalEnv, getOptionalEnvNumber, requireEnv } from './utils/env-utils';
import { logger } from './logger';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AssetFileNamePattern = 'original' | 'assetUuid' | 'shortUuid' | 'date' | 'dateUuid';
export type AssetDownloadSource = 'original' | 'preview';
export type UserDisplaySettings = {
  tagsEnabled: boolean;
};




export class Config
{
  // immich instance
  immichHost: string
  immichDefaults: UserScopedConfig


  // ip/port
  listenHost: string

  // ftp
  enableFtp: boolean
  ftpPort: number
  ftpPassiveHost?: string
  ftpPassivePortMin?: number
  ftpPassivePortMax?: number

  // sftp
  enableSftp: boolean
  sftpPort: number

  // webdav
  enableWebdav: boolean
  webdavPort: number

  // server settings
  TZ: string
  readBatchSize: number
  localFilesMode: boolean
  maxConcurrentDownloads: number


  constructor()
  {
    const ftpPassivePortMin = getOptionalEnvNumber('FTP_PASSIVE_PORT_MIN');
    const ftpPassivePortMax = getOptionalEnvNumber('FTP_PASSIVE_PORT_MAX');


    if ((ftpPassivePortMin == null) !== (ftpPassivePortMax == null))
      throw new Error('FTP_PASSIVE_PORT_MIN and FTP_PASSIVE_PORT_MAX must both be set or both be unset.');

    if (ftpPassivePortMin != null && ftpPassivePortMax != null && ftpPassivePortMin > ftpPassivePortMax)
      throw new Error('FTP_PASSIVE_PORT_MIN must be less than or equal to FTP_PASSIVE_PORT_MAX.');


    // immich instance
    this.immichHost = requireEnv('IMMICH_HOST');
    this.immichDefaults = UserScopedConfig.DEFAULTS

    // ip/port
    this.listenHost = getEnvOrDefault('LISTEN_HOST', '0.0.0.0');

    // ftp
    this.enableFtp = getEnvBoolean('ENABLE_FTP', false);
    this.ftpPort = getEnvNumber('FTP_PORT', 21);
    this.ftpPassiveHost = getOptionalEnv('FTP_PASSIVE_HOST');
    this.ftpPassivePortMin;
    this.ftpPassivePortMax;

    // sftp
    this.enableSftp = getEnvBoolean('ENABLE_SFTP', true);
    this.sftpPort = getEnvNumber('SFTP_PORT', 22);

    // webdav
    this.enableWebdav = getEnvBoolean('ENABLE_WEBDAV', false);
    this.webdavPort = getEnvNumber('WEBDAV_PORT', 1900);

    // server settings
    this.TZ = getEnvOrDefault('TZ', 'UTC');
    this.readBatchSize = getEnvNumber('READ_BATCH_SIZE', 50);
    this.localFilesMode = getEnvBoolean('LOCAL_FILES_MODE', false);
    this.maxConcurrentDownloads = getEnvNumber('MAX_CONCURRENT_DOWNLOADS', 6);
  }
};

export class UserScopedConfig
{
  subAlbumSeperator: string = " / "
  assetFileNamePattern: AssetFileNamePattern = 'original'
  enableTagsFolder: boolean = true

  static readonly DEFAULTS: UserScopedConfig = this.load_defaults()

  public static load_defaults()
  {
    const envFileNamePattern = parseAssetFileNamePattern(getOptionalEnv('ASSET_FILENAME_PATTERN'));
    const envDownloadSource = parseAssetDownloadSource(getOptionalEnv('ASSET_DOWNLOAD_SOURCE'));

    const result = new UserScopedConfig()
    result.subAlbumSeperator = getEnvOrDefault('SUB_ALBUM_SEPERATOR', result.subAlbumSeperator);
    result.assetFileNamePattern = envFileNamePattern ?? result.assetFileNamePattern;
    result.enableTagsFolder = getEnvBoolean('ENABLE_TAGS_FOLDER_DEFAULT', true);

    return result
  }
  public static load_user(user_id: string | undefined): UserScopedConfig
  {
    return this.read_user_yaml(user_id)
  }
  public static load_user_yaml(user_id: string | undefined): string
  {
    try
    {
      const result = this.load_user(user_id)
      return YAML.stringify(result)
    }
    catch
    {
      return ""
    }
  }
  public static load_user_display(user_id: string | undefined, preferences: any): UserDisplaySettings
  {
    const results = this.load_user(user_id)

    const is_tags_enabled = typeof preferences?.tags?.enabled === 'boolean' ? preferences.tags.enabled : false

    return {
      tagsEnabled: is_tags_enabled ? results.enableTagsFolder : false
    }
  }
  public static load_user_from_yaml(content: string, path: string = "internal"): UserScopedConfig
  {
    const yaml = this.read_yaml(content, path)

    const envFileNamePattern = parseAssetFileNamePattern(getOptionalNestedString(yaml, ['assetFileNamePattern']));
    const envEnableTagsFolder = getOptionalNestedBoolean(yaml, ['enableTagsFolder'])
    const envSubAlbumSeperator = getOptionalNestedString(yaml, ['subAlbumSeperator'])

    const user_result = new UserScopedConfig()
    user_result.assetFileNamePattern = envFileNamePattern ?? this.DEFAULTS.assetFileNamePattern
    user_result.enableTagsFolder = envEnableTagsFolder ?? this.DEFAULTS.enableTagsFolder
    user_result.subAlbumSeperator = envSubAlbumSeperator ?? this.DEFAULTS.subAlbumSeperator
    return user_result
  }
  public static save_user(userId: string | undefined, data: UserScopedConfig): boolean
  {
    const settingsFilePath = this.resolve_path(userId);
    if (!settingsFilePath)
    {
      logger.error("UserScopedConfig", "SaveYAML", "Path not found for user id: ", userId)
      return false;
    }

    try
    {
      // 1. Ensure directory exists
      const dir = path.dirname(settingsFilePath);
      fs.mkdirSync(dir, { recursive: true });

      // 2. Convert to YAML
      const yamlStr = YAML.stringify(data);

      // 3. Write file (creates if missing)
      fs.writeFileSync(settingsFilePath, yamlStr, "utf8");
    }
    catch (ex)
    {
      logger.error("UserScopedConfig", "SaveYAML", "Error Saving YAML: ", ex)
      return false;
    }
    return true;
  }

  private static read_yaml(content: string, path: string = "internal")
  {
    const parsed = YAML.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    {
      throw new Error(`Invalid settings file '${path}': expected a YAML object.`);
    }
    return parsed as Record<string, unknown>;
  }
  private static read_user_yaml(userId?: string): UserScopedConfig
  {
    const settingsFilePath = this.resolve_path(userId);
    if (!settingsFilePath) return this.DEFAULTS;

    if (!fs.existsSync(settingsFilePath))
    {
      return this.DEFAULTS
    }
    else
    {
      try
      {
        const content = fs.readFileSync(settingsFilePath, 'utf8');
        return this.load_user_from_yaml(content, settingsFilePath)
      }
      catch
      {
        return this.DEFAULTS
      }

    }


  }
  private static resolve_path(userId?: string): string | undefined
  {
    const settingsFilePath = getEnvOrDefault('SETTINGS_FILE_PATH', './config/{userId}.yaml');
    const candidates: string[] = [];
    const normalizedUserId = userId?.trim();
    if (normalizedUserId && UUID_PATTERN.test(normalizedUserId))
    {
      if (settingsFilePath.includes('{userId}'))
      {
        candidates.push(settingsFilePath.replace(/\{userId\}/g, normalizedUserId));
      }
      else
      {
        const parsed = path.parse(settingsFilePath);
        const fileName = `${parsed.name}.${normalizedUserId}${parsed.ext}`;
        candidates.push(parsed.dir ? path.join(parsed.dir, fileName) : fileName);
      }
    }
    candidates.push(settingsFilePath);

    const candidatePath = candidates.at(0);
    if (candidatePath) return candidatePath;
    else return undefined;
  }

};





function getOptionalNestedString(source: Record<string, unknown>, path: string[]): string | undefined
{
  let current: unknown = source;
  for (const part of path)
  {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current))
    {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current !== 'string')
  {
    return undefined;
  }
  const normalized = current.trim();
  return normalized === '' ? undefined : normalized;
}

function getOptionalNestedBoolean(source: Record<string, unknown>, path: string[]): boolean | undefined
{
  let current: unknown = source;
  for (const part of path)
  {
    if (typeof current !== 'object' || current === null || Array.isArray(current) || !(part in current))
    {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'boolean')
  {
    return current;
  }
  if (typeof current !== 'string')
  {
    return undefined;
  }

  const normalized = current.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized))
  {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized))
  {
    return false;
  }
  return undefined;
}













function parseAssetFileNamePattern(value: string | undefined): AssetFileNamePattern | undefined
{
  if (!value)
  {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const byValue: Record<string, AssetFileNamePattern> = {
    original: 'original',
    asset_uuid: 'assetUuid',
    assetuuid: 'assetUuid',
    uuid: 'assetUuid',
    short_uuid: 'shortUuid',
    shortuuid: 'shortUuid',
    date: 'date',
    date_uuid: 'dateUuid',
    dateuuid: 'dateUuid',
  };
  const parsed = byValue[normalized];
  if (!parsed)
  {
    throw new Error(`Invalid asset file name pattern: ${value}. Allowed: original, assetUuid, shortUuid, date, dateUuid.`);
  }
  return parsed;
}

function parseAssetDownloadSource(value: string | undefined): AssetDownloadSource | undefined
{
  if (!value)
  {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  const byValue: Record<string, AssetDownloadSource> = {
    original: 'original',
    preview: 'preview',
    thumbnail: 'preview',
  };
  const parsed = byValue[normalized];
  if (!parsed)
  {
    throw new Error(`Invalid asset download source: ${value}. Allowed: original, preview.`);
  }
  return parsed;
}

export function loadSettingsForUser(user_id?: string): UserScopedConfig
{
  return UserScopedConfig.load_user(user_id)
}

export const config = new Config();
