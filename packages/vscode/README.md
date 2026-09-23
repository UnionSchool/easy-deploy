# Easy Deploy

通过 SFTP 或 FTP 在 VS Code 与远程服务器之间上传、下载文件和目录。传输核心随扩展打包；SFTP 使用系统 OpenSSH 和 `known_hosts` 校验服务器身份。

## 安装

在 VS Code 扩展面板搜索 **Easy Deploy** 并安装。也可从项目 GitHub Releases 下载 VSIX，在扩展面板选择 **Install from VSIX...**。

## 配置

在项目根目录创建 `easy-deploy.json`。可通过命令面板运行 **Easy Deploy: Initialize** 生成示例配置，再填写服务器和路径。配置文件不要提交到公开仓库。

密码认证首次传输时会提示输入密码，并保存到系统凭据库。也可以运行 **Easy Deploy: Set Password** 预先设置，或运行 **Easy Deploy: Forget Password** 删除保存的密码。VS Code 内不需要先打开终端设置环境变量。

## 使用

- 在编辑器或文件树右键选择 **Easy Deploy: Upload / Download**。
- macOS 快捷键：`⌃⌘U` 上传，`⌃⌘G` 下载；Windows/Linux：`Ctrl+Alt+U`、`Ctrl+Alt+G`。
- 编辑器中操作当前文件；文件树中操作选中的文件或目录。快捷键可在 VS Code Keyboard Shortcuts 中修改。
- 上传会先保存待上传范围内的未保存文件。受保护目标和覆盖本地文件会要求确认。
- 点击状态栏的 `ED: <Target>` 可切换目标。
- 保存自动上传默认关闭；在对应 Target 中设置 `"uploadOnSave": true` 开启。受保护目标不会自动上传，成功后会显示文件名和 Target。

完整配置字段、FTP 注意事项和排错方法见[项目 README](https://github.com/UnionSchool/easy-deploy#readme)。

## 更新

Marketplace 安装的扩展由 VS Code 检查并安装更新。以前从 VSIX 安装的用户，需要从 Marketplace 安装一次以切换到市场版本；首次切换后如提示认证，再输入一次密码。
