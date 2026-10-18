// GET /api/paper?url=<试卷详情页地址>
// 三通道抓取（按序回退）：
//   1) Cloudflare Workers 直连（对未被 WAF 封禁的站点有效）
//   2) SOCKS5/HTTP 代理出口（PROXY_URL，参考 edgetunnel 反代 IP 方案：
//      connect() 原始 TCP + SOCKS5 握手 + startTls，出口 IP 换成代理 IP）
//   3) 本地抓取器（FETCHER_URL + FETCH_KEY，经 Cloudflare Tunnel 暴露你电脑的出口）
// 背景：zujuan.xkw.com 的阿里云 WAF 会 405 封禁 Cloudflare/Azure 等机房 IP，
//       只有住宅/代理出口能访问；图片域名 staticzujuan.xkw.com 则可被 CF 直连。
import { fetchViaProxy } from './_lib/egress.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function onRequestGet({ request, env }) {
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

  // ---- 通道 1：Workers 直连 ----
  try {
    const res = await fetch(page.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      let html = await res.text();
      html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
      const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
      return json({ html, title, base: page.href, via: 'direct' });
    }
    errors.push(`直连返回 ${res.status}`);
  } catch (e) {
    errors.push(`直连失败（${e.name === 'TimeoutError' ? '超时' : e.message}）`);
  }

  // ---- 通道 2：SOCKS5 / HTTP 代理出口（edgetunnel 式反代 IP）----
  if (env.PROXY_URL) {
    try {
      const r = await fetchViaProxy(page.href, env.PROXY_URL, env.ZUJUAN_COOKIE ? { Cookie: env.ZUJUAN_COOKIE } : {});
      if (r.status >= 200 && r.status < 300) {
        let html = new TextDecoder().decode(r.bytes);
        html = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
        return json({ html, title, base: page.href, via: 'proxy' });
      }
      errors.push(`代理出口返回 ${r.status}`);
    } catch (e) {
      errors.push(`代理出口失败（${e.message || e}）`);
    }
  }

  // ---- 通道 3：本地抓取器（Cloudflare Tunnel）----
  if (env.FETCHER_URL) {
    try {
      const fHeaders = { 'User-Agent': UA };
      if (env.FETCH_KEY) fHeaders['x-fetch-key'] = env.FETCH_KEY;
      const res = await fetch(`${env.FETCHER_URL.replace(/\/$/, '')}/fetch?url=${encodeURIComponent(page.href)}`, {
        headers: fHeaders,
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const html = await res.text();
        const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();
        return json({ html, title, base: page.href, via: 'fetcher' });
      }
      errors.push(`本地抓取器返回 ${res.status}`);
    } catch (e) {
      errors.push(`本地抓取器不可达（${e.name === 'TimeoutError' ? '超时' : e.message}）`);
    }
  }

  return json({
    error: `${errors.join('；')}。组卷网主站封禁 Cloudflare 机房 IP，请配置 PROXY_URL（SOCKS5 代理）或保持本机抓取器 + Cloudflare Tunnel 运行，详见 README「机房 IP 被封」一节。`,
  }, 502);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
