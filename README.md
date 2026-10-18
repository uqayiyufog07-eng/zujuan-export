# 组卷网试卷导出（网页版）

把原来的油猴脚本搬到网页上：输入组卷网试卷详情页网址，在线生成并下载 **Word（可编辑 / 整题图片）** 或 **PDF**，文件同时归档到 Cloudflare R2，索引存 KV。

- 纯静态单页（`public/index.html`），部署在 Cloudflare Pages
- 用 Pages Functions 做服务端代理，携带环境变量 Cookie 解决登录态与跨域
- 无需油猴、无需浏览器扩展

## 目录结构

```
public/index.html            前端单页（UI + 移植自油猴脚本的解析/导出逻辑）
functions/api/paper.js       代取试卷 HTML（注入 ZUJUAN_COOKIE，剔除脚本）
functions/api/img.js         图片代理（绕过防盗链/跨域）
functions/api/files.js       POST 存 R2 + 写 KV 索引 / GET 导出记录
functions/api/file/[[key]].js  从 R2 下载已存档文件
wrangler.toml                Pages 配置 + R2 / KV 绑定
.github/workflows/deploy.yml push 即自动部署
组卷网试卷导出.user.js        原始油猴脚本（存档参考，未参与构建）
```

## 一次性准备

以下资源**已创建好**（2026-10-18）：

| 资源 | 名称 / ID | 说明 |
| --- | --- | --- |
| R2 Bucket | `zujuan-exports` | 存放导出的 docx / pdf |
| KV Namespace | `EXPORT_INDEX` `67aaf54830b94701a9ea710de3351f78` | 导出记录索引（已写入 wrangler.toml） |
| Pages 项目 | `zujuan-export` | 生产分支 main |

还差两步（都涉及密钥，只能人工做）：

```bash
# 1) 配置登录 Cookie（组卷网 F12 → Network → 任一请求 → 复制 Cookie 整行）
#    已于 2026-10-18 配置到 Pages 生产环境（ZUJUAN_COOKIE），本地开发读 .dev.vars（已 gitignore）
wrangler pages secret put ZUJUAN_COOKIE

# 2) 给 GitHub 仓库加两个 Secret（见下方）
```

本地预览：

```bash
wrangler pages dev public
```

## GitHub Actions 自动部署

仓库 **Settings → Secrets and variables → Actions** 需要添加两个 Secret：

| Secret | 值 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | `5dbfeeed2915872f0855a916283d82c4` | 账号 ID（已可直接填） |
| `CLOUDFLARE_API_TOKEN` | 需自己创建 | 见下方步骤，**不要**用 wrangler 本地 OAuth token 代替 |

创建 `CLOUDFLARE_API_TOKEN`（Cloudflare Dashboard → 右上角头像 → **My Profile → API Tokens → Create Token**）：

1. 选 **Create Custom Token**
2. 权限（Permissions）三行：
   - `Account` → `Cloudflare Pages` → `Edit`
   - `Account` → `Workers R2 Storage` → `Edit`
   - `Account` → `Workers KV Storage` → `Edit`
3. Account Resources 选 `Include - 你的账号`
4. 创建后复制那串 `xxxx-xxxx...`（**只显示一次**）粘到 GitHub Secret

> 本机 wrangler 的 OAuth 凭据**无法**通过 API 创建 API Token（会报 9109 Unauthorized），必须用网页 My Profile 页面手动创建，或用 Global API Key（不推荐）。

push 到 `main` 即触发部署，也可在 Actions 页手动 `Run workflow`。部署完成后 Action 摘要里会给出地址。

> Cookie 不要放进 GitHub Secrets 由 Action 写入——它是**运行时**环境变量，直接在 Cloudflare Pages → Settings → Environment variables 里配 `ZUJUAN_COOKIE` 即可，改完重新部署一次生效。

## 使用说明

1. 打开部署后的站点：**https://zujuan-export.pages.dev**
   - ⚠️ 必须通过部署地址访问。直接双击 `index.html`（file://）或用本地静态服务器打开时，页面会弹出黄色横幅提示「当前环境没有后端服务」——因为 `/api/paper`、`/api/files` 等接口只存在于 Cloudflare Pages 部署环境中
