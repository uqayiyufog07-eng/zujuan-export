// GET /api/paper?url=<试卷详情页地址>
// 三通道抓取（按序回退）：
//   1) Cloudflare Workers 直连（对未被 WAF 封禁的站点有效）
//   2) SOCKS5/HTTP 代理出口（PROXY_URL，参考 edgetunnel 反代 IP 方案：
//      connect() 原始 TCP + SOCKS5 握手 + startTls，出口 IP 换成代理 IP）
//   3) 通用 HTTP 反代（REVERSE_PROXY_URL，nginx/VPS 反代、第三方中转站）
//   4) 本地抓取器（FETCHER_URL + FETCH_KEY，经 Cloudflare Tunnel 暴露你电脑的出口）
// 背景：zujuan.xkw.com 的阿里云 WAF 会 405 封禁 Cloudflare/Azure 等机房 IP，
//       只有住宅/代理出口能访问；图片域名 staticzujuan.xkw.com 则可被 CF 直连。
//
// ⚠️ CPU 纪律（2026-10-18，两次 502 HTML 事故的教训）：
// Workers 免费版每个请求只有 10ms CPU。以下操作在 200KB 试卷页上会超标被杀，
// Cloudflare 边缘返回 502 text/html 错误页（前端表现为"服务响应格式异常"）：
//   ✗ 整页全局正则 /<script[\s\S]*?<\/script>/gi（已删）
//   ✗ await res.text() 解码 + JSON.stringify 序列化 + UTF-8 编码回传（已改为流式透传）
// 因此本 Function 对 HTML 响应一律 new Response(body) 流式透传，零文本处理；
// title 提取也移到前端（浏览器无 CPU 限制）。前端 sandbox iframe 无 allow-scripts，
// script 本就不会执行，无需在服务端删除。
import { fetchViaProxy } from './_lib/egress.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function onRequestGet(context) {
  try {
    return await handle(context);
  } catch (e) {
    // 兜底：任何未捕获异常都以 JSON 返回，避免 Cloudflare 502 HTML 错误页
    return json({ error: `抓取服务内部错误：${e?.message || e}` }, 500);
  }
}

// HTML 透传响应：元数据放 header，前端以 x-paper-via 识别"这是抓取结果"
function passThrough(body, base, via) {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'X-Paper-Base': encodeURIComponent(base),
      'X-Paper-Via': via,
      'Cache-Control': 'no-store',
    },
  });
}

async function handle({ request, env }) {
  const target = new URL(request.url).searchParams.get('url') || '';
  let page;
  try {
    page = new URL(target);
    if (!/^https?:$/.test(page.protocol)) throw new Error('bad protocol');
  } catch {
    return json({ error: '无效的网址，请输入完整的 http(s) 试卷详情页地址。' }, 400);
  }

  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': page.origin + '/',
  };
  if (env.ZUJUAN_COOKIE) headers['Cookie'] = env.ZUJUAN_COOKIE;

  const errors = [];

  // ---- 通道 1：Workers 直连（流式透传，零 CPU）----
  try {
    const res = await fetch(page.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (res.ok) return passThrough(res.body, page.href, 'direct');
    errors.push(`直连返回 ${res.status}`);
  } catch (e) {
    errors.push(`直连失败（${e.name === 'TimeoutError' ? '超时' : e.message}）`);
  }

  // ---- 通道 2：SOCKS5 / HTTP 代理出口（edgetunnel 式反代 IP）----
  if (env.PROXY_URL) {
    try {
      const r = await fetchViaProxy(page.href, env.PROXY_URL, env.ZUJUAN_COOKIE ? { Cookie: env.ZUJUAN_COOKIE } : {});
      if (r.status >= 200 && r.status < 300) return passThrough(r.bytes, page.href, 'proxy');
      errors.push(`代理出口返回 ${r.status}`);
    } catch (e) {
      errors.push(`代理出口失败（${e.message || e}）`);
    }
  }

  // ---- 通道 3：通用 HTTP 反代（REVERSE_PROXY_URL，nginx/VPS 反代、第三方中转站）----
  // 支持 {url}（原样）/ {urlenc}（编码）占位符；不含占位符时按 ?url=<编码> 拼接
  if (env.REVERSE_PROXY_URL) {
    try {
      const base = env.REVERSE_PROXY_URL.trim();
      const rpUrl = base.includes('{url}')
        ? base.replace(/\{urlenc\}/g, encodeURIComponent(page.href)).replace(/\{url\}/g, page.href)
        : base.replace(/\/$/, '') + '?url=' + encodeURIComponent(page.href);
      const res = await fetch(rpUrl, {
        headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(25000),
      });
      if (res.ok) return passThrough(res.body, page.href, 'reverse-proxy');
      errors.push(`HTTP 反代返回 ${res.status}`);
    } catch (e) {
      errors.push(`HTTP 反代失败（${e.name === 'TimeoutError' ? '超时' : e.message}）`);
    }
  }

  // ---- 通道 4：本地抓取器（Cloudflare Tunnel）----
  if (env.FETCHER_URL) {
    try {
      const fHeaders = { 'User-Agent': UA };
      if (env.FETCH_KEY) fHeaders['x-fetch-key'] = env.FETCH_KEY;
      const res = await fetch(`${env.FETCHER_URL.replace(/\/$/, '')}/fetch?url=${encodeURIComponent(page.href)}`, {
        headers: fHeaders,
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) return passThrough(res.body, page.href, 'fetcher');
      errors.push(`本地抓取器返回 ${res.status}`);
    } catch (e) {
      errors.push(`本地抓取器不可达（${e.name === 'TimeoutError' ? '超时' : e.message}）`);
    }
  }

  return json({
    error: `${errors.join('；')}。组卷网主站封禁 Cloudflare 机房 IP，请配置 PROXY_URL（SOCKS5/HTTP 代理或 edgetunnel 反代 IP，格式 tcp://host:port）、REVERSE_PROXY_URL（通用 HTTP 反代）或 FETCHER_URL（本机抓取器），详见 README「机房 IP 被封」一节。`,
  }, 502);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
