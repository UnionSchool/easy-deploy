import { createReadStream, createWriteStream } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { DeployError, type Target } from './config.js';
import type { RemoteEntry, Transport } from './transport.js';

interface Reply { code: number; text: string }

function parseList(output: string): RemoteEntry[] {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^([dl-])[rwxStTs-]{9}\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+\S+\s+(.+)$/.exec(line);
    if (!match) throw new DeployError('transfer', '服务器 LIST 格式不受支持');
    const link = match[1] === 'l';
    return { name: link ? match[2].split(' -> ')[0] : match[2], directory: match[1] === 'd', link };
  }).filter(item => item.name !== '.' && item.name !== '..');
}

class ControlConnection {
  private buffer = '';
  private lines: string[] = [];
  private waiting: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure?: Error;

  constructor(readonly socket: Socket) {
    socket.setTimeout(15000, () => socket.destroy(new Error('FTP 控制连接超时')));
    socket.on('data', chunk => {
      this.buffer += chunk.toString('utf8');
      if (this.buffer.length > 1024 * 1024) { socket.destroy(new Error('FTP 响应过长')); return; }
      let end: number;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end).replace(/\r$/, '');
        this.buffer = this.buffer.slice(end + 1);
        const next = this.waiting.shift();
        if (next) next.resolve(line); else this.lines.push(line);
      }
    });
    socket.on('error', error => this.fail(error));
    socket.on('close', () => this.fail(new Error('FTP 控制连接已关闭')));
  }

  private fail(error: Error): void {
    this.failure = error;
    for (const waiting of this.waiting.splice(0)) waiting.reject(error);
  }

  private line(): Promise<string> {
    const ready = this.lines.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }

  async reply(): Promise<Reply> {
    const first = await this.line();
    const match = /^(\d{3})([ -])/.exec(first);
    if (!match) throw new Error(`FTP 响应格式无效：${first}`);
    const code = Number(match[1]);
    if (match[2] === ' ') return { code, text: first };
    const lines = [first];
    for (let count = 0; count < 1000; count++) {
      const line = await this.line();
      lines.push(line);
      if (line.startsWith(`${match[1]} `)) return { code, text: lines.join('\n') };
    }
    throw new Error('FTP 多行响应过长');
  }

  async command(value: string): Promise<Reply> {
    if (/[\r\n]/.test(value)) throw new DeployError('path', 'FTP 路径不能包含换行符');
    if (this.failure) throw this.failure;
    this.socket.write(`${value}\r\n`);
    return this.reply();
  }
}

function expect(reply: Reply, ...codes: number[]): void {
  if (!codes.includes(reply.code)) throw new DeployError('transfer', `FTP ${reply.code}：${reply.text}`);
}

async function socketTo(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(15000, () => socket.destroy(new Error('FTP 数据连接超时')));
    socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
    socket.once('error', reject);
  });
}

export class FtpTransport implements Transport {
  private control?: ControlConnection;
  constructor(private target: Extract<Target, { driver: 'ftp' }>, private passwordOverride?: string) {}

  private get connection(): ControlConnection {
    if (!this.control) throw new DeployError('connection', 'FTP 尚未连接');
    return this.control;
  }

  async connect(): Promise<void> {
    const password = this.passwordOverride ?? process.env[this.target.auth.passwordEnv];
    if (!password) throw new DeployError('auth', `缺少密码环境变量：${this.target.auth.passwordEnv}`);
    try {
      const socket = await socketTo(this.target.host, this.target.port ?? 21);
      this.control = new ControlConnection(socket);
      expect(await this.connection.reply(), 220);
      const user = await this.connection.command(`USER ${this.target.username ?? 'anonymous'}`);
      if (user.code === 331) {
        const login = await this.connection.command(`PASS ${password}`);
        if (login.code !== 230) throw new DeployError('auth', `FTP 登录失败（${login.code}）`);
      }
      else expect(user, 230);
      expect(await this.connection.command('TYPE I'), 200);
      await this.connection.command('OPTS UTF8 ON').catch(() => {});
    } catch (error) {
      await this.close();
      throw error instanceof DeployError ? error : new DeployError('connection', `FTP 连接失败：${String(error)}`);
    }
  }

  async close(): Promise<void> {
    const connection = this.control;
    this.control = undefined;
    if (connection) connection.socket.destroy();
  }

