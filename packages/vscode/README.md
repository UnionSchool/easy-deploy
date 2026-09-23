# Easy Deploy for VS Code

在项目根目录创建 `easy-deploy.json`，然后在文件树或编辑器右键菜单中选择 Easy Deploy Upload/Download。状态栏显示当前 Target；点击可切换目标。SFTP 需要系统 OpenSSH。

macOS 使用 `⌃⌘U` 上传、`⌃⌘G` 下载；Windows/Linux 使用 `Ctrl+Alt+U`、`Ctrl+Alt+G`。编辑器作用于当前文件，文件树作用于选中的文件或目录。上传前会保存未保存修改。可在 VS Code 的键盘快捷方式设置中修改。

密码认证首次使用时输入密码并保存在系统凭据中；用命令面板的 Set Password / Forget Password 管理。保存自动上传可在目标中设置 `"uploadOnSave": true`，默认关闭且不能用于受保护目标。

SFTP 使用本机 SSH 配置和 `known_hosts`。FTP 须在配置中显式启用。完整配置示例见仓库根目录 README。
