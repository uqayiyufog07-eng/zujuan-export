// GET /api/img?url=<图片绝对地址>
// 图片代理：组卷网的公式/插图有防盗链与跨域限制，统一经此代理转为同源，
// 前端再把图片内联为 dataURL，供 html2canvas / docx 打包使用。
// 注：图片域名 staticzujuan.xkw.com 实测可被 Cloudflare 直连；
//     若个别图片被 WAF 拦截，自动回退到本地抓取器通道。
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export async function onRequestGet({ request, env }) {
  const raw = new URL(request.url).searchParams.get('url') || '';
  let img;
  try {
    img = new URL(raw);
    if (!/^https?:$/.test(img.protocol)) throw 0;
  } catch {
    return new Response('invalid url', { status: 400 });
  }

  const headers = { 'User-Agent': UA, 'Referer': img.origin + '/', 'Accept': 'image/*,*/*;q=0.8' };
  if (env.ZUJUAN_COOKIE) headers['Cookie'] = env.ZUJUAN_COOKIE;

  // 通道 1：直连
  try {
    const res = await fetch(img.href, { headers, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      return new Response(res.body, {
        headers: {
          'Content-Type': res.headers.get('Content-Type') || 'image/png',
          'Cache-Control': 'public, max-age=86400',
        },
      });
    }
  } catch {}

  // 通道 2：本地抓取器
  if (env.FETCHER_URL) {
    try {
      const fHeaders = { 'User-Agent': UA };
      if (env.FETCH_KEY) fHeaders['x-fetch-key'] = env.FETCH_KEY;
      const res = await fetch(`${env.FETCHER_URL.replace(/\/$/, '')}/img?url=${encodeURIComponent(img.href)}`, {
        headers: fHeaders,
        signal: AbortSignal.timeout(20000),
      });
      if (res.ok) {
        return new Response(res.body, {
          headers: {
            'Content-Type': res.headers.get('Content-Type') || 'image/png',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      }
    } catch {}
  }

  return new Response('image fetch failed', { status: 502 });
}
