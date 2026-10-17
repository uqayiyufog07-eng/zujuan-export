// GET /api/img?url=<图片绝对地址>
// 图片代理：组卷网的公式/插图有防盗链与跨域限制，统一经此代理转为同源，
// 前端再把图片内联为 dataURL，供 html2canvas / docx 打包使用。
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

  let res;
  try {
    res = await fetch(img.href, { headers, signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return new Response('fetch failed: ' + e.message, { status: 502 });
  }
  if (!res.ok) return new Response('upstream ' + res.status, { status: 502 });

  const type = res.headers.get('Content-Type') || 'image/png';
  return new Response(res.body, {
    headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' },
  });
}
