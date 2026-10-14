# DSH Side Chat

独立 DSH 插件，在原生右侧栏打开临时侧聊，复用原生聊天布局。适配 DSH Core `0.2.0-rc.1` 的 Desktop 与 Web 插件接口。

- 输入 `/side`，或点击会话标题栏的“打开侧聊”按钮。
- 输入 `/side 问题`，打开侧聊并直接提问。
- 侧聊使用原生聊天界面，支持流式回复、连续提问、附件、停止、模型和权限设置。
- 打开时聊天区为空。主会话历史只作为后台参考上下文；侧聊界面只显示打开后提交的新问题和回复。
- 主会话继续运行；侧聊独立处理新问题，不自动继续主任务、目标或历史中的工具调用。打开时读取当前已记录的上下文，尚未提交的流式片段不包含在快照中。
- 同一主会话再次执行 `/side` 会打开已有侧聊。侧聊中不能再创建侧聊。
- 临时侧聊不出现在普通会话列表。使用原生侧栏标签关闭入口，停止并清理侧聊；再次打开会创建新的空侧聊。
- 页面离开、App 退出或插件停用会结束侧聊。若进程被强制终止，下一次启用时只清理该版本标记的临时侧聊缓存。

按 Codex `/side` 的临时会话语义设计：后台继承上下文，可见记录独立，结束时丢弃。底层使用 DSH 原生分支及临时磁盘缓存，关闭时通过原生会话删除接口清理；不保留可恢复归档。继承的目标只在侧聊分支清除，主会话的目标不变。模型和权限沿用 DSH 的原生分支行为。0.1.0 已保存的分支没有新版本的临时标记，升级会保留这些旧记录。

## 安装

在 Desktop 的插件管理中添加 `github:yhfgyyf/dsh-side-chat#v0.1.1`，安装并启用。安装后完整退出并重新打开 App，使 Host 和 Client 都加载插件。

网页版安装到 Web profile：

```sh
dsh plugin --profile web add 'github:yhfgyyf/dsh-side-chat#v0.1.1'
```

然后重启 Web 进程并刷新页面。也可从 [GitHub Releases](https://github.com/yhfgyyf/dsh-side-chat/releases/tag/v0.1.1) 下载 `dsh-side-chat-0.1.1.tgz`：Desktop 使用插件管理中的本地绝对路径，Web 使用 `dsh plugin --profile web add /绝对路径/dsh-side-chat-0.1.1.tgz`。

已验证 DSH Desktop `0.1.39` / Core `0.2.0-rc.1` 的 Desktop 与原生 Web。DSH 仍处于快速迭代阶段，其他 Core 版本尚未验证。

## 开发

使用 Node.js 22.12+ 或 24：

```sh
git clone https://github.com/yhfgyyf/dsh-side-chat.git
cd dsh-side-chat
npm ci
npm test
npm run build
```

源码在 `src/`，构建输出在 `dist/package/`。仓库包含构建产物，从 GitHub 安装无需在用户 profile 编译 Client。插件通过 `dsh.bundle.patch` 加载 Host，通过 `dsh.client` 与 `./client` 导出加载浏览器模块，React 由 DSH 原生模块表提供。结构参考 [官方 UI 插件说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/preset/agent-preset/skills/cordis-plugin-development/references/ui-plugin.md)。

`npm run test:app` 和 `npm run test:web` 是原生集成检查，需要相邻的 `../dsh-desktop` App 源码目录，且其中已安装 Electron、构建 App 并准备 `.runtime`。检查使用隔离 profile 和本地模拟模型，不访问真实模型服务。`npm run check` 执行全部检查，覆盖空白开启、后台上下文、连续提问、关闭清理、重新创建、页面离开时清理和主会话继续运行。Web 检查启动原生 `dsh --profile web` 网页前端，不注入 Desktop 桥接。

打包可运行 `npm pack ./dist/package --pack-destination /绝对路径/输出目录`。Vite 仅用于开发构建；发行插件没有生产依赖，不包含 App 运行时或其他用户插件。Apache-2.0 许可见 [LICENSE](LICENSE)。
