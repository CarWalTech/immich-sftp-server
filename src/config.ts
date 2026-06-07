import fs from 'fs';
import path from 'path';
import { logger } from './logger';
import { AssetDownloadSource, AssetFileNamePattern, getBoolOrDefault, parseAssetDownloadSource, parseAssetFileNamePattern } from './utils/config-utils';
import { getEnvBoolean, getEnvByteSize, getEnvNumber, getEnvOrDefault, getOptionalEnv, requireEnv } from './utils/env-utils';
import { getOptionalNestedBoolean, getOptionalNestedString } from './utils/yaml-utils';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class Config
{
  // immich settings
  IMMICH_HOST: string
  IMMICH_TIMEZONE: string
  IMMICH_USERDEFAULTS: UserConfig

  // server logging settings
  LOGS_DEBUG: boolean;
  LOGS_INFO: boolean;
  LOGS_WARN: boolean;
  LOGS_ERROR: boolean;
  LOGS_API: boolean;
  LOGS_EXPLICIT: boolean;
  LOGS_FILESYSTEM: boolean;

  // server protocols
  PROTOCOL_HOST: string
  PROTOCOL_ALLOW_SFTP: boolean
  PROTOCOL_ALLOW_WEBDAV: boolean
  PROTOCOL_PORTS_SFTP: number
  PROTOCOL_PORTS_WEBDAV: number

  // server settings
  OPTION_ENABLE_LOCAL_FILES: boolean
  OPTION_ENABLE_UPLOAD_VALIDATION: boolean
  OPTION_MAX_CONCURRENT_DOWNLOADS: number
  OPTION_MAX_READ_BATCH_SIZE: number
  OPTION_MAX_CACHE_BUFFER: number
  OPTION_SHARED_BUFFER_CACHE_CAP: number

  // server user defaults
  USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES: boolean
  USERDEFAULTS_ASSET_FILEPATTERN: AssetFileNamePattern
  USERDEFAULTS_ASSET_DOWNLOAD_SOURCE: AssetDownloadSource
  USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN: string
  USERDEFAULTS_ENABLE_ALBUM_LINKS: boolean;
  USERDEFAULTS_ENABLE_ALBUM_METADATA: boolean;
  USERDEFAULTS_ENABLE_TRASH_LINK: boolean;
  USERDEFAULTS_DIGIKAM_TRASH_COMPAT: boolean;

  constructor()
  {
    // immich settings
    this.IMMICH_HOST = requireEnv('SERVER_IMMICH_HOST');
    this.IMMICH_TIMEZONE = getEnvOrDefault('SERVER_IMMICH_TIMEZONE', 'UTC');
    this.IMMICH_USERDEFAULTS = UserConfigLoader.DEFAULTS

    // server logging
    this.LOGS_DEBUG = getEnvBoolean('SERVER_LOGS_DEBUG', false)
    this.LOGS_INFO = getEnvBoolean('SERVER_LOGS_INFO', true)
    this.LOGS_WARN = getEnvBoolean('SERVER_LOGS_WARN', true)
    this.LOGS_ERROR = getEnvBoolean('SERVER_LOGS_ERROR', true)
    this.LOGS_API = getEnvBoolean('SERVER_LOGS_API', false)
    this.LOGS_EXPLICIT = getEnvBoolean('SERVER_LOGS_EXPLICIT', true)
    this.LOGS_FILESYSTEM = getEnvBoolean('SERVER_LOGS_FILESYSTEM', false)

    // server protocol
    this.PROTOCOL_HOST = getEnvOrDefault('SERVER_PROTOCOL_HOST', '0.0.0.0');
    this.PROTOCOL_ALLOW_WEBDAV = getEnvBoolean('SERVER_PROTOCOL_ALLOW_WEBDAV', false);
    this.PROTOCOL_ALLOW_SFTP = getEnvBoolean('SERVER_PROTOCOL_ALLOW_SFTP', true);
    this.PROTOCOL_PORTS_SFTP = getEnvNumber('SERVER_PROTOCOL_PORTS_SFTP', 22);
    this.PROTOCOL_PORTS_WEBDAV = getEnvNumber('SERVER_PROTOCOL_PORTS_WEBDAV', 1900);

    // server settings
    this.OPTION_ENABLE_LOCAL_FILES = getEnvBoolean('SERVER_OPTION_ENABLE_LOCAL_FILES', false);
    this.OPTION_ENABLE_UPLOAD_VALIDATION = getEnvBoolean('SERVER_OPTION_ENABLE_UPLOAD_VALIDATION', true);
    this.OPTION_MAX_CONCURRENT_DOWNLOADS = getEnvNumber('SERVER_OPTION_MAX_CONCURRENT_DOWNLOADS', 6, true);
    this.OPTION_MAX_READ_BATCH_SIZE = getEnvNumber('SERVER_OPTION_MAX_READ_BATCH_SIZE', 50);
    this.OPTION_MAX_CACHE_BUFFER = getEnvByteSize('SERVER_OPTION_MAX_CACHE_BUFFER', '4MB')
    this.OPTION_SHARED_BUFFER_CACHE_CAP = getEnvNumber('SERVER_OPTION_SHARED_BUFFER_CACHE_CAP', 1000)

    // server user defaults
    this.USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES = getEnvBoolean('SERVER_USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES', true);
    this.USERDEFAULTS_ASSET_FILEPATTERN = parseAssetFileNamePattern(getOptionalEnv('SERVER_USERDEFAULTS_ASSET_FILEPATTERN')) ?? 'original';
    this.USERDEFAULTS_ASSET_DOWNLOAD_SOURCE = parseAssetDownloadSource(getOptionalEnv('SERVER_USERDEFAULTS_ASSET_DOWNLOAD_SOURCE')) ?? 'original';
    this.USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN = getEnvOrDefault('SERVER_USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN', " / ");
    this.USERDEFAULTS_ENABLE_ALBUM_LINKS = getEnvBoolean('SERVER_USERDEFAULTS_ENABLE_ALBUM_LINKS', true);
    this.USERDEFAULTS_ENABLE_ALBUM_METADATA = getEnvBoolean('SERVER_USERDEFAULTS_ENABLE_ALBUM_METADATA', true);
    this.USERDEFAULTS_ENABLE_TRASH_LINK = getEnvBoolean('SERVER_USERDEFAULTS_ENABLE_TRASH_LINK', true);
    this.USERDEFAULTS_DIGIKAM_TRASH_COMPAT = getEnvBoolean('SERVER_USERDEFAULTS_DIGIKAM_TRASH_COMPAT', false);
  }
}

