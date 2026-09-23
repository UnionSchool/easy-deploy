import { type Target } from './config.js';
import { FtpTransport } from './ftp.js';
import { SftpTransport } from './sftp.js';

export interface RemoteEntry { name: string; directory: boolean; link?: boolean }
export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  upload(local: string, remote: string): Promise<void>;
  mkdir(remote: string): Promise<void>;
  download(remote: string, local: string): Promise<void>;
  list(remote: string): Promise<RemoteEntry[]>;
  exists(remote: string): Promise<boolean>;
  isDirectory(remote: string): Promise<boolean>;
  isLink(remote: string): Promise<boolean>;
  remove(remote: string): Promise<void>;
}

export function createTransport(target: Target): Transport {
  return target.driver === 'sftp' ? new SftpTransport(target) : new FtpTransport(target);
}
