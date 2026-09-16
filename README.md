# Maicong Studio

**简体中文** | [English](./README.en.md)

迈从 G75 V2 **机械轴**键盘的 macOS 本地驱动。官方只提供 Windows 与网页版 Hub，本应用在 Mac 上直接连接键盘，不依赖云端、不请求外网。

> 社区独立项目，**与迈从（MCHOSE）无任何隶属、赞助或授权关系**。迈从为权利人商标。

## 能做什么

在 Mac 上管理 G75 V2 机械轴 Hub 的主要功能：

| 模块 | 说明 |
| :--- | :--- |
| 灯光 | 主灯效 0–22、自定义静图 / GIF、侧灯 1–4、亮度 / 速度 / 方向 / 颜色、白平衡 |
| 按键设置 | Win / WinFn / Mac / MacFn 四层，点击或拖拽改键，复制 / 剪切 / 粘贴，快捷键录制，恢复默认 |
| 高级按键 | MT、TGL、SOCD（0–3）、组合键 CB、绑定列表、测试器、一键清空 |
| 性能 | 1 / 2 / 4 / 8 kHz、休眠 1–30 分钟、永不休眠、连击、锁定 Win、Mac / Win 模式 |
| 宏 | 16 个硬件槽，录制 / 暂停 / 继续，播放次数 0 / 1 / 255 |
| 配置 | 4 个板载槽，激活与加载编辑分离，本机库容量 20，官方 KeyboardProfile v3 导入导出 |
| 其他 | 恢复出厂（当前板载 / 全部）、固件升级（选用官方包，需核对体积与 SHA-256） |
| 游戏绑定 | 将板载配置绑定到本机 App，前台切换时自动激活对应配置 |
| 界面语言 | 标题栏 **中文 / EN**，默认中文，选择会记住 |

磁轴专属功能（Rapid Trigger、DKS、行程校准等）不属于 G75 V2 机械轴，本应用不提供。

网页 Hub 的云端配置库、分享码、CDN 固件下载、音乐律动灯效不在范围内：应用强制 `connect-src 'none'`，全程离线。

## 系统要求

- macOS 13 Ventura 或更高（Apple Silicon 或 Intel）
- 迈从 G75 V2，通过 **2.4G 接收器** 或 **USB-C 有线** 连接
- 开发 / 打包另需 Node.js 22.12+ 与 npm

## 安装与打开

### Homebrew（推荐，Apple Silicon）

```bash
brew install --cask jpeng11/open-maicong/maicong-studio
```

一条命令会自动 tap [`jpeng11/homebrew-open-maicong`](https://github.com/jpeng11/homebrew-open-maicong)，并只信任这一条 cask。当前包为 **未签名** Apple Silicon 0.1.0；cask 安装时会去掉 Gatekeeper 隔离属性。若仍拦截：系统设置 → 隐私与安全性 → 仍要打开。

Intel Mac 请从源码运行或自行打包（`npm run dist:all`）。

```bash
brew upgrade --cask maicong-studio          # 升级
brew uninstall --cask maicong-studio        # 卸载
brew uninstall --cask --zap maicong-studio  # 卸载并删除本机配置
```

已安装时：

```bash
open -a "Maicong Studio"
```

或在「启动台 / Spotlight」搜索 **Maicong Studio**。应用位于 `/Applications/Maicong Studio.app`。

### 安装包

从 [GitHub Releases](https://github.com/jpeng11/open-maicong/releases) 下载 `Maicong-Studio-*-arm64.dmg`，将应用拖入「应用程序」。本地打包产物在 `dist/`（不进 git）。

> 安装包可能落后于源码。要跑最新源码：在项目目录执行 `npm start`。

## 从源码运行

```bash
cd "/path/to/open-maicong"
npm install
npm start
```

常用命令：

```bash
npm test              # 单元测试
npm run test:mock-ui  # 真实界面 + 内存模拟键盘（不打开 HID）
npm run smoke         # 离线窗口冒烟
npm run dist          # 打包 DMG / ZIP（路径中不要有空格）
```

项目路径含空格时（例如磁盘名 `Extreme SSD`），`node-gyp` / electron-builder 可能失败。请先同步到无空格目录再打包。详见 [开发说明](./docs/DEVELOPER.md)。

## 使用提示

1. 插入 2.4G 接收器或 USB-C，打开应用，侧栏应显示已连接。
2. 标题栏右侧可切换 **中文 / EN**。日常启动默认为中文，选择会保存在本机。
3. **加载编辑** 只读入本机编辑区；**激活** 才会切到键盘正在使用的板载配置。
4. 灯光与按键改动会自动保存到当前编辑目标；激活、启用第 4 配置、恢复出厂、固件升级需要你再点一次。
5. 固件升级：有线升键盘 MCU，2.4G 升接收器 RF。自行选择官方 `.bin`，核对目录中的大小与哈希后再确认。取消不会发擦除包。
6. 游戏绑定在「备份」页的板载卡片上：链接本机 `.app`，该应用位于前台时自动激活对应板载配置。

## 安全与诚实边界

- 配置口使用 `nonExclusive` HID，系统打字通道保持可用。
- 无远程请求、无遥测、无账号。
- 写入前做模式校验；失败默认拒绝，不会悄悄截断。
- **读**：已在实物 2.4G 接收器上核对（MCU 1.14 / RF 1.30）。
- **写**（改键、灯光、宏、激活、恢复出厂、刷固件）：协议与界面已用内存模拟验证，**尚未在实物键盘上做破坏性验证**。请自行备份后再改机。

完整对照见 [功能对照（PARITY）](./docs/PARITY.md)。协议与开发细节见 [开发说明](./docs/DEVELOPER.md)。

## 许可证

[MIT](./LICENSE)。版权所有 © 2026 Open Maicong Contributors。
