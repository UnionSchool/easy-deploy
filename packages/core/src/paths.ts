import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { DeployError } from './config.js';

export function resolveInside(root: string, input: string): string {
  if (path.isAbsolute(input) || path.win32.parse(input).root) throw new DeployError('path', `不允许绝对路径：${input}`);
  const resolved = path.resolve(root, input);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new DeployError('path', `路径超出配置根目录：${input}`);
  }
  return resolved;
}

export async function assertNoSymlinks(root: string, absolute: string): Promise<void> {
  if ((await lstat(root)).isSymbolicLink()) throw new DeployError('path', `本地根目录不能是符号链接：${root}`);
  const relative = path.relative(root, absolute);
  let current = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new DeployError('path', `不跟随符号链接：${current}`);
  }
}

export function remotePath(root: string, relative: string): string {
  const normalized = relative.split(path.sep).join('/');
  if (!root.startsWith('/') || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new DeployError('path', `远程路径无效：${relative}`);
  }
  return path.posix.join(root, normalized);
}

export function relativeRemote(root: string, input: string): string {
  if (input.startsWith('/') || input.split(/[\\/]/).includes('..')) throw new DeployError('path', `远程路径无效：${input}`);
  return input.replaceAll('\\', '/');
}
