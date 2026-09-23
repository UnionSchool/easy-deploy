import { readFile } from 'node:fs/promises';
import path from 'node:path';

interface BaseTarget {
  host: string;
  port?: number;
  username?: string;
  local: string;
  remote: string;
  ignore?: string[];
  protected?: boolean;
  uploadOnSave?: boolean;
}
export type Target =
  | (BaseTarget & { driver: 'sftp'; auth: { type: 'ssh-config' | 'private-key' | 'password'; privateKeyPath?: string; passwordEnv?: string } })
  | (BaseTarget & { driver: 'ftp'; auth: { type: 'password'; passwordEnv: string } });
export interface Config { version: 1; default: string; targets: Record<string, Target> }
export const exampleConfig = JSON.stringify({
  version: 1, default: 'dev', targets: {
    dev: { driver: 'sftp', host: 'example.com', username: 'deploy', local: '.', remote: '/srv/project', auth: { type: 'ssh-config' } },
  },
}, null, 2) + '\n';

export class DeployError extends Error {
  constructor(readonly kind: 'config' | 'path' | 'auth' | 'connection' | 'transfer' | 'protected', message: string) {
    super(message);
    this.name = 'DeployError';
  }
}

function record(value: unknown, name: string, fields?: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DeployError('config', `${name} 必须是对象`);
  const result = value as Record<string, unknown>;
  if (fields) for (const field of Object.keys(result)) if (!fields.includes(field)) throw new DeployError('config', `${name} 包含未知字段：${field}`);
  return result;
}

function string(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new DeployError('config', `${name} 必须是非空字符串`);
  return value;
}

function targetFrom(value: unknown, name: string): Target {
  const data = record(value, name, ['driver', 'host', 'port', 'username', 'local', 'remote', 'ignore', 'protected', 'uploadOnSave', 'auth']);
  if (data.driver !== 'sftp' && data.driver !== 'ftp') throw new DeployError('config', `${name}.driver 必须是 sftp 或 ftp`);
  const host = string(data.host, `${name}.host`)!;
  const username = string(data.username, `${name}.username`, true);
  const local = string(data.local, `${name}.local`)!;
  const remote = string(data.remote, `${name}.remote`)!;
  if (path.isAbsolute(local) || path.win32.parse(local).root || local.split(/[\\/]/).includes('..')) throw new DeployError('config', `${name}.local 必须在配置目录内`);
  if (!remote.startsWith('/') || remote.split('/').includes('..')) throw new DeployError('config', `${name}.remote 必须是绝对路径且不能包含 ..`);
  const port = data.port;
  if (port !== undefined && (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)) throw new DeployError('config', `${name}.port 必须是 1-65535 的整数`);
  const protectedValue = data.protected;
  if (protectedValue !== undefined && typeof protectedValue !== 'boolean') throw new DeployError('config', `${name}.protected 必须是布尔值`);
  if (data.uploadOnSave !== undefined && typeof data.uploadOnSave !== 'boolean') throw new DeployError('config', `${name}.uploadOnSave 必须是布尔值`);
  if (data.uploadOnSave && protectedValue) throw new DeployError('config', `${name}.uploadOnSave 不能用于受保护目标`);
  const ignore = data.ignore;
  if (ignore !== undefined && (!Array.isArray(ignore) || ignore.some(item => typeof item !== 'string'))) throw new DeployError('config', `${name}.ignore 必须是字符串数组`);
  const shared: BaseTarget = {
    host, local, remote,
    ...(username === undefined ? {} : { username }),
    ...(port === undefined ? {} : { port }),
    ...(protectedValue === undefined ? {} : { protected: protectedValue }),
    ...(data.uploadOnSave === undefined ? {} : { uploadOnSave: data.uploadOnSave as boolean }),
    ...(ignore === undefined ? {} : { ignore }),
  };
  if (data.driver === 'ftp') {
    const auth = record(data.auth, `${name}.auth`, ['type', 'passwordEnv']);
    if (auth.type !== 'password') throw new DeployError('config', `${name}.auth.type 必须是 password`);
    return { ...shared, driver: 'ftp', auth: { type: 'password', passwordEnv: string(auth.passwordEnv, `${name}.auth.passwordEnv`)! } };
  }
  const auth = record(data.auth, `${name}.auth`, ['type', 'privateKeyPath', 'passwordEnv']);
  if (auth.type !== 'ssh-config' && auth.type !== 'private-key' && auth.type !== 'password') throw new DeployError('config', `${name}.auth.type 无效`);
  const privateKeyPath = string(auth.privateKeyPath, `${name}.auth.privateKeyPath`, true);
  const passwordEnv = string(auth.passwordEnv, `${name}.auth.passwordEnv`, true);
  if (auth.type === 'private-key' && !privateKeyPath) throw new DeployError('config', `${name}.auth.privateKeyPath 必填`);
  if (auth.type === 'password' && !passwordEnv) throw new DeployError('config', `${name}.auth.passwordEnv 必填`);
  return { ...shared, driver: 'sftp', auth: { type: auth.type, privateKeyPath, passwordEnv } };
}

export async function loadConfig(cwd: string): Promise<{ config: Config; file: string }> {
  const file = path.join(cwd, 'easy-deploy.json');
  let raw: string;
  try { raw = await readFile(file, 'utf8'); }
  catch { throw new DeployError('config', `未找到配置文件：${file}，请先运行 ed init`); }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new DeployError('config', `JSON 解析失败：${String(error)}`); }
  const data = record(parsed, '配置', ['version', 'default', 'targets']);
  if (data.version !== 1) throw new DeployError('config', '不支持的配置版本');
  const defaultTarget = string(data.default, 'default')!;
  const rawTargets = record(data.targets, 'targets');
  const targets: Record<string, Target> = Object.create(null);
  for (const [name, value] of Object.entries(rawTargets)) targets[name] = targetFrom(value, `targets.${name}`);
  if (!targets[defaultTarget]) throw new DeployError('config', `默认 Target 不存在：${defaultTarget}`);
  return { config: { version: 1, default: defaultTarget, targets }, file };
}

export function selectTarget(config: Config, name?: string): { name: string; target: Target } {
  const selected = name ?? config.default;
  const value = config.targets[selected];
  if (!value) throw new DeployError('config', `Target 不存在：${selected}`);
  return { name: selected, target: value };
}
