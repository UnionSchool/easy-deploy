import * as vscode from 'vscode';
import path from 'node:path';
import { access } from 'node:fs/promises';
import {
  changedFilesForTarget, createTransport, downloadPlan, executeDownload, executeUpload,
  existingDownloads, exampleConfig, loadConfig, selectTarget, uploadPlan,
  type Target,
} from '@unionschool/easy-deploy-core';

function folderFor(uri?: vscode.Uri): vscode.WorkspaceFolder | undefined {
  const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (resource) return vscode.workspace.getWorkspaceFolder(resource);
  return vscode.workspace.workspaceFolders?.length === 1 ? vscode.workspace.workspaceFolders[0] : undefined;
}

async function chooseFolder(uri?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  const found = folderFor(uri);
  if (found) return found;
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) return undefined;
  const selected = await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, folder })), { placeHolder: '选择项目工作区' });
  return selected?.folder;
}

function targetKey(folder: vscode.WorkspaceFolder): string { return `target:${folder.uri.toString()}`; }
function passwordKey(folder: vscode.WorkspaceFolder, name: string): string { return `password:${folder.uri.toString()}:${name}`; }
const manualSaves = new Set<string>();

async function contextFor(ext: vscode.ExtensionContext, uri?: vscode.Uri) {
  const folder = await chooseFolder(uri);
  if (!folder) throw new Error('请先打开项目文件夹');
  const cwd = folder.uri.fsPath;
  const { config } = await loadConfig(cwd);
  const { name, target } = selectTarget(config, ext.workspaceState.get<string>(targetKey(folder)));
  return { cwd, folder, config, name, target };
}

async function confirmProtected(name: string, target: Target, count: number): Promise<boolean> {
  if (!target.protected) return true;
  const answer = await vscode.window.showWarningMessage(
    `受保护目标 ${name}：将上传 ${count} 个文件到 ${target.host}${target.remote}`, { modal: true }, '确认上传',
  );
  return answer === '确认上传';
}

async function transportFor(ext: vscode.ExtensionContext, folder: vscode.WorkspaceFolder, name: string, target: Target) {
  if (target.auth.type !== 'password') return createTransport(target);
  const key = passwordKey(folder, name);
  const saved = await ext.secrets.get(key);
  const password = saved ?? process.env[target.auth.passwordEnv!];
  if (password) return createTransport(target, password);
  const entered = await vscode.window.showInputBox({ prompt: `输入 ${name} 的 FTP/SFTP 密码（保存在系统凭据中）`, password: true, ignoreFocusOut: true });
  if (!entered) throw new Error('已取消输入密码');
  await ext.secrets.store(key, entered);
  return createTransport(target, entered);
}

async function saveDirtyFiles(root: string, relative: string): Promise<void> {
  const selected = path.resolve(root, relative);
  for (const document of vscode.workspace.textDocuments) {
    if (!document.isDirty || document.uri.scheme !== 'file') continue;
    const file = document.uri.fsPath;
    if (file !== selected && !file.startsWith(`${selected}${path.sep}`)) continue;
    manualSaves.add(file);
    try { if (!await document.save()) throw new Error(`保存失败，已取消上传：${file}`); }
    finally { manualSaves.delete(file); }
  }
}

async function explorerSelection(): Promise<vscode.Uri> {
  const old = await vscode.env.clipboard.readText();
  try {
    await vscode.commands.executeCommand('copyFilePath');
    const selected = await vscode.env.clipboard.readText();
    if (!selected || selected.includes('\n')) throw new Error('请在文件树中选中一个文件或目录');
    return vscode.Uri.file(selected);
  } finally { await vscode.env.clipboard.writeText(old); }
}

async function upload(ext: vscode.ExtensionContext, uri?: vscode.Uri, changed = false): Promise<void> {
  const { cwd, folder, name, target } = await contextFor(ext, uri);
  const root = path.resolve(cwd, target.local);
  const relative = uri ? path.relative(root, uri.fsPath) || '.' : vscode.window.activeTextEditor ? path.relative(root, vscode.window.activeTextEditor.document.uri.fsPath) : undefined;
  if (!changed && !relative) throw new Error('请选择项目内的文件或目录');
  if (!changed) await saveDirtyFiles(root, relative!);
  const changes = changed ? await changedFilesForTarget(cwd, target) : undefined;
  const items = await uploadPlan(cwd, target, changed ? changes!.files : [relative!]);
  if (!items.length) { vscode.window.showInformationMessage('没有需要上传的文件'); return; }
  if (!await confirmProtected(name, target, items.length)) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Easy Deploy: 上传到 ${name}`, cancellable: true }, async (progress, token) => {
    const transport = await transportFor(ext, folder, name, target);
    await transport.connect();
    try {
      for (const item of items) {
        if (token.isCancellationRequested) break;
        await executeUpload([item], transport);
        progress.report({ increment: 100 / items.length, message: item.relative });
      }
    } finally { await transport.close(); }
  });
  vscode.window.showInformationMessage(`Easy Deploy: 上传操作结束，目标 ${name}`);
}

async function download(ext: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const { cwd, folder, name, target } = await contextFor(ext, uri);
  const root = path.resolve(cwd, target.local);
  const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!resource) throw new Error('请选择项目内的文件或目录');
  const relative = path.relative(root, resource.fsPath);
  const transport = await transportFor(ext, folder, name, target);
  await transport.connect();
  try {
    const items = await downloadPlan(cwd, target, relative, transport);
    const existing = await existingDownloads(items);
    if (existing.length) {
      const answer = await vscode.window.showWarningMessage(`将覆盖 ${existing.length} 个本地文件`, { modal: true }, '确认覆盖');
      if (answer !== '确认覆盖') return;
    }
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Easy Deploy: 从 ${name} 下载`, cancellable: true }, async (progress, token) => {
      for (const item of items) {
        if (token.isCancellationRequested) break;
        await executeDownload([item], root, transport);
        progress.report({ increment: 100 / items.length, message: item.relative });
      }
    });
  } finally { await transport.close(); }
  vscode.window.showInformationMessage(`Easy Deploy: 下载操作结束，目标 ${name}`);
}

