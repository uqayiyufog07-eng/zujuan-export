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

```bash
# 1) 创建存储资源
wrangler r2 bucket create zujuan-exports
wrangler kv namespace create EXPORT_INDEX

# 2) 把返回的 id 填进 wrangler.toml 的 [[kv_namespaces]]
#    id = "..."  preview_id = "..."

# 3) 配置登录 Cookie（组卷网 F12 → Network → 任一请求 → 复制 Cookie 整行）
wrangler pages secret put ZUJUAN_COOKIE

# 4) 首次创建 Pages 项目（也可由 Action 自动创建）
wrangler pages project create zujuan-export --production-branch=main

# 5) 本地预览
wrangler pages dev public
```

## GitHub Actions 自动部署

仓库 **Settings → Secrets and variables → Actions** 需要添加两个 Secret：

| Secret | 说明 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare API Token，权限至少 `Cloudflare Pages:Edit`、`Workers KV Storage:Edit`、`Workers R2 Storage:Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | 账号 ID |

push 到 `main` 即触发部署，也可在 Actions 页手动 `Run workflow`。部署完成后 Action 摘要里会给出地址。

> Cookie 不要放进 GitHub Secrets 由 Action 写入——它是**运行时**环境变量，直接在 Cloudflare Pages → Settings → Environment variables 里配 `ZUJUAN_COOKIE` 即可，改完重新部署一次生效。

## 使用说明

1. 打开部署后的站点
2. 粘贴形如 `https://zujuan.xkw.com/11p3514663.html` 的试卷详情页地址
3. 选格式：
   - **Word · 可编辑**：文字/表格可改，公式与插图转为图片（推荐）
   - **Word · 整题图片**：每题整体截图，版式 100% 还原、不可编辑
   - **PDF**：A4 分页，勾选「包含答案和解析」需要 Cookie 已登录
4. 点击生成，完成后可「本地下载」或「云端存档下载」；页面底部列出最近导出记录

## 说明与限制

- 所有解析逻辑跑在浏览器里（隐藏 iframe 渲染取回的 HTML 后复用原脚本逻辑），Worker 只做 HTTP 代理与存储，因此 CPU 不受 Workers 限制
- 依赖 CDN：`html2canvas@1.4.1`、`jspdf@2.5.1`（jsDelivr）
- 单文件上限 45MB；R2 保存的导出文件建议在 R2 设置生命周期规则定期清理
- 未配置 Cookie 时公开试卷仍可导出，但拿不到答案解析图
