# 原位终端集成（源码补丁）

目标：在右侧原有「新建终端」卡片中为 **选择了 WSL 的会话**显示 `WSL · <发行版>` 并把它作为该会话的默认项。点击卡片与新建终端快捷键使用同一个会话默认值；CMD 和 PowerShell 仍可手动选。切换会话环境不会自动打开或关闭任何终端。

## 为什么需要 DSH 扩展接口

DSH Desktop `0.2.2-rc.5` 的终端后端只接受已发现的 `shellPath`，参数来自全局配置。客户端又会优先使用同一窗口来源保存的上次选择。只把 `wsl.exe` 加入候选项不够：它会收到通用的 `-i` 参数，也没有机会绑定当前发行版与 Linux 目录。改变全局 `shell` 还会影响其他会话与 Agent 的终端选择。

对应公开源码：[dsh-v0.2.2-rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5)，基线 `9c2670d3bce5275e0d1610272958121af87787bb`。补丁在单独的上游源码目录中实现，不覆盖桌面安装文件。

## 接口与行为

- **Host 按会话解析用户终端配置**：新增生命周期受控的配置提供者注册。每个配置有稳定且带命名空间的逻辑 ID、显示名和可选会话默认标记。可用配置有 Host 构造的可执行文件、独立参数、Host PTY 目录和用于显示的 Linux 目录；不可用配置只有原因，不接受启动。插件从当前会话的已保存环境和工作目录派生配置。
- **只接入用户终端**：`openForAgent` 不读取扩展配置；Agent 沙箱和工具规则不变。浏览器只提交配置 ID，不提交任意命令、参数或进程目录。Host 在创建时用同一个会话重新解析配置，保留原生授权、终端 ID、配额、附件连接、重连和关闭语义。
- **原位下拉和默认动作**：原有 Windows 选项继续可选。WSL 会话默认项优先于窗口之前记住的 Windows 选项；手动选 Windows 只影响这一次打开，不覆盖该 WSL 会话的默认项或污染其他会话的偏好。未提供会话默认项时，保持 DSH 原来的记忆逻辑。WSL 不可用时明确提示，不静默改开 Windows。
- **WSL 适配器**：基于 `wsl.exe --distribution <发行版> --cd <Linux目录>` 的参数数组直接分配用户 PTY。单独传入已验证的 Host 工作目录，不向 CMD 或 PowerShell 的交互提示符自动输入命令。Windows 非 WSL 会话不贡献额外选项。

## 验收用例

1. 同一个窗口中，在 WSL 会话和 Windows 会话交替打开终端：菜单选项和默认值各自正确。WSL 的 `uname -s` 为 `Linux`，`pwd -P` 为指定发行版内的项目目录。显式选 CMD 或 PowerShell 仍可正常启动。
2. 保留上次 Windows 选项时，WSL 会话的卡片和快捷键仍默认打开 WSL。失效发行版、越界工作目录、切换会话后的过期选择都拒绝启动，而不是回退。
3. 所有旧 Agent 命令权限、已有终端会话、重连和关闭行为保持原样。关闭 WSL 用户终端时，按 PTY 自己的生命周期清理，不终止整个发行版，也不把 Windows 侧退出当作所有 Linux 后台任务已结束的证明。

## Windows Desktop 0.2.2-rc.5 兼容包

`0.1.0-dev.10` 在当前桌面配置中接管原有终端控件和终端服务。它沿用这一版的终端通信协议，在 Host 按会话解析 WSL 默认项，并在插件激活时直接注册终端接口，涵盖热更新时旧接口定义被撤下的情况。刷新现有桌面页面后，WSL 会话的原有「新建终端」菜单会列出发行版，卡片和 `Ctrl` + 反引号共用该默认项。

本地构建使用 [build-terminal-compat.py](../scripts/build-terminal-compat.py)。输入为下面两个正式 npm 包的源码，按上游补丁的路径解包后，运行 `git apply --exclude='*/tests/*'` 应用补丁。构建脚本验证包名和版本，生成包含桌面兼容组件的独立打包目录。在新目录内运行 `npm pack --ignore-scripts` 可得到安装包。

- `@deepseek-ai/dsh-api-terminal-controller@0.2.2-rc.5` 放在 `packages/api/terminal-controller`。
- `@deepseek-ai/dsh-client-ui-sidebar-terminal@0.2.2-rc.5` 放在 `packages/client/ui-sidebar-terminal`。
- 提供 esbuild 0.27.2 和客户端依赖目录。依赖版本为 DSH 的 `dsh-deque`、`dsh-util-crypto`、`dsh-typert-protocol` 0.2.2-rc.5，以及 `@xterm/xterm` 6.0.0、`@xterm/addon-fit` 0.11.0。每个依赖解包到 `<依赖目录>/<包名>/package`。

## 本地补丁与验证范围

- [上游源码补丁](upstream/dsh-v0.2.2-rc.5-user-terminal-profiles.patch)面向上面的精确 Git 标签。在**独立的 DSH 源码检出**执行 `git apply --check <补丁路径>`，通过后执行 `git apply <补丁路径>`。需要按上游构建流程重新生成 Host／Client 的 Typert 描述符和桌面产物；不要将源码或补丁写进已安装的 `app.asar`。
- 插件通过 `terminalController.registerUserShellProfiles(owner, resolver)` 贡献会话配置。没有这个方法的 Desktop 版本会跳过终端注册，现有 Agent 命令切换仍可使用。
- 补丁已在逐个核对过 Git 对象哈希的干净源码上重放。19 项插件单测、8 项原生 Host 单测、5 项 Client 选择单测通过；另用隔离进程替身执行实际 Host 控制器，验证 WSL 默认、Windows 手动选项、无静默回退、Host 与 Linux 目录区分、Agent 路径不接入。
- Windows 原生伪终端的独立测试通过：进入指定 WSL 发行版和项目目录，接收输入、返回 `Linux` 和对应路径并退出。该测试不使用当前应用窗口，也不证明所有分离的 Linux 后台进程会在关闭 PTY 时退出。
- **未验证**：完整 DSH 构建、生成后的 RPC 编解码、当前桌面 GUI 实际点击。通过源码安装插件时，终端菜单由所用 Desktop 版本的原生终端扩展接口决定。

开发测试：`node test/unit.mjs`。验证补丁中的真实 Host 控制器时，可执行 `node test/probe-terminal-controller-integration.mjs <已应用补丁的源码根目录> <typescript.js>`；Windows 原生 PTY 实测脚本为 `test/probe-wsl-user-terminal-pty.mjs`（需同 ABI 的 Node/Electron 和已安装的 `node-pty`）。