2. 粘贴形如 `https://zujuan.xkw.com/11p3514663.html` 的试卷详情页地址
3. 选格式：
   - **Word · 可编辑**：文字/表格可改，公式与插图转为图片（推荐）
   - **Word · 整题图片**：每题整体截图，版式 100% 还原、不可编辑
   - **PDF**：A4 分页，勾选「包含答案和解析」需要 Cookie 已登录
4. 点击生成，完成后可「本地下载」或「云端存档下载」；页面底部列出最近导出记录

### 抓取失败排查

当前组卷网主站（zujuan.xkw.com）的阿里云 WAF 封禁所有云厂商机房 IP（Cloudflare / Azure / GCP 均返回 405），仅住宅/代理出口可访问。页面若提示抓取失败，按以下顺序排查：

| 报错关键词 | 原因 | 处理 |
| --- | --- | --- |
| `服务响应格式异常` | 页面不在部署环境打开，或 CDN 边缘缓存 | 用 https://zujuan-export.pages.dev 打开；强刷（Ctrl+F5） |
| `服务响应格式异常（HTTP 502 · text/html）` | Cloudflare 边缘瞬时故障（502 HTML 错误页），或旧版 Function 正则超 CPU 被终止 | 前端已内置自动重试 3 次；重试仍失败请更换网络/代理环境；确认已部署最新版（2026-10-18 修复） |
| `目标站点返回 405` | CF 机房 IP 被 WAF 封 | 配置 `PROXY_URL`（SOCKS5/HTTP 代理，无需开电脑）或 `REVERSE_PROXY_URL`（通用反代）；电脑常开也可用本机抓取器 `FETCHER_URL`。edgetunnel 反代 IP 无效（出口还是 CF） |
| `没有找到试卷正文` | 地址不是试卷详情页 | 换 `…/数字.html` 形式的地址 |
| `没有可导出的答案解析` | Cookie 失效 | 重新复制组卷网 Cookie → `wrangler pages secret put ZUJUAN_COOKIE` → 重新部署 |

## 机房 IP 被封：反代 / 代理出口方案

组卷网主站的阿里云 WAF 封禁所有云厂商机房 IP（Cloudflare / Azure / GCP 出口均返回 405），仅住宅/代理出口可访问。图片域名 `staticzujuan.xkw.com` 不被封禁，`/api/img` 走 Cloudflare 直连即可。

Function 按顺序尝试四个通道，任一成功即返回：

| # | 通道 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| 1 | Workers 直连 | — | 对未被封禁的站点有效（如 example.com） |
| 2 | SOCKS5 / HTTP 代理 | `PROXY_URL` | Worker 内经 `cloudflare:sockets` 手写握手，出口 IP = 代理 IP |
| 3 | 通用 HTTP 反代 | `REVERSE_PROXY_URL` | nginx/VPS 反代、第三方中转站 |
| 4 | 本机抓取器 | `FETCHER_URL` + `FETCH_KEY` | 需电脑开机，见下文 |

### 方案 A：SOCKS5 / HTTP 代理（推荐，无需开电脑）

`PROXY_URL` 支持四种格式：

```
socks5://host:port                  # SOCKS5 无认证
socks5://user:pass@host:port        # SOCKS5 带认证
http://user:pass@host:port          # HTTP CONNECT 代理
https://user:pass@host:port         # HTTPS 代理
tcp://host:port                     # 裸 TCP 中继（edgetunnel 反代 IP 格式）
```

配置（生产环境，重启部署后生效）：

```bash
npx wrangler@4.47.0 pages secret put PROXY_URL --project-name zujuan-export
```

本地开发：把 `PROXY_URL=socks5://127.0.0.1:7891` 写进 `.dev.vars`（即走本机 Clash 的 SOCKS5 出口，需 Clash 运行中），`wrangler pages dev public` 后导出流程与本机 Clash 出口完全一致——**买代理前可先用它验证整条链路**。