export function activate(ext: vscode.ExtensionContext): void {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'easyDeploy.selectTarget';
  ext.subscriptions.push(status);
  async function updateStatus(): Promise<void> {
    try {
      const folder = folderFor();
      if (!folder) { status.hide(); return; }
      const { name } = await contextFor(ext, folder.uri);
      status.text = `ED: ${name}`;
      status.show();
    }
    catch { status.hide(); }
  }
  function register(id: string, handler: (...args: never[]) => Promise<void>): void {
    ext.subscriptions.push(vscode.commands.registerCommand(`easyDeploy.${id}`, async (...args: never[]) => {
      try { await handler(...args); await updateStatus(); }
      catch (error) { vscode.window.showErrorMessage(`Easy Deploy: ${error instanceof Error ? error.message : String(error)}`); }
    }));
  }
  register('upload', async (uri?: vscode.Uri) => upload(ext, uri));
  register('download', async (uri?: vscode.Uri) => download(ext, uri));
  register('uploadSelection', async () => upload(ext, await explorerSelection()));
  register('downloadSelection', async () => download(ext, await explorerSelection()));
  register('uploadChanged', async () => upload(ext, undefined, true));
  register('selectTarget', async () => {
    const { folder, config } = await contextFor(ext);
    const picked = await vscode.window.showQuickPick(Object.keys(config.targets), { placeHolder: '选择 Easy Deploy Target' });
    if (picked) await ext.workspaceState.update(targetKey(folder), picked);
  });
  register('testConnection', async () => {
    const { folder, name, target } = await contextFor(ext);
    const transport = await transportFor(ext, folder, name, target);
    await transport.connect();
    try { vscode.window.showInformationMessage(`Easy Deploy: ${name} 连接成功`); }
    finally { await transport.close(); }
  });
  register('openConfig', async () => {
    const folder = await chooseFolder();
    if (!folder) throw new Error('请先打开项目文件夹');
    const file = vscode.Uri.file(path.join(folder.uri.fsPath, 'easy-deploy.json'));
    await vscode.window.showTextDocument(file);
  });
  register('setPassword', async () => {
    const { folder, name, target } = await contextFor(ext);
    if (target.auth.type !== 'password') throw new Error('当前目标不使用密码认证');
    const password = await vscode.window.showInputBox({ prompt: `设置 ${name} 的 FTP/SFTP 密码`, password: true, ignoreFocusOut: true });
    if (password) await ext.secrets.store(passwordKey(folder, name), password);
  });
  register('forgetPassword', async () => {
    const { folder, name } = await contextFor(ext);
    await ext.secrets.delete(passwordKey(folder, name));
    vscode.window.showInformationMessage(`Easy Deploy: 已移除 ${name} 保存的密码`);
  });
  register('init', async () => {
    const folder = await chooseFolder();
    if (!folder) throw new Error('请先打开项目文件夹');
    const file = vscode.Uri.file(path.join(folder.uri.fsPath, 'easy-deploy.json'));
    try { await access(file.fsPath); throw new Error('配置文件已存在'); }
    catch (error) { if (error instanceof Error && error.message === '配置文件已存在') throw error; }
    await vscode.workspace.fs.writeFile(file, Buffer.from(exampleConfig));
    await vscode.window.showTextDocument(file);
  });
  ext.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => { void updateStatus(); }));
  const saving = new Set<string>();
  ext.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async document => {
    const file = document.uri.fsPath;
    if (document.uri.scheme !== 'file' || path.basename(file) === 'easy-deploy.json' || saving.has(file) || manualSaves.has(file)) return;
    const workspace = folderFor(document.uri);
    if (!workspace) return;
    try { await access(path.join(workspace.uri.fsPath, 'easy-deploy.json')); }
    catch { return; }
    try {
      const { cwd, folder, name, target } = await contextFor(ext, document.uri);
      if (!target.uploadOnSave || target.protected) return;
      const root = path.resolve(cwd, target.local);
      const relative = path.relative(root, file);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
      saving.add(file);
      let uploaded = false;
      do {
        const version = document.version;
        const items = await uploadPlan(cwd, target, [relative]);
        if (items.length) {
          const transport = await transportFor(ext, folder, name, target);
          await transport.connect();
          try { await executeUpload(items, transport); uploaded = true; }
          finally { await transport.close(); }
        }
        if (version === document.version) break;
      } while (true);
      if (uploaded) vscode.window.showInformationMessage(`Easy Deploy: ${path.basename(file)} 已上传到 ${name}`);
    } catch (error) { vscode.window.showErrorMessage(`Easy Deploy: 自动上传失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { saving.delete(file); }
  }));
  void updateStatus();
}

export function deactivate(): void {}
