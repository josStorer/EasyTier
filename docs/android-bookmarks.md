# Android 收藏地址

主界面网络状态上方提供收藏地址下拉框、新建、编辑及启动/继续按钮。保存名称、完整的 HTTP(S) 地址和可选的自动填入配置；支持最多 50 个收藏，选择结果也会保存。普通网址不要求配置 2FA。

例如：

- 网址：填写你自己的完整 HTTP(S) 服务地址，不预填默认地址。
- DOM query：`input[name="otp"]`、`#verification-code` 或 `input[autocomplete="one-time-code"]`
- 密钥：粘贴 Base32 secret 或 `otpauth://totp/...` 导入链接。
- 自动回车：默认关闭；开启后填入会触发 Enter，未被页面阻止时提交所属表单。

使用系统时间生成六位 TOTP，支持 SHA-1、SHA-256、SHA-512 和导入链接中的周期（默认 30 秒）。不支持 HOTP、八位验证码或验证器的批量迁移二维码。编辑时不会回显旧密钥，密钥栏留空表示保留；删除密钥时需同时清空 DOM query。

## 页面和返回菜单

每个收藏使用独立的 Tauri WebView Activity/task。相同收藏已经打开时显示“继续”，恢复原 Activity，保留当前网页状态；不同收藏可以同时保留。系统返回键提供：

1. 退出页面，回到主页：销毁当前页面。
2. 保留页面，仅回到主页：保留页面实例，下次通过“继续”恢复。
3. 取消：留在当前页面。

已打开的收藏需要先退出页面，再编辑或删除，避免保存的新密钥和正在使用的配置不一致。页面保留仅限当前应用进程，Android 回收进程后需重新启动页面；收藏配置和密钥仍保存在本机。

启动会等待 Android WebView 实际挂载确认。代理设置超过 5 秒或 Activity 挂载等待超过 10 秒会报错并清理本次启动；再次点击可重试。每次新建页面使用独立的内部窗口标识，按收藏 ID 恢复已有 Activity，避免失败窗口残留导致永久显示“仍在打开”。Tauri 的 Activity 参数使用相对类名 `BookmarkActivity` / `MainActivity`。

排查启动问题时，应用日志中的 `bookmark launch` / `bookmark activity` 记录包含启动阶段和窗口标识；Android `adb logcat -s EasyTierBookmark` 可查看准备、代理就绪、挂载、恢复及取消记录。不记录网址、密钥或验证码。

## 自动填入边界

从 WebView 创建起，最多持续检测 8 秒，每 100 毫秒检查一次。找到可编辑的 input/textarea 后才计算当时的验证码，触发 input/change 事件并停止检测；超时、无效选择器或非输入元素也会停止。页面底部显示检测、成功或失败信息，点击提示可收起。继续已有页面不会再次填入；需要重新检测时退出页面再启动。

仅在配置 URL 的同一来源（协议、主机、端口）填入，不跨来源重定向、不进入 iframe 或 Shadow DOM。自动回车是网页合成事件：使用可信键盘事件检测或特殊自定义控件的页面可能仍需手动提交。手机时间应准确。

## 保存和访问通路

- 收藏数据和密钥通过 Android Keystore AES-GCM 加密后保存在应用私有 SharedPreferences。前端只能读到是否已配置密钥，不能读取已有 secret；密钥不会写入 Intent、页面脚本或日志。卸载、清理应用数据或丢失 Keystore 密钥后无法恢复。没有添加密钥导出或云同步。
- 外部收藏页面不授予主界面 Tauri 插件权限，并明确拒绝应用管理命令；保留标准 HTTPS 证书校验。
- Release APK 允许用户配置的 HTTP 服务。HTTPS 仍由 WebView 直接处理 TLS；没有关闭证书验证或解密 HTTPS 流量。
- EasyTier 的 UID 被排除在自身 VPN 之外。Android WebView 使用仅监听 127.0.0.1、随机端口的 SOCKS CONNECT 转发器：IPv4 组网地址通过核心 data-plane TCP 访问，无组网路由的地址走本机网络；不改动原 VPN 排除列表。限制同时处理 64 条连接、握手 10 秒及建连 12 秒。代理随应用进程退出关闭。
- 域名使用系统 DNS。仅在 EasyTier 内部才能解析的域名可能需要改用虚拟 IP；当前核心 TCP data-plane 仅支持 IPv4，普通 IPv6 网站走本机网络。原来的 VPN/HTTP 服务和服务器路由配置仍需正常。
- AndroidX WebView 需要支持 `PROXY_OVERRIDE`；缺少能力时启动报错，需更新 Android System WebView。
- 关闭收藏 Activity 不会注销主界面的 VPN 网络监听，返回主页也不模拟桌面图标启动，不改变用户的手动停止意图。

实现参考 [Tauri 多窗口](https://v2.tauri.app/learn/mobile-multiwindow/)、[Android WebView 代理](https://developer.android.com/reference/androidx/webkit/ProxyController) 和 [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238)。

## 验证

本地检查包括 Vue/PrimeVue 实际点击、新建/编辑/删除、多个收藏下拉切换、持久存储桥接模拟、继续按钮、读取失败后重试；执行实际注入脚本验证动态输入、来源限制、过期不填入、输入事件及可选提交；JVM 执行 RFC TOTP 向量、时间切换及错误导入测试；Rust 测试分段 SOCKS 协议和真实本地 HTTP 转发。

```sh
pnpm --filter easytier-gui build
pnpm --filter easytier-gui test:mobile-vpn
pnpm --filter easytier-frontend-lib exec vitest run --config vitest.config.ts tests/gui-bookmarks.spec.ts
cargo test -p easytier-gui --lib bookmark_socks --locked
# Tauri Android 构建生成 Gradle 插件工程之后：
cd easytier-gui/src-tauri/gen/android
./gradlew :tauri-plugin-vpnservice:testDebugUnitTest --tests com.plugin.vpnservice.BookmarkTotpTest
```

CI 的 aarch64 构建包含收藏界面测试和 TOTP JVM 测试。Kotlin 本地检查使用真实 Android/AndroidX API，生成的 Tauri Activity/插件桥使用对照锁定版本的签名替身；这不等同于完整 Android 构建或运行。最终 APK、Keystore 重启持久性、多 Activity 返回/继续行为、真实远端 HTTP/HTTPS、系统回收后恢复以及具体服务的 2FA 表单仍需小米真机验收。
