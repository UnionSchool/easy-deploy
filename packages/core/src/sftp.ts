import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { open, mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DeployError, type Target } from './config.js';
import type { RemoteEntry, Transport } from './transport.js';

type SftpTarget = Extract<Target, { driver: 'sftp' }>;
const u32 = (value: number): Buffer => { const data = Buffer.alloc(4); data.writeUInt32BE(value); return data; };
const u64 = (value: number): Buffer => { const data = Buffer.alloc(8); data.writeBigUInt64BE(BigInt(value)); return data; };
const str = (value: string | Buffer): Buffer => { const data = Buffer.isBuffer(value) ? value : Buffer.from(value); return Buffer.concat([u32(data.length), data]); };

class Reader {
  private offset = 0;
  constructor(private data: Buffer) {}
  u32(): number { const value = this.data.readUInt32BE(this.offset); this.offset += 4; return value; }
  bytes(): Buffer { const size = this.u32(); const end = this.offset + size; if (end > this.data.length) throw new Error('SFTP 数据不完整'); const value = this.data.subarray(this.offset, end); this.offset = end; return value; }
  text(): string { return this.bytes().toString('utf8'); }
  skipAttrs(): number {
    const flags = this.u32();
    if (flags & 1) this.offset += 8;
    if (flags & 2) this.offset += 8;
    let permissions = 0;
    if (flags & 4) permissions = this.u32();
    if (flags & 8) this.offset += 8;
    if (flags & 0x80000000) for (let count = this.u32(); count > 0; count--) { this.bytes(); this.bytes(); }
    if (this.offset > this.data.length) throw new Error('SFTP 属性不完整');
    return permissions;
  }
}

