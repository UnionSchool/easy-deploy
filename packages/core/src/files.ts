import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { DeployError, type Target } from './config.js';
import { assertNoSymlinks, resolveInside } from './paths.js';

interface Rule { pattern: string; negated: boolean; directoryOnly: boolean }

function parseRules(lines: string[]): Rule[] {
  return lines.flatMap(raw => {
    let line = raw.trim();
    if (!line || line.startsWith('#')) return [];
    const escapedPrefix = line.startsWith('\\#') || line.startsWith('\\!');
    if (escapedPrefix) line = line.slice(1);
    const negated = !escapedPrefix && line.startsWith('!');
    if (negated) line = line.slice(1);
    const directoryOnly = line.endsWith('/');
    if (directoryOnly) line = line.slice(0, -1);
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) return [];
    return [{ pattern: line.includes('/') ? line : `**/${line}`, negated, directoryOnly }];
  });
}

function ignored(relative: string, directory: boolean, rules: Rule[]): boolean {
  let result = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) continue;
    if (path.posix.matchesGlob(relative, rule.pattern)) result = !rule.negated;
  }
  return result;
}

export async function collectEntries(configDir: string, target: Target, input: string): Promise<{ files: string[]; emptyDirectories: string[] }> {
  const root = path.resolve(configDir, target.local);
  const absolute = resolveInside(root, input);
  await assertNoSymlinks(root, absolute);
  let gitignore: string[] = [];
  try { gitignore = (await readFile(path.join(root, '.gitignore'), 'utf8')).split(/\r?\n/); } catch { /* 可没有 .gitignore */ }
  const rules = parseRules([...gitignore, ...(target.ignore ?? [])]);
  const files: string[] = [];
  const emptyDirectories: string[] = [];
  async function walk(current: string): Promise<void> {
    const relative = path.relative(root, current).split(path.sep).join('/');
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) return;
    if (relative && (isBlocked(relative) || ignored(relative, stat.isDirectory(), rules))) return;
    if (stat.isDirectory()) {
      const before = files.length;
      for (const entry of await readdir(current)) await walk(path.join(current, entry));
      if (relative && files.length === before) emptyDirectories.push(relative);
    } else if (stat.isFile()) files.push(relative);
  }
  try { await walk(absolute); }
  catch (error) { throw new DeployError('path', `无法读取本地路径：${input} (${String(error)})`); }
  return { files: files.sort(), emptyDirectories: emptyDirectories.sort() };
}

export async function collectFiles(configDir: string, target: Target, input: string): Promise<string[]> {
  return (await collectEntries(configDir, target, input)).files;
}

function isBlocked(relative: string): boolean {
  const parts = relative.split('/');
  return parts.some(part => part === '.git' || part === '.env' || part.startsWith('.env.') || part.endsWith('.pem') || part.endsWith('.key') || part === 'id_rsa' || part === 'id_ed25519');
}
