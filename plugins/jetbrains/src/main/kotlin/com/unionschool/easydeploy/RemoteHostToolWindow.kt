package com.unionschool.easydeploy

import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.content.ContentFactory
import java.awt.BorderLayout
import java.io.File
import javax.swing.JButton
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTree
import javax.swing.JToolBar
import javax.swing.SwingUtilities
import javax.swing.event.TreeExpansionEvent
import javax.swing.event.TreeWillExpandListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.ExpandVetoException

private data class RemoteFile(val name: String, val relative: String, val directory: Boolean, val link: Boolean = false) {
    override fun toString() = name
}

class RemoteHostToolWindow : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val root = DefaultMutableTreeNode(RemoteFile("远程目录", ".", true))
        val model = DefaultTreeModel(root)
        val tree = JTree(model)
        val panel = JPanel(BorderLayout())
        val toolbar = JToolBar().apply { isFloatable = false }

        fun load(node: DefaultMutableTreeNode) {
            val item = node.userObject as RemoteFile
            if (!item.directory || item.link) return
            ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Easy Deploy: 读取远程目录", true) {
                override fun run(indicator: ProgressIndicator) {
                    try {
                        val target = selectedTarget(project)
                        val result = cli(project, "ls", item.relative, "-t", target, indicator = indicator)
                        val children = result.getAsJsonArray("entries").map { value ->
                            val entry = value.asJsonObject
                            val name = entry.get("name").asString
                            val relative = if (item.relative == ".") name else "${item.relative}/$name"
                            val file = RemoteFile(name, relative, entry.get("directory").asBoolean, entry.get("link")?.asBoolean == true)
                            DefaultMutableTreeNode(file).apply { if (file.directory && !file.link) add(DefaultMutableTreeNode("…")) }
                        }
                        SwingUtilities.invokeLater {
                            node.removeAllChildren()
                            children.forEach(node::add)
                            model.reload(node)
                        }
                    } catch (error: Exception) {
                        SwingUtilities.invokeLater { Messages.showErrorDialog(project, error.message ?: "读取失败", "Easy Deploy") }
                    }
                }
            })
        }

        tree.addTreeWillExpandListener(object : TreeWillExpandListener {
            override fun treeWillExpand(event: TreeExpansionEvent) {
                val node = event.path.lastPathComponent as DefaultMutableTreeNode
                if (node.childCount == 1 && (node.firstChild as DefaultMutableTreeNode).userObject == "…") load(node)
            }
            override fun treeWillCollapse(event: TreeExpansionEvent) {}
        })

        fun transfer(direction: String) {
            val node = tree.lastSelectedPathComponent as? DefaultMutableTreeNode ?: return
            val item = node.userObject as? RemoteFile ?: return
            if (item.relative == "." || item.link) return
            ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Easy Deploy: 传输", true) {
                override fun run(indicator: ProgressIndicator) {
                    try {
                        val target = selectedTarget(project)
                        val status = cli(project, "status", "-t", target, indicator = indicator)
                        val local = File(project.basePath, status.get("local").asString).resolve(item.relative)
                        if (direction == "up" && !local.exists()) error("本地文件不存在：$local")
                        val flags = mutableListOf<String>()
                        if (direction == "up" && status.get("protected").asBoolean) {
                            var approved = false
                            SwingUtilities.invokeAndWait { approved = Messages.showYesNoDialog(project, "上传到受保护目标 $target？", "Easy Deploy", Messages.getWarningIcon()) == Messages.YES }
                            if (!approved) return
                            flags.add("--approved-protected")
                        }
                        if (direction == "down" && local.exists()) {
                            var approved = false
                            SwingUtilities.invokeAndWait { approved = Messages.showYesNoDialog(project, "覆盖本地文件 $local？", "Easy Deploy", Messages.getWarningIcon()) == Messages.YES }
                            if (!approved) return
                            flags.add("--approved-overwrite")
                        }
                        cli(project, direction, item.relative, "-t", target, *flags.toTypedArray(), indicator = indicator)
                        SwingUtilities.invokeLater { Messages.showInfoMessage(project, "传输完成：${item.relative}", "Easy Deploy") }
                    } catch (error: Exception) {
                        SwingUtilities.invokeLater { Messages.showErrorDialog(project, error.message ?: "传输失败", "Easy Deploy") }
                    }
                }
            })
        }

        toolbar.add(JButton("刷新").apply { addActionListener { root.removeAllChildren(); root.add(DefaultMutableTreeNode("…")); model.reload(root); load(root) } })
        toolbar.add(JButton("上传").apply { addActionListener { transfer("up") } })
        toolbar.add(JButton("下载").apply { addActionListener { transfer("down") } })
        root.add(DefaultMutableTreeNode("…"))
        panel.add(toolbar, BorderLayout.NORTH)
        panel.add(JScrollPane(tree), BorderLayout.CENTER)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel, "", false))
        load(root)
    }
}