export class SftpTransport implements Transport {
  private process?: ChildProcessWithoutNullStreams;
  private input = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, { resolve: (reply: { type: number; body: Buffer }) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private version?: { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
  private askpassDir?: string;
  private stderr = '';
  constructor(private target: SftpTarget, private passwordOverride?: string) {}

  async connect(): Promise<void> {
    const args = ['-T', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15', '-o', 'NumberOfPasswordPrompts=1', '-o', 'LogLevel=ERROR'];
    if (process.env.ED_KNOWN_HOSTS) args.push('-o', `UserKnownHostsFile=${process.env.ED_KNOWN_HOSTS}`);
    if (this.target.port) args.push('-p', String(this.target.port));
    if (this.target.username) args.push('-l', this.target.username);
    if (this.target.auth.type === 'private-key') args.push('-i', this.target.auth.privateKeyPath!);
    const env = { ...process.env };
    if (this.target.auth.type === 'password') {
      const password = this.passwordOverride ?? process.env[this.target.auth.passwordEnv!];
      if (!password) throw new DeployError('auth', `缺少密码环境变量：${this.target.auth.passwordEnv}`);
      this.askpassDir = await mkdtemp(path.join(tmpdir(), 'ed-askpass-'));
      const script = path.join(this.askpassDir, 'askpass.js');
      await writeFile(script, `#!/usr/bin/env node\nprocess.stdout.write(process.env.ED_SFTP_PASSWORD || '');\n`, { mode: 0o700 });
      await chmod(script, 0o700);
      let askpass = script;
      if (process.platform === 'win32') {
        askpass = path.join(this.askpassDir, 'askpass.cmd');
        await writeFile(askpass, `@echo off\r\n"${process.execPath}" "${script}"\r\n`);
      }
      env.ED_SFTP_PASSWORD = password;
      env.SSH_ASKPASS = askpass;
      env.SSH_ASKPASS_REQUIRE = 'force';
      env.DISPLAY = env.DISPLAY || ':0';
    } else args.push('-o', 'BatchMode=yes');
    args.push('-s', this.target.host, 'sftp');
    try {
      this.process = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
      const child = this.process;
      child.stdout.on('data', (chunk: Buffer) => {
        try { this.receive(chunk); }
        catch { this.fail(new DeployError('connection', 'SFTP 响应格式无效')); child.kill(); }
      });
      child.stderr.on('data', (chunk: Buffer) => { this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2048); });
      child.on('error', error => this.fail(new DeployError('connection', `无法启动 ssh：${error.message}`)));
      child.on('close', () => this.fail(new DeployError('connection', `SSH 连接已关闭：${this.stderr.trim() || '远程连接中断'}`)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { this.fail(new DeployError('connection', 'SFTP 握手超时')); child.kill(); }, 20000);
        this.version = { resolve, reject, timer };
        this.send(1, u32(3));
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private send(type: number, body: Buffer): void {
    const packet = Buffer.concat([u32(body.length + 1), Buffer.from([type]), body]);
    this.process?.stdin.write(packet);
  }
  private receive(chunk: Buffer): void {
    this.input = Buffer.concat([this.input, chunk]);
    while (this.input.length >= 4) {
      const size = this.input.readUInt32BE(0);
      if (size < 1 || size > 16 * 1024 * 1024) { this.fail(new DeployError('connection', 'SFTP 响应长度无效')); this.process?.kill(); return; }
      if (this.input.length < size + 4) return;
      const type = this.input[4];
      const body = this.input.subarray(5, size + 4);
      this.input = this.input.subarray(size + 4);
      if (this.version) {
        const waiting = this.version; this.version = undefined; clearTimeout(waiting.timer);
        if (type === 2 && body.length >= 4 && body.readUInt32BE(0) === 3) waiting.resolve();
        else waiting.reject(new DeployError('connection', '服务器不支持 SFTP v3'));
        continue;
      }
      if (body.length < 4) { this.fail(new DeployError('connection', 'SFTP 响应缺少请求 ID')); continue; }
      const id = body.readUInt32BE(0);
      const waiting = this.pending.get(id);
      if (waiting) { this.pending.delete(id); clearTimeout(waiting.timer); waiting.resolve({ type, body: body.subarray(4) }); }
    }
  }
  private fail(error: Error): void {
    if (this.version) { clearTimeout(this.version.timer); this.version.reject(error); this.version = undefined; }
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  private request(type: number, ...fields: Buffer[]): Promise<{ type: number; body: Buffer }> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new DeployError('connection', 'SFTP 请求超时')); this.process?.kill(); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send(type, Buffer.concat([u32(id), ...fields]));
    });
  }
  private async result(type: number, ...fields: Buffer[]): Promise<{ type: number; body: Buffer }> {
    const response = await this.request(type, ...fields);
    if (response.type === 101) {
      const data = new Reader(response.body);
      const status = data.u32();
      if (status !== 0) throw new DeployError('transfer', `SFTP 错误 ${status}：${data.text()}`);
    }
    return response;
  }
  private async handle(type: number, ...fields: Buffer[]): Promise<Buffer> {
    const response = await this.result(type, ...fields);
    if (response.type !== 102) throw new DeployError('transfer', 'SFTP 未返回文件句柄');
    return new Reader(response.body).bytes();
  }
  private async closeHandle(handle: Buffer): Promise<void> { await this.result(4, str(handle)); }
  async close(): Promise<void> {
    const child = this.process;
    this.process = undefined;
    if (child) { child.stdin.end(); child.kill(); }
    if (this.askpassDir) { await rm(this.askpassDir, { recursive: true, force: true }); this.askpassDir = undefined; }
  }

  private async attrs(remote: string, follow = false): Promise<number | undefined> {
    const response = await this.request(follow ? 17 : 7, str(remote)); // 下载检查使用 LSTAT
    if (response.type === 101) {
      const status = new Reader(response.body).u32();
      if (status === 2) return undefined;
      throw new DeployError('transfer', `SFTP LSTAT 失败：${remote}（${status}）`);
    }
    if (response.type !== 105) throw new DeployError('transfer', 'SFTP 属性响应无效');
    return new Reader(response.body).skipAttrs();
  }
  async exists(remote: string): Promise<boolean> { return (await this.attrs(remote)) !== undefined; }
  async isDirectory(remote: string): Promise<boolean> { return (((await this.attrs(remote)) ?? 0) & 0xf000) === 0x4000; }
  async isLink(remote: string): Promise<boolean> { return (((await this.attrs(remote)) ?? 0) & 0xf000) === 0xa000; }
  async mkdir(remote: string): Promise<void> {
    const parts = remote.split('/').filter(Boolean);
    let current = '';
    const root = path.posix.normalize(this.target.remote);
    for (const part of parts) {
      current += `/${part}`;
      if (await this.exists(current)) {
        if ((current === root || current.startsWith(`${root}/`)) && await this.isLink(current)) throw new DeployError('path', `远程路径包含符号链接：${current}`);
        if ((((await this.attrs(current, true)) ?? 0) & 0xf000) !== 0x4000) throw new DeployError('path', `远程路径不是目录：${current}`);
      } else await this.result(14, str(current), u32(0));
    }
  }
  async upload(local: string, remote: string): Promise<void> {
    await this.mkdir(path.posix.dirname(remote));
    if (await this.isLink(remote)) throw new DeployError('path', `远程文件是符号链接：${remote}`);
    const source = await open(local, 'r');
    let handle: Buffer | undefined;
    try {
      handle = await this.handle(3, str(remote), u32(2 | 8 | 16), u32(0));
      const buffer = Buffer.alloc(32768);
      let offset = 0;
      for (;;) {
        const { bytesRead } = await source.read(buffer, 0, buffer.length, offset);
        if (!bytesRead) break;
        await this.result(6, str(handle), u64(offset), str(buffer.subarray(0, bytesRead)));
        offset += bytesRead;
      }
    } finally { if (handle) await this.closeHandle(handle); await source.close(); }
  }
  async download(remote: string, local: string): Promise<void> {
    const handle = await this.handle(3, str(remote), u32(1), u32(0));
    let destination: Awaited<ReturnType<typeof open>> | undefined;
    try {
      destination = await open(local, 'w');
      let offset = 0;
      for (;;) {
        const response = await this.request(5, str(handle), u64(offset), u32(32768));
        if (response.type === 101 && new Reader(response.body).u32() === 1) break;
        if (response.type === 101) throw new DeployError('transfer', `SFTP 读取失败：${remote}`);
        if (response.type !== 103) throw new DeployError('transfer', 'SFTP 文件数据响应无效');
        const data = new Reader(response.body).bytes();
        if (!data.length) throw new DeployError('transfer', 'SFTP 返回空数据');
        for (let written = 0; written < data.length;) {
          const result = await destination.write(data, written, data.length - written);
          if (!result.bytesWritten) throw new DeployError('transfer', '本地写入失败');
          written += result.bytesWritten;
        }
        offset += data.length;
      }
    } finally { await destination?.close(); await this.closeHandle(handle); }
  }
  async list(remote: string): Promise<RemoteEntry[]> {
    const handle = await this.handle(11, str(remote));
    const entries: RemoteEntry[] = [];
    try {
      for (;;) {
        const response = await this.request(12, str(handle));
        if (response.type === 101 && new Reader(response.body).u32() === 1) break;
        if (response.type !== 104) throw new DeployError('transfer', `SFTP 列目录失败：${remote}`);
        const reader = new Reader(response.body);
        for (let count = reader.u32(); count > 0; count--) {
          const name = reader.text(); reader.text();
          const permissions = reader.skipAttrs();
          if (name !== '.' && name !== '..') entries.push({ name, directory: (permissions & 0xf000) === 0x4000, link: (permissions & 0xf000) === 0xa000 });
        }
      }
    } finally { await this.closeHandle(handle); }
    return entries;
  }
  async remove(remote: string): Promise<void> { await this.result(13, str(remote)); }
}
