

import { logger } from './logger';
import type { TransferProtocolServer } from './protocols/transfer-protocol-server';

async function startServers(): Promise<void>
{
  const [{ config }, { SftpProtocolServer }, { WebdavProtocolServer }] = await Promise.all([
    import('./config'),
    import('./protocols/sftp-server'),
    import('./protocols/webdav-server'),
  ]);
  const servers: TransferProtocolServer[] = [];

  if (config.enableSFTP)
  {
    servers.push(new SftpProtocolServer());
  }
  if (config.enableWebDAV)
  {
    servers.push(new WebdavProtocolServer());
  }

  if (servers.length === 0)
  {
    throw new Error('No transfer protocol enabled. Set SERVER_ENABLE_SFTP and/or SERVER_ENABLE_WEBDAV (accepted values: true/1/yes/on or false/0/no/off).');
  }

  await Promise.all(servers.map((server) => server.start()));
  logger.info('SERVER', 'MAIN', `Enabled protocols: ${servers.map((server) => server.name).join(', ')}`)
}

startServers().catch((error) =>
{
  logger.error('SERVER', 'MAIN', 'Failed to initialize or start transfer servers:', error)
  process.exit(1);
});