  private async passive(): Promise<Socket> {
    let port: number;
    const extended = await this.connection.command('EPSV');
    if (extended.code === 229) {
      const match = /\((.)\1\1(\d+)\1\)/.exec(extended.text);
      if (!match) throw new DeployError('connection', `EPSV 响应无效：${extended.text}`);
      port = Number(match[2]);
    } else if (extended.code >= 400) {
      const standard = await this.connection.command('PASV');
      expect(standard, 227);
      const match = /\((\d+,\d+,\d+,\d+,(\d+),(\d+))\)/.exec(standard.text);
      if (!match) throw new DeployError('connection', `PASV 响应无效：${standard.text}`);
      port = Number(match[2]) * 256 + Number(match[3]);
    } else throw new DeployError('connection', `EPSV 响应无效：${extended.text}`);
    if (port < 1 || port > 65535) throw new DeployError('connection', `FTP 数据端口无效：${port}`);
    return socketTo(this.target.host, port);
  }

  private async transfer(command: string, data: (socket: Socket) => Promise<void>): Promise<void> {
    const socket = await this.passive();
    try {
      expect(await this.connection.command(command), 125, 150);
      await data(socket);
      expect(await this.connection.reply(), 226, 250);
    } finally { socket.destroy(); }
  }

  async upload(local: string, remote: string): Promise<void> {
    await this.ensureDirectory(path.posix.dirname(remote));
    if (await this.isLink(remote)) throw new DeployError('path', `远程文件是符号链接：${remote}`);
    await this.transfer(`STOR ${remote}`, socket => pipeline(createReadStream(local), socket));
  }

  async mkdir(remote: string): Promise<void> { await this.ensureDirectory(remote); }

  async download(remote: string, local: string): Promise<void> {
    await this.transfer(`RETR ${remote}`, socket => pipeline(socket, createWriteStream(local)));
  }

  private async listing(command: string): Promise<string> {
    let output = '';
    await this.transfer(command, async socket => {
      for await (const chunk of socket) {
        output += chunk.toString('utf8');
        if (output.length > 10 * 1024 * 1024) throw new DeployError('transfer', 'FTP 目录列表过大');
      }
    });
    return output;
  }

  async list(remote: string): Promise<RemoteEntry[]> {
    let output: string;
    try { output = await this.listing(`MLSD ${remote}`); }
    catch (error) {
      if (!(error instanceof DeployError) || !/^FTP (500|502|504)：/.test(error.message)) throw error;
      output = await this.listing(`LIST ${remote}`);
      return parseList(output);
    }
    return output.split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.indexOf(' ');
      if (separator < 0) throw new DeployError('transfer', `MLSD 目录项无效：${line}`);
      const facts = line.slice(0, separator).toLowerCase();
      const type = /(?:^|;)type=([^;]+)/.exec(facts)?.[1];
      return { name: line.slice(separator + 1), directory: type === 'dir', link: Boolean(type?.includes('slink')) };
    }).filter(item => item.name !== '.' && item.name !== '..');
  }

  private async entry(remote: string): Promise<RemoteEntry | undefined> {
    const parent = path.posix.dirname(remote);
    return (await this.list(parent)).find(item => item.name === path.posix.basename(remote));
  }

  async exists(remote: string): Promise<boolean> { return Boolean(await this.entry(remote)); }
  async isDirectory(remote: string): Promise<boolean> { return Boolean((await this.entry(remote))?.directory); }
  async isLink(remote: string): Promise<boolean> {
    const parent = path.posix.dirname(remote);
    return Boolean(parseList(await this.listing(`LIST ${parent}`)).find(item => item.name === path.posix.basename(remote))?.link);
  }

  private async ensureDirectory(remote: string): Promise<void> {
    const parts = remote.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current += `/${part}`;
      const reply = await this.connection.command(`MKD ${current}`);
      if (reply.code === 257 || reply.code === 250) continue;
      if (reply.code === 550 && await this.isLink(current)) throw new DeployError('path', `远程目录是符号链接：${current}`);
      if (reply.code === 550 && await this.isDirectory(current)) continue;
      expect(reply, 257, 250);
    }
  }

  async remove(remote: string): Promise<void> { expect(await this.connection.command(`DELE ${remote}`), 250); }
}
