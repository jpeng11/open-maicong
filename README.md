# Maicong Studio

**简体中文** | [English](./README.en.md)

迈从 G75 V2 机械轴键盘的 macOS 本地驱动。官方驱动仅提供 Windows 版与网页版，本项目让 G75 V2 可以在 Mac 上直接进行本地配置，不依赖云端服务，也不产生网络请求。

> 社区独立开源项目，与迈从（MCHOSE）无任何隶属、赞助或授权关系。迈从为商标所有人的注册商标。

## 能做什么

在 Mac 上管理 G75 V2 机械轴键盘的主要功能：

| 模块 | 说明 |
| :--- | :--- |
| 灯光 | 主灯效 0-22、自定义静态图 / GIF、侧灯 1-4、亮度 / 速度 / 方向 / 颜色、白平衡 |
| 按键设置 | Win / WinFn / Mac / MacFn 四层，点击或拖拽改键，复制 / 剪切 / 粘贴，快捷键录制，恢复默认 |
| 高级按键 | MT、TGL、SOCD（0-3）、组合键 CB、绑定列表、按键测试器、一键清空 |
| 性能 | 回报率 1 / 2 / 4 / 8 kHz、休眠时间 1-30 分钟、永不休眠、连击、锁定 Win 键、Mac / Win 模式切换 |
| 宏 | 16 个硬件槽位，录制 / 暂停 / 继续，循环播放次数 0 / 1 / 255 |
| 配置 | 4 个板载槽位，支持独立加载与激活，本地配置库容量 20 个，兼容官方 KeyboardProfile v3 导入导出 |
| 其他 | 恢复出厂设置（当前板载 / 全部板载）、固件更新（选用官方安装包，界面核对文件体积与 SHA-256） |
| 游戏绑定 | 将板载配置关联到本地应用程序，当应用切换到前台时自动激活对应配置 |
| 界面语言 | 标题栏提供 中文 / EN 切换，默认中文并自动保存选择 |

Rapid Trigger、DKS 和行程校准等磁轴专属功能不适用于 G75 V2 机械轴键盘，本应用不支持这些功能。

应用通过 `connect-src 'none'` 安全策略完全离线运行，因此官方网页端具备的云端配置库、分享码、在线固件下载及音频律动灯效不在支持范围内。

## 系统要求

- macOS 13 Ventura 或更高版本（支持 Apple Silicon 与 Intel 架构）
- 迈从 G75 V2 键盘，通过 2.4G 接收器或 USB-C 有线方式连接
- 本地开发与打包需要 Node.js 22.12+ 及 npm

## 安装与打开

### Homebrew（推荐，Apple Silicon）

```bash
brew install --cask jpeng11/open-maicong/maicong-studio
```

该命令会自动添加 tap 源 [`jpeng11/homebrew-open-maicong`](https://github.com/jpeng11/homebrew-open-maicong) 并安装 cask。当前预编译包为 Apple Silicon 架构 0.1.0 版本的临时签名程序（ad-hoc，未加入 Apple Developer ID），cask 在安装过程中会自动清除 Gatekeeper 隔离属性。若系统仍提示拦截，请前往 系统设置 > 隐私与安全性 > 仍要打开。

Intel Mac 用户可以从源码运行，或在 Intel 设备上执行 `npm run dist` 进行本地打包（electron-builder 会按当前系统架构构建）。

```bash
brew upgrade --cask maicong-studio          # 升级
brew uninstall --cask maicong-studio        # 卸载
brew uninstall --cask --zap maicong-studio  # 卸载并删除本机配置
```

已安装完成后：

```bash
open -a "Maicong Studio"
```

也可以通过启动台或 Spotlight 搜索 Maicong Studio 启动。应用程序位于 `/Applications/Maicong Studio.app`。

### 安装包

从 [GitHub Releases](https://github.com/jpeng11/open-maicong/releases) 下载 `Maicong-Studio-*-arm64.dmg`，将应用拖入「应用程序」目录即可。本地打包文件输出在 `dist/` 目录中（该目录已配置 git 忽略）。

> 发布页面的安装包可能滞后于最新源码。若需体验最新修改，可在项目根目录运行 `npm start`。

## 从源码运行

```bash
cd "/path/to/open-maicong"
npm install
npm start
```

常用开发命令：

```bash
npm test              # 单元测试
npm run test:mock-ui  # 真实界面与内存模拟键盘（不访问实际 HID 设备）
npm run smoke         # 离线窗口冒烟测试
npm run dist          # 打包 DMG 与 ZIP 安装包（路径中请勿包含空格）
```

如果项目所在路径包含空格（例如挂载磁盘名为 `Extreme SSD`），`node-gyp` 和 electron-builder 打包可能会报错。请将代码同步至无空格路径后再执行打包，详见 [开发说明](./docs/DEVELOPER.md)。

## 使用提示

1. 插入 2.4G 接收器或连接 USB-C 数据线后启动应用，左侧状态栏会显示连接状态。
2. 标题栏右侧可自由切换 中文 / EN。首次启动默认为中文，切换后会自动保存在本地配置中。
3. 「加载编辑」仅将板载配置读入编辑界面，点击「激活」后键盘才会实际切换到该板载配置。
4. 灯光与按键参数修改后会自动保存到当前选中的配置槽；激活配置、启用第 4 个配置槽、恢复出厂设置以及固件升级等操作需要二次确认。
5. 固件升级说明：有线连接仅用于升级键盘 MCU 固件，2.4G 连接用于升级接收器 RF 固件。选定官方 `.bin` 文件后，应用会展示文件大小及 SHA-256 哈希值供确认，确认前取消不会向硬件写入任何数据。
6. 应用联动设置位于「备份」页面的板载配置卡片上：绑定本地 `.app` 后，当对应软件切换至前台时，键盘会自动切换至该板载配置。

## 设备安全与验证状态

- 配置接口采用非独占模式（`nonExclusive` HID），通信时系统原生打字输入通道不受影响。
- 软件完全离线工作，无网络请求、遥测数据上报或用户账号系统。
- 数据写入前会严格校验数据结构与数值范围，遇异常数据直接拒绝执行。
- 读取逻辑已在 2.4G 接收器实物设备上完成核对（测试固件版本为 MCU 1.14 / RF 1.30）。
- 写入相关功能（改键、灯效控制、宏、配置激活、恢复出厂及固件烧录）均已通过内存模拟层完整验证，但尚未在量产物理键盘上进行极端破坏性测试。在对键盘进行大范围改动前，建议先导出备份文件。

完整功能对照请查阅 [功能对照（PARITY）](./docs/PARITY.md)。通信协议与开发细节请参考 [开发说明](./docs/DEVELOPER.md)。

## 许可证

本项目基于 [MIT](./LICENSE) 许可证分发。版权所有 © 2026 Open Maicong Contributors。
