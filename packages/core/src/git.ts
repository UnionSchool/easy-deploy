import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { DeployError, type Target } from './config.js';

const run = promisify(execFile);

export async function changedFiles(cwd: string): Promise<{ files: string[]; deleted: string[] }> {
  let stdout: string;
  try { ({ stdout } = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })); }
  catch { throw new DeployError('config', '无法读取 Git 变更：请确认已安装 Git 且当前目录是 Git 仓库'); }
  const entries = stdout.split('\0');
  const files: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < entries.length && entries[i]; i++) {
    const entry = entries[i];
    const status = entry.slice(0, 2);
    const file = entry.slice(3);
    if (status.includes('R') || status.includes('C')) i++; // -z 格式附带原路径
    if (status.includes('D')) deleted.push(file);
    else if (!status.includes('!')) files.push(file);
  }
  return { files, deleted };
}

export async function changedFilesForTarget(configDir: string, target: Target): Promise<{ files: string[]; deleted: string[] }> {
  const changes = await changedFiles(configDir);
  const prefix = path.relative(configDir, path.resolve(configDir, target.local)).split(path.sep).join('/');
  if (!prefix) return changes;
  const within = (file: string) => file.startsWith(`${prefix}/`);
  return {
    files: changes.files.filter(within).map(file => file.slice(prefix.length + 1)),
    deleted: changes.deleted.filter(within).map(file => file.slice(prefix.length + 1)),
  };
}
