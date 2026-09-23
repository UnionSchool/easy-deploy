# Easy Deploy for VS Code

在项目根目录创建 `easy-deploy.json`，然后在文件树或编辑器右键菜单中选择 Easy Deploy Upload/Download。状态栏显示当前 Target；点击可切换目标。SFTP 需要系统 OpenSSH。

SFTP 使用本机 SSH 配置和 `known_hosts`。FTP 须在配置中显式启用。完整配置示例见仓库根目录 README。
