# ⚡ 404 checker (移动端多网址网络可达性与延迟检测工具)

<p align="left">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/wwalt1a/404-checker">
    <img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare" />
  </a>
  <a href="https://dash.cloudflare.com/?to=/:account/pages/new">
    <img src="https://img.shields.io/badge/Deploy%20to-Cloudflare%20Pages-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Deploy to Cloudflare Pages" height="32" />
  </a>
</p>

这是一个专为手机端用户设计的**纯前端、无服务器依赖、由浏览器直接发起探测**的多目标网络可达性与 HTTP/HTTPS 延迟检测工具。

> 💡 **核心原则**：
> 1. **100% 浏览器客户端直连**：测试流量由用户设备（手机/电脑）的浏览器内核直接发送给目标站点，真实反映当前网络运营商、Wi-Fi、蜂窝移动网络的访问连通性与耗时。
> 2. **绝无代理中转**：不经由 Cloudflare Worker、VPS 或任何中继服务器，避免测得“服务器到目标站”的虚假低延迟。
> 3. **零后端纯静态**：无需 Node.js、Python、数据库支持，完全兼容 Cloudflare Pages、GitHub Pages 或任何静态托管环境。

---

## 🌟 核心功能特性

- 📱 **移动端优先的高颜值 UI**：
  - 采用流体深色模式（Sleek Dark Theme）与玻璃拟态卡片设计（Glassmorphism）。
  - 针对 iPhone / Android 屏幕全面屏适配，大触控响应区域，无横向溢出。
  - 动态状态呼吸灯、实时进度条推进、平滑微交互动效。
- 🗂️ **三大分类长条下拉菜单**：
  - 🛠️ **自定义网址**：支持自配私有测速目标，自由上下拖拽排序、单项增删或文本批量覆盖导入；
  - 🌐 **国外网址**：预置 GitHub 全生态（官网/API/CDN/Raw/Releases/Gist）、Hugging Face、Cloudflare、Outlook 邮箱网页版、Vercel、NPM、PyPI、Docker Hub、Google、Microsoft、Apple 等重点境外平台；
  - 🇨🇳 **国内网址**：预置百度、清华大学镜像、中科大 USTC、华为云、阿里云、腾讯云、网易 163、字节跳动 CDN、淘宝 npmmirror 等国内基准对照节点。
- ⚙️ **智能探测引擎 (ProbeEngine)**：
  - **CORS 穿透与 Opaque 测量**：通过 `fetch(..., { mode: 'no-cors' })` 配合时间戳防缓存机制，兼容任意第三方公开网站。
  - **毫秒级高精度计时**：基于 `performance.now()` 计算浏览器发起请求至响应接收的真实往返时间。
  - **细分故障诊断**：
    - `✅ 可达 (Reachable)`：完成 TCP+TLS 握手并收到 HTTP 响应。
    - `⏱️ 超时 (Timeout)`：网络丢包或被黑洞静默丢弃（达到设定阈值）。
    - `🚫 阻断/重置 (Blocked/RST)`：在极短时间（<250ms）内被强行切断，常为防火墙 TCP RST 或 DNS 污染。
    - `❌ 异常 (Error)`：底层网络错误或协议错误。
- 🚀 **受控并发通道池 (Worker Pool)**：
  - 默认 6 通道受控并发（可自选 3 / 6 / 10 通道），避免数十个连接瞬间塞满移动端无线队列导致延迟失真。
- 📊 **实用增强功能**：
  - **分类批量与单项重测**：支持对当前选中的分类一键批量探测，或点击单个卡片重测按钮独立重测。
  - **一键复制可用网址**：快速过滤并导出当前分类下所有 `✅ 可达` 的镜像/网址，方便粘贴使用。
  - **PWA 支持**：在手机 Safari 或 Chrome 点击“添加到主屏幕”，即可作为独立轻应用离线秒开。

---

## 🚀 部署至 Cloudflare Pages 指南

本项目为纯静态结构，在 Cloudflare Pages 部署极其简单，支持一键自动化全球上线：

### 方式一：一键自动化部署 (One-Click Deploy)

