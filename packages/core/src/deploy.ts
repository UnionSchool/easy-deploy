import { lstat, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DeployError, type Target } from './config.js';
import { collectEntries } from './files.js';
import { remotePath, relativeRemote, resolveInside } from './paths.js';
import type { Transport } from './transport.js';

export interface TransferItem { local: string; remote: string; relative: string; directory?: boolean }

export async function uploadPlan(configDir: string, target: Target, paths: string[]): Promise<TransferItem[]> {
  const root = path.resolve(configDir, target.local);
  const files = new Set<string>();
  const directories = new Set<string>();
  for (const input of paths) {
    const entries = await collectEntries(configDir, target, input);
    for (const file of entries.files) files.add(file);
    for (const directory of entries.emptyDirectories) directories.add(directory);
  }
  const folderItems = [...directories].sort().map(relative => ({ relative, local: resolveInside(root, relative), remote: remotePath(target.remote, relative), directory: true }));
  const fileItems = [...files].sort().map(relative => ({ relative, local: resolveInside(root, relative), remote: remotePath(target.remote, relative) }));
  return [...folderItems, ...fileItems];
}

export async function downloadPlan(configDir: string, target: Target, input: string, transport: Transport): Promise<TransferItem[]> {
  const relative = relativeRemote(target.remote, input);
  const base = remotePath(target.remote, relative);
  const remoteRoot = path.posix.normalize(target.remote);
  for (let parent = path.posix.dirname(base); parent !== '/' && (remoteRoot === '/' || parent === remoteRoot || parent.startsWith(`${remoteRoot}/`)); parent = path.posix.dirname(parent)) {
    if (await transport.isLink(parent)) throw new DeployError('path', `远程路径包含符号链接：${parent}`);
  }
  if (!await transport.exists(base)) throw new DeployError('path', `远程路径不存在：${base}`);
  const root = path.resolve(configDir, target.local);
  const result: TransferItem[] = [];
  async function walk(remote: string, relativePath: string): Promise<void> {
    if (await transport.isLink(remote)) throw new DeployError('path', `不下载远程符号链接：${remote}`);
    if (await transport.isDirectory(remote)) {
      result.push({ relative: relativePath, local: resolveInside(root, relativePath), remote, directory: true });
      for (const entry of await transport.list(remote)) {
        if (entry.name === '.' || entry.name === '..' || entry.name.includes('/') || entry.name.includes('\\')) {
          throw new DeployError('path', `远程目录项无效：${entry.name}`);
        }
        await walk(path.posix.join(remote, entry.name), path.posix.join(relativePath, entry.name));
      }
    } else {
      result.push({ relative: relativePath, local: resolveInside(root, relativePath), remote });
    }
  }
  await walk(base, relative);
  return result;
}

export async function executeUpload(items: TransferItem[], transport: Transport, onProgress?: (item: TransferItem) => void): Promise<void> {
  for (const item of items) {
    try {
      if (item.directory) await transport.mkdir(item.remote);
      else await transport.upload(item.local, item.remote);
      onProgress?.(item);
    }
    catch (error) { throw new DeployError('transfer', `上传失败：${item.relative} (${String(error)})`); }
  }
}

export async function executeDownload(items: TransferItem[], root: string, transport: Transport, onProgress?: (item: TransferItem) => void): Promise<void> {
  for (const item of items) {
    const parent = path.dirname(item.local);
    await assertSafeDestination(root, item.local);
    if (item.directory) { await mkdir(item.local, { recursive: true }); onProgress?.(item); continue; }
    await mkdir(parent, { recursive: true });
    const temporary = `${item.local}.ed-${randomUUID()}.tmp`;
    try {
      await transport.download(item.remote, temporary);
      await rename(temporary, item.local);
      onProgress?.(item);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw new DeployError('transfer', `下载失败：${item.relative} (${String(error)})`);
    }
  }
}

export async function existingDownloads(items: TransferItem[]): Promise<TransferItem[]> {
  const result: TransferItem[] = [];
  for (const item of items) {
    if (item.directory) continue;
    try { await lstat(item.local); result.push(item); } catch { /* 尚不存在 */ }
  }
  return result;
}

async function assertSafeDestination(root: string, destination: string): Promise<void> {
  if ((await lstat(root)).isSymbolicLink()) throw new DeployError('path', `本地根目录不能是符号链接：${root}`);
  const relative = path.relative(root, destination);
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new DeployError('path', `下载目标包含符号链接：${current}`);
    } catch (error) {
      if (error instanceof DeployError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