> 实测结论（2026-10-18）：
> - **edgetunnel 的「反代 IP」（如 `proxyip.cmliussss.net:443`）对本项目无效**：它们是 Cloudflare Worker 中继，出口依然是 CF 机房 IP，照样 405；且只接受 VLESS 首包、不支持 HTTP CONNECT。
> - 免费公网 SOCKS5 累计实测 20 个全部不可用，不要浪费时间。
> - 可用的是**住宅/代理出口**：付费 SOCKS5（按量付费几块钱即可）、或非 CF 机房的 VPS 自建。
> -  socks5 通道已端到端验证通过：Worker → SOCKS5 → zujuan.xkw.com → 200 真实试卷 HTML。

### 方案 B：通用 HTTP 反代（有 nginx / 中转站时）

```bash
npx wrangler@4.47.0 pages secret put REVERSE_PROXY_URL --project-name zujuan-export
```

拼接规则：含 `{url}` / `{urlenc}` 占位符时替换（`{url}` 原样、`{urlenc}` 编码）；否则按 `?url=<编码后完整地址>` 拼接。例如 `https://your-proxy.example.com/` 会请求 `https://your-proxy.example.com/?url=https%3A%2F%2Fzujuan.xkw.com%2F11p3514663.html`。

### 方案 C：本机抓取器（电脑开机时才可用）

抓取器跑在你电脑上（走你家/Clash 出口），经 Cloudflare Tunnel 暴露给 Function。适合临时/本地验证，**电脑关机即失效**。

```bash
cd fetcher
start.bat          # 双击也行：自动启动抓取器 + 临时隧道（Quick Tunnel）
```

- **Quick Tunnel（零配置）**：日志里出现 `https://xxxx.trycloudflare.com`，配到 Pages：
  ```bash
  npx wrangler@4.47.0 pages secret put FETCHER_URL --project-name zujuan-export
  ```
  地址每次重启都会变，变了要重新配。
- **命名隧道（永久地址）**：一次性准备后地址固定为 `https://fetch.laoqian303.top`：
  ```bash
  cloudflared tunnel login                                  # 浏览器授权 laoqian303.top
  cloudflared tunnel create zujuan-fetch
  cloudflared tunnel route dns zujuan-fetch fetch.laoqian303.top
  # fetcher/cloudflared-config.yml 已就绪，之后 start.bat 会自动走命名隧道
  ```

验证：

```bash
curl http://127.0.0.1:8788/ping                                          # 抓取器本体（pong）
curl -H "x-fetch-key: 你的FETCH_KEY" "https://你的隧道地址/fetch?url=https%3A%2F%2Fzujuan.xkw.com%2F11p3514663.html" | head -c 200
```

诊断工具（线上可直接调用）：

```bash
# 各通道分别尝试，返回各自状态码/长度/标题
curl "https://zujuan-export.pages.dev/api/diag?url=https%3A%2F%2Fzujuan.xkw.com%2F11p3514663.html&proxy=socks5%3A%2F%2Fhost%3Aport"

# socket API 探针（connect/startTls/写入锁状态，排查代理通道用）
curl "https://zujuan-export.pages.dev/api/socketprobe?host=proxy-host&port=1080&flow=socks5&target=zujuan.xkw.com:443"
```

说明：

- `FETCH_KEY` 是抓取器的访问密钥，必须与 `.env` 中的值一致
- 抓取器只在你的电脑开机运行时可用，不用时关闭即可（不影响已生成的下载链接）
- 改 `PROXY_URL` / `REVERSE_PROXY_URL` / `FETCHER_URL` 后需要**重新部署**才生效

## 说明与限制

- 所有解析逻辑跑在浏览器里（隐藏 iframe 渲染取回的 HTML 后复用原脚本逻辑），Worker 只做 HTTP 代理与存储，因此 CPU 不受 Workers 限制
- 依赖 CDN：`html2canvas@1.4.1`、`jspdf@2.5.1`（jsDelivr）
- 单文件上限 45MB；R2 保存的导出文件建议在 R2 设置生命周期规则定期清理
- 未配置 Cookie 时公开试卷仍可导出，但拿不到答案解析图