点击下方官方部署按钮，系统将自动 Fork 本仓库并为您在 Cloudflare 自动创建 Pages 站点：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wwalt1a/404-checker)

---

### 方式二：网页端直接拖拽上传（免 Git、极速体验）

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)，在左侧导航栏点击 **Workers 和 Pages (Workers & Pages)**。
2. 点击 **创建应用程序 (Create application)** -> 选择 **Pages** 选项卡。
3. 选择 **上传资产 (Upload assets)**。
4. 输入您的项目名称（例如 `404-checker`）。
5. 直接将本项目的整个 `404-checker/` 文件夹拖入网页中的上传框中。
6. 点击 **部署站点 (Deploy site)**。
7. 部署完成后，您即可获得一个专属的全球加速二级域名（如 `https://404-checker.pages.dev`）。

### 方式三：关联 GitHub 自动持续集成 (CI/CD)

1. 将本代码推送到您的 GitHub 仓库。
2. 在 Cloudflare Pages 中选择 **连接到 Git (Connect to Git)** 并选择该仓库。
3. 在构建设置中：
   - **框架预设 (Framework preset)**：选择 `None`
   - **构建输出目录 (Build output directory)**：填入 `404-checker`（如果直接在仓库根目录，则填入 `/` 或留空）。
4. 点击 **保存并部署** 即可。之后每次 push 代码均会自动刷新全球节点。

---

## 🛠️ 文件目录结构

```text
404-checker/
├── index.html         # 移动端语义化前端主入口
├── targets.json       # 预置目标网址库（可自由增减维护，支持 categories）
├── manifest.json      # PWA 渐进式网页应用配置
├── sw.js              # Service Worker 离线页面缓存
├── css/
│   └── style.css      # 现代原生 CSS 设计系统（深色模式、玻璃拟态、动效）
├── js/
│   └── app.js         # 核心探测引擎、并发池队列、分类联动与 UI 控制器
└── README.md          # 详细使用与部署说明文档
```

---

- **修改默认网址**：直接编辑 [targets.json](file:///p:/s.F/antigravity/404-checker/targets.json) 文件，遵循结构添加或替换目标即可，无需修改任何 JavaScript 逻辑。
- **本地私有专属网址**：支持创建 `targets.local.json`（受 `.gitignore` 保护，永不上载），其中的网址会自动置顶到“自定义网址”最前方。

---

## 🔐 部署时可选设置访问密码（安全鉴权）

若您在公网部署（如 Cloudflare Pages），希望仅自己或受邀用户可见您的私有测试目标，可一键开启访问密码保护：

### 1. 开启密码保护
直接修改根目录下的 `config.js` 文件：
```javascript
window.AUTH_CONFIG = {
  enabled: true,              // 开启密码保护
  password: "yourPassword",   // 访问密码 (明文方式)
  passwordHash: "",           // 或可选 SHA-256 哈希值 (更安全)
  rememberDays: 7,            // 记住免密状态天数 (默认7天)
  title: "安全访问验证",
  subtitle: "本站点已开启访问控制，请输入访问密码以解锁"
};
```

### 2. 推荐：使用 SHA-256 哈希（避免密码在公共仓库暴露）
在任何现代浏览器中按 F12 打开 Console 控制台，粘贴并执行以下命令生成您密码的哈希：
```javascript
crypto.subtle.digest('SHA-256', new TextEncoder().encode('你的专属密码')).then(b => console.log(Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('')))
```
将生成的 64 位字符串填入 `passwordHash`，并将 `password` 留空即可！

### 3. 严格数据隔离保证
- **未输入密码前**：网页**绝不加载** `targets.json` 或私有网址，DOM 中**完全不渲染**任何卡片、测试域名或仪表盘统计信息，后台**绝不发起**批量网络探测。
- **验证通过后**：优雅淡入解锁，自动加载目标并执行测速。
- **随时重新锁定**：导航栏右上角提供 🔒 按钮，可随时一键锁定并清空会话。

- **用户自定制**：用户在手机浏览器中通过前端弹窗添加、删除或批量导入的网址均会自动保存在手机本地的 `localStorage` 中；点击弹窗底部的“重置为默认网址”即可随时一键复原。
