import { access, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { stdin, stdout } from 'node:process';
import {
  changedFilesForTarget, createTransport, DeployError, downloadPlan, executeDownload,
  executeUpload, existingDownloads, exampleConfig, loadConfig, relativeRemote, remotePath, selectTarget, uploadPlan,
  type TransferItem,
} from '@unionschool/easy-deploy-core';

interface Options { target?: string; dryRun: boolean; changed: boolean; json: boolean; checkWrite: boolean; approvedProtected: boolean; approvedOverwrite: boolean; help: boolean; version: boolean; path?: string }

function parseArgs(args: string[]): { command?: string; options: Options } {
  const options: Options = { dryRun: false, changed: false, json: false, checkWrite: false, approvedProtected: false, approvedOverwrite: false, help: false, version: false };
  let command: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--target' || arg === '-t') options.target = args[++i];
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--changed') options.changed = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--check-write') options.checkWrite = true;
    else if (arg === '--approved-protected') options.approvedProtected = true;
    else if (arg === '--approved-overwrite') options.approvedOverwrite = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--version' || arg === '-v') options.version = true;
    else if (arg.startsWith('-')) throw new DeployError('config', `未知参数：${arg}`);
    else if (!command) command = arg;
    else if (!options.path) options.path = arg;
    else throw new DeployError('config', `多余参数：${arg}`);
  }
  if (args.includes('--target') || args.includes('-t')) {
    if (!options.target || options.target.startsWith('-')) throw new DeployError('config', '--target 缺少名称');
  }
  return { command, options };
}

