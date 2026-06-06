import fs from 'fs';
import path from 'path';
import { getEnvBoolean, getEnvByteSize, getOptionalEnvNumberRange, getEnvNumber, getEnvOrDefault, getOptionalEnv, getOptionalEnvNumber, requireEnv, NumberRange } from './utils/env-utils';
import { logger } from './logger';
import { getOptionalNestedString } from './utils/yaml-utils';
import { AssetDownloadSource, AssetFileNamePattern, parseAssetDownloadSource, parseAssetFileNamePattern } from './utils/config-utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SHARED_BUFFER_CACHE_CAP = 1000;

export class Config
{
  // immich settings
  immichHost: string
  immichTimezone: string
  immichUserDefaults: UserConfig

  // server protocols
  enableSFTP: boolean
  enableWebDAV: boolean

  // server hostname
  serverHost: string

  // server ports
  portSFTP: number
  portWebDAV: number
  portPassiveFTP?: NumberRange

  // server feature toggles
  enableLocalFiles: boolean
  enableUploadValidation: boolean

  // server size settings
  maxConcurrentDLs: number
  maxReadBatchSize: number
  maxCacheBufferSize: number

  // server asset / album settings
  assetSidecarsEnabled: boolean
  assetFilePattern: AssetFileNamePattern
  assetDownloadSource: AssetDownloadSource
  albumFolderSeperator: string

  // server logging settings
  ENABLE_DEBUG_LOGS: boolean;
  ENABLE_INFO_LOGS: boolean;
  ENABLE_WARN_LOGS: boolean;
  ENABLE_ERROR_LOGS: boolean;
  ENABLE_EXPLICIT_LOGS: boolean;


  constructor()
  {
    // immich settings
    this.immichHost = requireEnv('IMMICH_HOST');
    this.immichTimezone = getEnvOrDefault('IMMICH_TIMEZONE', 'UTC');
    this.immichUserDefaults = UserConfigLoader.DEFAULTS

    // server modes
    this.enableSFTP = getEnvBoolean('SERVER_ENABLE_SFTP', true);
    this.enableWebDAV = getEnvBoolean('SERVER_ENABLE_WEBDAV', false);

    // server hostname
    this.serverHost = getEnvOrDefault('SERVER_HOST', '0.0.0.0');

    // server ports
    this.portSFTP = getEnvNumber('SERVER_PORT_SFTP', 22);
    this.portWebDAV = getEnvNumber('SERVER_PORT_WEBDAV', 1900);

    // server settings
    this.enableLocalFiles = getEnvBoolean('SERVER_OPTION_ENABLE_LOCAL_FILES', false);
    this.enableUploadValidation = getEnvBoolean('SERVER_OPTION_ENABLE_UPLOAD_VALIDATION', true);

    // server size settings
    this.maxConcurrentDLs = getEnvNumber('SERVER_OPTION_MAX_CONCURRENT_DOWNLOADS', 6, true);
    this.maxReadBatchSize = getEnvNumber('SERVER_OPTION_MAX_READ_BATCH_SIZE', 50);
    this.maxCacheBufferSize = getEnvByteSize('SERVER_OPTION_MAX_CACHE_BUFFER', '4MB')

    // server asset / album settings
    this.assetSidecarsEnabled = getEnvBoolean('SERVER_OPTION_ASSET_ENABLE_SIDECAR_FILES', true);
    this.assetFilePattern = parseAssetFileNamePattern(getOptionalEnv('SERVER_OPTION_ASSET_FILEPATTERN')) ?? 'original';
    this.assetDownloadSource = parseAssetDownloadSource(getOptionalEnv('SERVER_OPTION_ASSET_DOWNLOAD_SOURCE')) ?? 'original';
    this.albumFolderSeperator = getEnvOrDefault('SERVER_OPTION_ALBUM_SUBFOLDER_PATTERN', " / ");

    this.ENABLE_DEBUG_LOGS = getEnvBoolean('SERVER_LOGS_DEBUG', false)
    this.ENABLE_INFO_LOGS = getEnvBoolean('SERVER_LOGS_INFO', true)
    this.ENABLE_WARN_LOGS = getEnvBoolean('SERVER_LOGS_WARN', true)
    this.ENABLE_ERROR_LOGS = getEnvBoolean('SERVER_LOGS_ERROR', true)
    this.ENABLE_EXPLICIT_LOGS = getEnvBoolean('SERVER_LOGS_EXPLICIT', false)
  }
}

export interface UserConfig
{
  subAlbumSeperator: string
  assetFileNamePattern: AssetFileNamePattern
  assetDownloadSource: AssetDownloadSource
}

export class UserConfigLoader
{
  static readonly DEFAULTS: UserConfig = UserConfigLoader.load_defaults()

  public static load_user(user_id: string | undefined): UserConfig
  {
    return this.read_user_json(user_id)
  }
  public static load_user_or_default(user_id?: string): UserConfig
  {
    return this.read_user_json(user_id)
  }
  public static load_user_json(user_id: string | undefined): string
  {
    try
    {
      const result = this.load_user(user_id)
      return JSON.stringify(result, null, 2)
    }
    catch
    {
      return ""
    }
  }
  public static load_user_from_json(content: string, filePath: string = "internal"): UserConfig
  {
    const json = this.read_json(content, filePath)
    const envFileNamePattern = parseAssetFileNamePattern(getOptionalNestedString(json, ['assetFileNamePattern']));
    const envDownloadSource = parseAssetDownloadSource(getOptionalNestedString(json, ['assetDownloadSource']));
    const envSubAlbumSeperator = getOptionalNestedString(json, ['subAlbumSeperator'])
    return {
      subAlbumSeperator: envSubAlbumSeperator ?? this.DEFAULTS.subAlbumSeperator,
      assetDownloadSource: envDownloadSource ?? this.DEFAULTS.assetDownloadSource,
      assetFileNamePattern: envFileNamePattern ?? this.DEFAULTS.assetFileNamePattern
    }
  }
  public static load_defaults(): UserConfig
  {
    var config = new Config();
    return {
      subAlbumSeperator: config.albumFolderSeperator,
      assetFileNamePattern: config.assetFilePattern,
      assetDownloadSource: config.assetDownloadSource
    }
  }

  private static read_json(content: string, filePath: string = "internal")
  {
    const parsed = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    {
      throw new Error(`Invalid settings file '${filePath}': expected a JSON object.`);
    }
    return parsed as Record<string, unknown>;
  }
  private static read_user_json(userId?: string): UserConfig
  {
    const settingsFilePath = this.resolve_user_path(userId);
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
        return this.load_user_from_json(content, settingsFilePath)
      }
      catch
      {
        return this.DEFAULTS
      }

    }


  }

  public static save_user(userId: string | undefined, data: UserConfigLoader): boolean
  {
    const settingsFilePath = this.resolve_user_path(userId);
    if (!settingsFilePath)
    {
      logger.error("UserScopedConfig", "SaveJSON", "Path not found for user id: ", userId)
      return false;
    }

    try
    {
      const dir = path.dirname(settingsFilePath);
      fs.mkdirSync(dir, { recursive: true });

      const jsonStr = JSON.stringify(data, null, 2);

      fs.writeFileSync(settingsFilePath, jsonStr, "utf8");
    }
    catch (ex)
    {
      logger.error("UserScopedConfig", "SaveJSON", "Error Saving JSON: ", ex)
      return false;
    }
    return true;
  }
  private static resolve_user_path(userId?: string): string | undefined
  {
    const settingsFilePath = "/config/prefs/{userId}.json"

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
}

export const config = new Config();