export interface UserConfig
{
  subAlbumSeperator: string
  assetFileNamePattern: AssetFileNamePattern
  assetDownloadSource: AssetDownloadSource
  assetSidecarsEnabled: boolean
  enableAlbumLinks: boolean
  enableAlbumMetadata: boolean
  enableTrashLink: boolean
  digikamTrashCompat: boolean
}

export class UserConfigLoader
{
  static readonly DEFAULTS: UserConfig = UserConfigLoader.load_defaults()

  public static load_user(user_id: string | undefined, view_id: string | null = null): UserConfig
  {
    return this.read_user_json(user_id, view_id)
  }
  public static load_user_or_default(user_id?: string, view_id: string | null = null): UserConfig
  {
    return this.read_user_json(user_id, view_id)
  }
  public static load_user_json(user_id: string | undefined, view_id: string | null): string
  {
    try
    {
      const result = this.load_user(user_id, view_id)
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
    const envSubAlbumSeperator = getOptionalNestedString(json, ['subAlbumSeperator'], false)
    const envEnableSidecarFiles = getOptionalNestedBoolean(json, ['assetSidecarsEnabled'])
    const envEnableAlbumLinks = getOptionalNestedBoolean(json, ['enableAlbumLinks'])
    const envEnableAlbumMetadata = getOptionalNestedBoolean(json, ['enableAlbumMetadata'])
    const envEnableTrashLink = getOptionalNestedBoolean(json, ['enableTrashLink'])
    const envDigikamTrashCompat = getOptionalNestedBoolean(json, ['digikamTrashCompat'])
    return {
      subAlbumSeperator: envSubAlbumSeperator ?? this.DEFAULTS.subAlbumSeperator,
      assetDownloadSource: envDownloadSource ?? this.DEFAULTS.assetDownloadSource,
      assetFileNamePattern: envFileNamePattern ?? this.DEFAULTS.assetFileNamePattern,
      assetSidecarsEnabled: getBoolOrDefault(envEnableSidecarFiles, this.DEFAULTS.assetSidecarsEnabled),
      enableAlbumLinks: getBoolOrDefault(envEnableAlbumLinks, this.DEFAULTS.enableAlbumLinks),
      enableAlbumMetadata: getBoolOrDefault(envEnableAlbumMetadata, this.DEFAULTS.enableAlbumMetadata),
      enableTrashLink: getBoolOrDefault(envEnableTrashLink, this.DEFAULTS.enableTrashLink),
      digikamTrashCompat: getBoolOrDefault(envDigikamTrashCompat, this.DEFAULTS.digikamTrashCompat)
    }
  }
  public static load_defaults(): UserConfig
  {
    var config = new Config();
    return {
      subAlbumSeperator: config.USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN,
      assetFileNamePattern: config.USERDEFAULTS_ASSET_FILEPATTERN,
      assetDownloadSource: config.USERDEFAULTS_ASSET_DOWNLOAD_SOURCE,
      assetSidecarsEnabled: config.USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES,
      enableAlbumLinks: config.USERDEFAULTS_ENABLE_ALBUM_LINKS,
      enableAlbumMetadata: config.USERDEFAULTS_ENABLE_ALBUM_METADATA,
      enableTrashLink: config.USERDEFAULTS_ENABLE_TRASH_LINK,
      digikamTrashCompat: config.USERDEFAULTS_DIGIKAM_TRASH_COMPAT
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
  private static read_user_json(userId?: string, view_id: string | null = null): UserConfig
  {
    const settingsFilePath = this.resolve_user_path(userId, view_id);
    if (!settingsFilePath) return this.DEFAULTS;

    //logger.explicit("UserConfigLoader", "JSON", `Reading file from path: ${settingsFilePath}`)

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

  public static save_user(userId: string | undefined, viewId: string | null, data: UserConfigLoader): boolean
  {
    const settingsFilePath = this.resolve_user_path(userId, viewId);
    if (!settingsFilePath)
    {
      logger.error("UserScopedConfig", "SaveJSON", "Path not found for user id / viewId: ", `${userId} / ${viewId}`)
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
  private static resolve_user_path(userId?: string, viewId: string | null = null): string | undefined
  {
    const settingsFilePath = "/config/prefs/{fileName}.json"

    const candidates: string[] = [];
    const normalizedUserId = userId?.trim();
    const normalizedViewId = viewId != null ? `.${viewId.trim()}` : ""
    const normalizedFileName = `${normalizedUserId}${normalizedViewId}`;

    if (normalizedUserId && UUID_PATTERN.test(normalizedUserId))
    {
      if (settingsFilePath.includes('{fileName}'))
      {
        candidates.push(settingsFilePath.replace(/\{fileName\}/g, normalizedFileName));
      }
      else
      {
        const parsed = path.parse(settingsFilePath);
        const fileName = `${parsed.name}.${normalizedFileName}${parsed.ext}`;
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