function output(value: unknown, json: boolean): void {
  if (json) stdout.write(`${JSON.stringify(value)}\n`);
  else if (typeof value === 'string') stdout.write(`${value}\n`);
  else stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function confirm(message: string): Promise<boolean> {
  if (!stdin.isTTY || !stdout.isTTY) return false;
  const ui = createInterface({ input: stdin, output: stdout });
  try { return (await ui.question(`${message} 输入 yes 继续：`)).trim() === 'yes'; }
  finally { ui.close(); }
}

function summary(name: string, driver: string, remote: string, items: TransferItem[]): string {
  return `Target: ${name} (${driver})\nRemote: ${remote}\n文件数: ${items.filter(item => !item.directory).length}，目录数: ${items.filter(item => item.directory).length}`;
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (options.version) return output('0.3.0', options.json);
  if (options.help || !command) return output('用法：ed init | ed up <path>|--changed | ed down <path> | ed ls [path] | ed status | ed targets | ed doctor [--check-write] | ed update\n选项：-t/--target、--dry-run、--json、--help、--version', options.json);
  if (command === 'update') {
    const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['update', '-g', '@unionschool/easy-deploy'], { stdio: 'inherit', shell: process.platform === 'win32' });
    if (result.error) throw new DeployError('connection', `更新失败：${result.error.message}`);
    if (result.status !== 0) throw new DeployError('connection', `npm 更新失败，退出码：${result.status ?? '未知'}`);
    return output('更新完成，请运行 ed --version 核对版本。', options.json);
  }
  if (command === 'init') {
    const file = path.join(process.cwd(), 'easy-deploy.json');
    try { await access(file); throw new DeployError('config', '配置文件已存在，不会覆盖'); }
    catch (error) { if (error instanceof DeployError) throw error; }
    await writeFile(file, exampleConfig, { flag: 'wx' });
    return output(`已创建 ${file}`, options.json);
  }
  if (!['up', 'down', 'ls', 'status', 'targets', 'doctor'].includes(command)) throw new DeployError('config', `未知命令：${command}`);
  const cwd = process.cwd();
  const { config } = await loadConfig(cwd);
  if (command === 'targets') return output({ apiVersion: 1, default: config.default, targets: Object.keys(config.targets) }, options.json);
  const { name, target } = selectTarget(config, options.target);
  if ((options.approvedProtected || options.approvedOverwrite) && !options.target) throw new DeployError('config', '预确认参数必须同时显式指定 --target');
  if (command === 'status') {
    let changed: number | undefined;
    try { changed = (await changedFilesForTarget(cwd, target)).files.length; } catch { /* 项目可以不是 Git 仓库 */ }
    return output({ apiVersion: 1, target: name, driver: target.driver, host: target.host, local: target.local, remote: target.remote, protected: target.protected ?? false, changed }, options.json);
  }
  if (command === 'ls') {
    const relative = relativeRemote(target.remote, options.path ?? '.');
    const remote = remotePath(target.remote, relative);
    const transport = createTransport(target);
    await transport.connect();
    try {
      let current = target.remote;
      if (await transport.isLink(current)) throw new DeployError('path', `远程路径是符号链接：${current}`);
      for (const part of relative.split('/').filter(part => part && part !== '.')) {
        current = path.posix.join(current, part);
        if (await transport.isLink(current)) throw new DeployError('path', `远程路径是符号链接：${current}`);
      }
      const entries = (await transport.list(remote)).filter(item => item.name !== '.' && item.name !== '..' && !item.name.includes('/') && !item.name.includes('\\'));
      return output({ apiVersion: 1, target: name, path: relative, entries }, options.json);
    } finally { await transport.close(); }
  }
  const transport = createTransport(target);
  if (command === 'doctor') {
    await transport.connect();
    try {
      const remoteExists = await transport.exists(target.remote);
      let writable: boolean | undefined;
      if (options.checkWrite) {
        if (!remoteExists) throw new DeployError('path', `远程根目录不存在：${target.remote}`);
        if (target.protected && !options.approvedProtected && !await confirm(`受保护 Target ${name}，将创建并删除远程测试文件。`)) throw new DeployError('protected', '已取消：受保护 Target 需要交互确认');
        const local = path.join(tmpdir(), `ed-check-${randomUUID()}`);
        const remote = path.posix.join(target.remote, `.ed-check-${randomUUID()}`);
        try {
          await writeFile(local, 'easy-deploy write check');
          await transport.upload(local, remote);
          writable = true;
        } finally {
          await transport.remove(remote).catch(() => {});
          await rm(local, { force: true }).catch(() => {});
        }
      }
      return output({ target: name, connected: true, remoteExists, writable }, options.json);
    } finally { await transport.close(); }
  }
  if (command === 'up') {
    if (Boolean(options.path) === options.changed) throw new DeployError('config', '上传需要指定路径或 --changed，二者只能选一个');
    const changes = options.changed ? await changedFilesForTarget(cwd, target) : undefined;
    const items = await uploadPlan(cwd, target, options.changed ? changes!.files : [options.path!]);
    if (!options.json) output(summary(name, target.driver, target.remote, items), false);
    if (options.dryRun) return output({ dryRun: true, items, deleted: changes?.deleted ?? [] }, options.json);
    if (!items.length) return output({ target: name, uploaded: 0, deletedSkipped: changes?.deleted ?? [] }, options.json);
    if (target.protected && !options.approvedProtected && !await confirm('受保护 Target，即将上传。')) throw new DeployError('protected', '已取消：受保护 Target 需要交互确认');
    await transport.connect();
    try { await executeUpload(items, transport, options.json ? undefined : item => output(`↑ ${item.relative}`, false)); }
    finally { await transport.close(); }
    return output({ target: name, uploaded: items.filter(item => !item.directory).length, directories: items.filter(item => item.directory).length, deletedSkipped: changes?.deleted ?? [] }, options.json);
  }
  if (!options.path) throw new DeployError('config', '下载需要指定路径');
  await transport.connect();
  try {
    const items = await downloadPlan(cwd, target, options.path, transport);
    if (!options.json) output(summary(name, target.driver, target.remote, items), false);
    if (options.dryRun) return output({ dryRun: true, items }, options.json);
    const existing = await existingDownloads(items);
    if (existing.length && !options.approvedOverwrite && !await confirm(`将覆盖 ${existing.length} 个本地文件。`)) throw new DeployError('protected', '已取消：覆盖本地文件需要交互确认');
    await executeDownload(items, path.resolve(cwd, target.local), transport, options.json ? undefined : item => output(`↓ ${item.relative}`, false));
    return output({ target: name, downloaded: items.filter(item => !item.directory).length, directories: items.filter(item => item.directory).length }, options.json);
  } finally { await transport.close(); }
}

main().catch(error => {
  const kind = error instanceof DeployError ? error.kind : 'unexpected';
  const json = process.argv.includes('--json');
  if (json) stdout.write(`${JSON.stringify({ error: kind, message: error instanceof Error ? error.message : String(error) })}\n`);
  else process.stderr.write(`错误 [${kind}]：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = kind === 'config' ? 2 : kind === 'protected' ? 3 : 1;
});
