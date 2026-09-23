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

async function upload(ext: vscode.ExtensionContext, uri?: vscode.Uri, changed = false): Promise<void> {
  const { cwd, name, target } = await contextFor(ext, uri);
  const root = path.resolve(cwd, target.local);
  const relative = uri ? path.relative(root, uri.fsPath) : vscode.window.activeTextEditor ? path.relative(root, vscode.window.activeTextEditor.document.uri.fsPath) : undefined;
  if (!changed && !relative) throw new Error('请选择项目内的文件或目录');
  const changes = changed ? await changedFilesForTarget(cwd, target) : undefined;
  const items = await uploadPlan(cwd, target, changed ? changes!.files : [relative!]);
  if (!items.length) { vscode.window.showInformationMessage('没有需要上传的文件'); return; }
  if (!await confirmProtected(name, target, items.length)) return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Easy Deploy: 上传到 ${name}`, cancellable: true }, async (progress, token) => {
    const transport = createTransport(target);
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
  const { cwd, name, target } = await contextFor(ext, uri);
  const root = path.resolve(cwd, target.local);
  const resource = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!resource) throw new Error('请选择项目内的文件或目录');
  const relative = path.relative(root, resource.fsPath);
  const transport = createTransport(target);
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
  register('uploadChanged', async () => upload(ext, undefined, true));
  register('selectTarget', async () => {
    const { folder, config } = await contextFor(ext);
    const picked = await vscode.window.showQuickPick(Object.keys(config.targets), { placeHolder: '选择 Easy Deploy Target' });
    if (picked) await ext.workspaceState.update(targetKey(folder), picked);
  });
  register('testConnection', async () => {
    const { name, target } = await contextFor(ext);
    const transport = createTransport(target);
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
  void updateStatus();
}

export function deactivate(): void {}
