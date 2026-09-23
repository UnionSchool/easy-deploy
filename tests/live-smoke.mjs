import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTransport } from '../packages/core/dist/index.js';

const [driver, host, rawPort, username, remote] = process.argv.slice(2);
const port = Number(rawPort);
const passwordEnv = driver === 'sftp' ? 'ED_LIVE_SFTP_PASSWORD' : 'ED_LIVE_FTP_PASSWORD';
if (!['ftp', 'sftp'].includes(driver) || !host || !Number.isInteger(port) || !username || !remote?.startsWith('/') || (driver === 'ftp' && !process.env[passwordEnv])) {
  throw new Error('用法：FTP 设置 ED_LIVE_FTP_PASSWORD；SFTP 使用 SSH Agent 或 ED_LIVE_SFTP_PASSWORD。运行 node tests/live-smoke.mjs <ftp|sftp> <host> <port> <user> <remote>');
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'packages/cli/dist/index.js');
const cwd = await mkdtemp(path.join(tmpdir(), 'ed-live-smoke-'));
const name = `ed-smoke-${randomUUID()}.txt`;
const target = {
  driver, host, port, username, local: '.', remote,
  auth: driver === 'sftp' && !process.env[passwordEnv] ? { type: 'ssh-config' } : { type: 'password', passwordEnv },
};
const remoteFile = path.posix.join(remote, name);
let uploaded = false;

function run(...args) {
  const output = execFileSync(process.execPath, [cli, ...args, '--json'], { cwd, encoding: 'utf8', timeout: 30000 });
  return JSON.parse(output);
}

try {
  await writeFile(path.join(cwd, 'easy-deploy.json'), JSON.stringify({ version: 1, default: 'test', targets: { test: target } }));
  const check = run('doctor');
  assert.equal(check.connected, true);
  assert.equal(check.remoteExists, true, `远程目录不可见：${remote}`);

  await writeFile(path.join(cwd, name), 'first transfer\n');
  uploaded = true;
  run('up', name);
  await rm(path.join(cwd, name));
  run('down', name);
  assert.equal(await readFile(path.join(cwd, name), 'utf8'), 'first transfer\n');

  await writeFile(path.join(cwd, name), 'updated transfer\n');
  run('up', name);
  await rm(path.join(cwd, name));
  run('down', name);
  assert.equal(await readFile(path.join(cwd, name), 'utf8'), 'updated transfer\n');

  assert.equal(run('doctor', '--check-write').writable, true);
  process.stdout.write(`真实 ${driver.toUpperCase()} 连接、上传、下载、覆盖与写权限检查通过\n`);
} finally {
  if (uploaded) {
    const transport = createTransport(target);
    try { await transport.connect(); await transport.remove(remoteFile); }
    catch (error) { process.stderr.write(`清理远程测试文件失败：${remoteFile}（${String(error)}）\n`); }
    finally { await transport.close(); }
  }
  await rm(cwd, { recursive: true, force: true });
}
