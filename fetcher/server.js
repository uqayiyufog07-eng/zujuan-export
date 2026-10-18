// 本地抓取器（零依赖 Node 脚本）
// 为什么需要它：zujuan.xkw.com 的阿里云 WAF 会 405 封禁 Cloudflare / Azure / GCP 等机房 IP，
// 但你家/代理出口可以正常访问。本服务跑在你电脑上，经 Cloudflare Tunnel 暴露，
// Pages Function 在直连被拒时自动改走这里。
//
// 用法：
//   1) 复制 .env.example 为 .env，填入组卷网 Cookie（与 Pages 上的 ZUJUAN_COOKIE 相同）
//   2) node server.js            （监听 127.0.0.1:8788）
//   3) 另开终端跑 cloudflared tunnel（见 README「隧道配置」一节）
//
// 安全：默认要求请求头 x-fetch-key 与 .env 中 FETCH_KEY 一致，防止被抓取器被公网滥用。

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// ---- 读取 .env（不引三方库） ----
function loadEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}
const env = loadEnv(join(here, '.env'));

const PORT = Number(env.PORT || 8788);
const HOST = env.HOST || '127.0.0.1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT = 20000;

function send(res, status, body, headers = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  res.writeHead(status, { 'Content-Length': buf.length, ...headers });
  res.end(buf);
}

async function upstream(url, isImage) {
  const headers = {
    'User-Agent': UA,
    'Accept': isImage ? 'image/*,*/*;q=0.8' : 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': new URL(url).origin + '/',
  };
  if (env.ZUJUAN_COOKIE) headers['Cookie'] = env.ZUJUAN_COOKIE;

  const res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT) });
  return res;
}

const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}:${PORT}`);

    // 健康检查
    if (u.pathname === '/ping') return send(res, 200, 'pong', { 'Content-Type': 'text/plain' });

    // 简易鉴权
    if (env.FETCH_KEY && req.headers['x-fetch-key'] !== env.FETCH_KEY) {
      return send(res, 401, 'invalid x-fetch-key', { 'Content-Type': 'text/plain' });
    }

    const isFetch = u.pathname === '/fetch';
    const isImg = u.pathname === '/img';
    if (!isFetch && !isImg) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });

    const target = u.searchParams.get('url') || '';
    let page;
    try {
      page = new URL(target);
      if (!/^https?:$/.test(page.protocol)) throw 0;
    } catch {
      return send(res, 400, 'invalid url', { 'Content-Type': 'text/plain' });
    }

    const up = await upstream(page.href, isImg);
    if (!up.ok) {
      return send(res, 502, `upstream ${up.status}`, { 'Content-Type': 'text/plain' });
    }

    if (isImg) {
      const type = up.headers.get('content-type') || 'image/png';
      const buf = Buffer.from(await up.arrayBuffer());
      return send(res, 200, buf, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
    }

    // /fetch：直接透传 HTML（不删 script——前端 sandbox iframe 无 allow-scripts，
    // script 不会执行；且大正则虽然 Node 无 CPU 限制，删掉保持一致、省内存）
    const html = await up.text();
    send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'X-Paper-Via': 'fetcher', 'Cache-Control': 'no-store' });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? 'upstream timeout' : String(e.message || e);
    send(res, 502, msg, { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[zujuan-fetcher] listening on http://${HOST}:${PORT}`);
  console.log(`[zujuan-fetcher] cookie: ${env.ZUJUAN_COOKIE ? '已加载' : '未配置（.env 缺少 ZUJUAN_COOKIE）'}`);
  console.log(`[zujuan-fetcher] fetch-key: ${env.FETCH_KEY ? '已启用' : '未设置（建议设置）'}`);
});
