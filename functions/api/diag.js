// GET /api/diag?url=<目标>&proxy=<可选，覆盖 env.PROXY_URL>
// 诊断出口通道：直连 / SOCKS5 代理 两条通道分别尝试，返回各自结果，便于排查 WAF 封禁。
import { fetchViaProxy, parseProxy } from './_lib/egress.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url);
  const target = u.searchParams.get('url');
  if (!target) return json({ error: '缺少 url 参数' }, 400);

  const out = { target, channels: {} };

  // 通道 A：Workers 直连
  try {
    const res = await fetch(target, {
      headers: { 'User-Agent': UA, 'Referer': new URL(target).origin + '/' },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    out.channels.direct = { status: res.status, length: text.length, title: (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '' };
  } catch (e) {
    out.channels.direct = { error: String(e.message || e) };
  }

  // 通道 B：SOCKS5 / HTTP 代理出口
  const proxyUrl = u.searchParams.get('proxy') || env.PROXY_URL;
  if (proxyUrl) {
    try {
      const r = await fetchViaProxy(target, proxyUrl, env.ZUJUAN_COOKIE ? { Cookie: env.ZUJUAN_COOKIE } : {});
      const text = new TextDecoder().decode(r.bytes);
      out.channels.proxy = {
        proxy: proxyUrl.replace(/\/\/[^@]*@/, '//***@'),
        status: r.status,
        length: r.bytes.length,
        title: (text.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '',
        head: text.slice(0, 120),
      };
    } catch (e) {
      out.channels.proxy = { proxy: proxyUrl.replace(/\/\/[^@]*@/, '//***@'), error: String(e.message || e) };
    }
  } else {
    out.channels.proxy = { skipped: '未配置 PROXY_URL' };
  }

  return json(out);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
