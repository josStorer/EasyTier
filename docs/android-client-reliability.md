# Android 客户端连接改进

基于 upstream main `0a783c8e04561d1fee4e3e922e9576402d5bfea3`（2.7.0 源码），不是在 2.6.4 发布包上打补丁。仓库包含 Vue 界面、Rust 核心和 Kotlin Android VPN 服务。

## 行为

- 左下角配置服务器入口支持保存多组名称和 URL，选择一组生效；旧单 URL 自动迁移。切换并保存时先停止旧连接，再启动所选配置。仅编辑非活动配置或名称不会重连。
- 从桌面图标打开 App 自动连接所选 URL；没有 URL 时尝试上次使用的本地 TUN 网络。授权弹窗返回、页面刷新、网络事件不会取消手动停止状态。再次点连接或从桌面图标打开可以恢复。
- 手动停止同步取消界面重试、停止 Android VPN、关闭配置服务器会话并禁用 TUN 实例。过期启动请求和远端配置回调不能在停止状态下重新启动 VPN。
- 启动检查授权结果、原生服务实际状态、请求 ID 和文件描述符；等待 Rust 核心 TUN 就绪事件后才进入连接阶段。原生服务不再依赖 START_STICKY 自动重建缺少配置的 VPN。
- 物理网络丢失时显示等待网络；Wi-Fi/移动网络切换后合并短时间内的事件，重建核心连接和 VPN。手动停止后不执行这条恢复路径。
- 主界面显示配置等待、地址等待、授权、VPN 启动、节点连接、网络等待、重连、错误和重试次数。启动重试最多 60 次，每次间隔 2 秒；单次 VPN 启动等待上限 10 秒，核心接入等待上限 5 秒。

“VPN 已建立，节点已连接”表示 VPN 和节点状态正常，不代表某个 HTTP 服务已通过探测。本次保留现有路由和子网代理方式：访问远端局域网 HTTP 仍需要对端正确配置子网代理、HTTP 监听地址及防火墙。

## 与上游问题的关系

- [#2491](https://github.com/EasyTier/EasyTier/pull/2491) 的启动时序修复已在当前主线中。本次继续处理授权、原生启动确认、停止意图及网络切换。
- [#2595](https://github.com/EasyTier/EasyTier/issues/2595) 是连接稳定性讨论/方案。这里采用客户端能够独立完成的网络变化检测、恢复、状态反馈；没有实现整个议题中的传输层连接迁移方案。切网恢复会短暂中断连接，已有 HTTP 请求可能需要刷新重试。

## GitHub CI 构建

将修改提交到自己的 fork 后，在 Actions 启用工作流，选择 **EasyTier Mobile → Run workflow**。工作流也保留 main、develop、releases 分支 push 和 PR 触发。

小米 15 下载构建产物 **easytier-mobile-android-aarch64** 内的 APK。另外三个架构仍按上游矩阵构建。沿用仓库当前签名设置；是否可以覆盖已安装 APK 取决于签名一致性。

工作流在 aarch64 构建前运行移动端模拟测试、配置控件交互测试和 Rust 连接意图测试。Android Rust 交叉编译、Gradle、打包和签名由后面的正式 APK 构建步骤检查。

## 本地验证

已通过：

- 34 项 Vitest 连接/授权/重试/停止/切网/配置迁移模拟测试。
- 1 项真实 Vue + PrimeVue 控件测试：新增、长名称编辑、URL 编辑、下拉切换、删除、保存后重新加载。
- GUI 正式生产构建（包含共享前端库和 TypeScript 检查）。
- `cargo +1.95.0 check -p easytier-gui --lib --locked`，Windows 目标；仅此检查通过环境变量跳过 Windows 打包资源，没有改动资源配置。
- Rust 连接意图失效测试。
- Kotlin 2.1.20 编译检查：真实 Android API 34 和 AndroidX，Tauri 注解及 JSObject 使用锁定版本源码；Plugin/Invoke/生成 Activity 使用核对过的编译签名替身。此项不是完整 Gradle/Android 运行验证。

可复跑的项目命令：

```sh
pnpm install --frozen-lockfile
pnpm --filter easytier-gui build
pnpm --filter easytier-gui test:mobile-vpn
pnpm --filter easytier-frontend-lib exec vitest run --config vitest.config.ts tests/gui-config-server.spec.ts
rustc --edition 2024 --test easytier-gui/src-tauri/src/connection_intent.rs -o connection-intent-tests
./connection-intent-tests
```

未执行完整 Android APK 编译、真机 VPN、HyperOS 后台保活、锁屏长时间运行、真实 Wi-Fi/蜂窝切换和远端 HTTP 访问；因此不能据本地测试保证小米 15 上所有断连都已解决。

## 真机验收

1. 保存两组 URL，选一组保存，确认只连接该组；关闭重开后选择仍保留。
2. 冷启动和热启动 App，首次授权后确认系统 VPN、界面 IP/节点状态及 HTTP 访问。
3. 授权弹窗出现时停止；分别允许/拒绝，确认旧任务不再启动 VPN。
4. 手动停止后等待一分钟、切 Wi-Fi/蜂窝，确认仍停止；重新点连接应恢复。
5. 已连接时关闭网络再恢复，Wi-Fi/蜂窝相互切换，观察等待/重连过程并重试 HTTP 请求。
6. 配置错误、授权拒绝、无网络时检查可见错误；修正后点击连接可重试。
7. 锁屏一段时间后再测；记录界面错误、系统 VPN 状态及日志，以区分系统后台回收与隧道故障。
