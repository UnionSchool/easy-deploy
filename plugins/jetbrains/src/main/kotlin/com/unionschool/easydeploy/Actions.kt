package com.unionschool.easydeploy

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.ide.util.PropertiesComponent
import java.io.File
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.CompletableFuture

private const val TARGET_KEY = "easyDeploy.target"
private const val CLI_GUIDANCE = "未找到 Easy Deploy CLI。请安装 Node.js 和 easy-deploy，并确认 IDE 的 PATH 能找到 easy-deploy。"
@Volatile private var cliChecked = false

private fun checkCli(base: String) {
    if (cliChecked) return
    val process = try {
        ProcessBuilder("easy-deploy", "--version", "--json").directory(File(base)).redirectErrorStream(true).start()
    } catch (_: Exception) { error(CLI_GUIDANCE) }
    process.outputStream.close()
    if (!process.waitFor(5, TimeUnit.SECONDS)) {
        process.destroyForcibly()
        error(CLI_GUIDANCE)
    }
    val version = try { JsonParser.parseString(process.inputStream.bufferedReader().readText().trim()).asString }
    catch (_: Exception) { "" }
    if (process.exitValue() != 0 || !version.matches(Regex("\\d+\\.\\d+\\.\\d+"))) error(CLI_GUIDANCE)
    cliChecked = true
}

private fun cli(project: Project, vararg args: String, indicator: ProgressIndicator? = null): JsonObject {
    if (indicator?.isCanceled == true) error("操作已取消")
    val base = project.basePath ?: error("请先打开项目")
    checkCli(base)
    if (indicator?.isCanceled == true) error("操作已取消")
    val command = listOf("easy-deploy", *args, "--json")
    val process = try {
        ProcessBuilder(command).directory(File(base)).redirectErrorStream(true).start()
    } catch (error: Exception) {
        error("$CLI_GUIDANCE ${error.message}")
    }
    process.outputStream.close()
    val captured = CompletableFuture.supplyAsync { process.inputStream.bufferedReader().readText().trim() }
    while (!process.waitFor(200, TimeUnit.MILLISECONDS)) {
        if (indicator?.isCanceled == true) {
            process.destroyForcibly()
            error("操作已取消")
        }
    }
    val text = captured.get()
    val response = try { JsonParser.parseString(text.lines().last()).asJsonObject }
    catch (_: Exception) { error("Easy Deploy CLI 输出无效：${text.take(500)}") }
    if (process.exitValue() != 0) error(response.get("message")?.asString ?: text.take(500))
    if ((args.firstOrNull() == "targets" || args.firstOrNull() == "status") && response.get("apiVersion")?.asInt != 1) {
        error("Easy Deploy CLI 版本不兼容，请安装与插件匹配的 easy-deploy")
    }
    return response
}

private fun selectedTarget(project: Project): String {
    val selected = PropertiesComponent.getInstance(project).getValue(TARGET_KEY)
    if (selected != null) return selected
    return cli(project, "targets").get("default").asString
}

private fun onUi(action: () -> Unit) {
    ApplicationManager.getApplication().invokeLater(action)
}

private fun confirm(project: Project, message: String): Boolean {
    var approved = false
    ApplicationManager.getApplication().invokeAndWait {
        approved = Messages.showYesNoDialog(project, message, "Easy Deploy", Messages.getWarningIcon()) == Messages.YES
    }
    return approved
}

abstract class TransferAction(private val direction: String) : AnAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = event.project != null && event.getData(CommonDataKeys.VIRTUAL_FILE) != null
    }

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        val file = event.getData(CommonDataKeys.VIRTUAL_FILE) ?: return
        val base = project.basePath ?: return
        val root = Path.of(base).toAbsolutePath().normalize()
        val selected = Path.of(file.path).toAbsolutePath().normalize()
        if (!selected.startsWith(root)) {
            Messages.showErrorDialog(project, "所选文件不在项目目录内", "Easy Deploy")
            return
        }
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Easy Deploy", true) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val target = selectedTarget(project)
                    val status = cli(project, "status", "-t", target, indicator = indicator)
                    val localRoot = root.resolve(status.get("local").asString).normalize()
                    if (!selected.startsWith(localRoot)) error("所选文件不在 Target 的 local 目录内")
                    val relative = localRoot.relativize(selected).toString().ifEmpty { "." }
                    val plan = cli(project, direction, relative, "-t", target, "--dry-run", indicator = indicator)
                    val count = plan.getAsJsonArray("items")?.count { it.asJsonObject.get("directory")?.asBoolean != true } ?: 0
                    if (direction == "up" && status.get("protected")?.asBoolean == true) {
                        val host = status.get("host")?.asString ?: ""
                        val remote = status.get("remote")?.asString ?: ""
                        if (!confirm(project, "受保护目标 $target：将上传 $count 个文件到 $host$remote。继续？")) return
                    }
                    val flags = mutableListOf<String>()
                    if (direction == "up" && status.get("protected")?.asBoolean == true) flags.add("--approved-protected")
                    if (direction == "down") {
                        val existing = plan.getAsJsonArray("items")?.count { item -> item.asJsonObject.get("directory")?.asBoolean != true && File(item.asJsonObject.get("local").asString).exists() } ?: 0
                        if (existing > 0 && !confirm(project, "将覆盖 $existing 个本地文件。继续？")) return
                        if (existing > 0) flags.add("--approved-overwrite")
                    }
                    val result = cli(project, direction, relative, "-t", target, *flags.toTypedArray(), indicator = indicator)
                    val amount = result.get(if (direction == "up") "uploaded" else "downloaded")?.asInt ?: 0
                    onUi { Messages.showInfoMessage(project, "已处理 $amount 个文件，目标：$target", "Easy Deploy") }
                } catch (error: Exception) {
                    if (indicator.isCanceled) return
                    onUi { Messages.showErrorDialog(project, error.message ?: "操作失败", "Easy Deploy") }
                }
            }
        })
    }
}

class UploadAction : TransferAction("up")
class DownloadAction : TransferAction("down")

class SelectTargetAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Easy Deploy: Select Target", false) {
            override fun run(indicator: ProgressIndicator) {
                try {
                    val response = cli(project, "targets", indicator = indicator)
                    val targets = response.getAsJsonArray("targets").map { it.asString }.toTypedArray()
                    val current = PropertiesComponent.getInstance(project).getValue(TARGET_KEY) ?: response.get("default").asString
                    onUi {
                        val selectedIndex = Messages.showChooseDialog(project, "选择 Target", "Easy Deploy", Messages.getQuestionIcon(), targets, current)
                        if (selectedIndex >= 0) PropertiesComponent.getInstance(project).setValue(TARGET_KEY, targets[selectedIndex])
                    }
                } catch (error: Exception) {
                    onUi { Messages.showErrorDialog(project, error.message ?: "无法读取 Target", "Easy Deploy") }
                }
            }
        })
    }
}
