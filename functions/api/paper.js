// GET /api/paper?url=<试卷详情页地址>
// 服务端代取试卷 HTML：携带环境变量 ZUJUAN_COOKIE 解决登录态/反爬，
// 剔除 <script> 后返回给前端，由前端在隐藏 iframe 中渲染并复用解析逻辑。
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

  let res;
  try {
    res = await fetch(page.href, { headers, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  } catch (e) {
    return json({ error: '抓取超时或网络失败：' + (e.name === 'TimeoutError' ? '目标站点 20 秒未响应' : e.message) }, 502);
  }
  if (!res.ok) return json({ error: `目标站点返回 ${res.status}，可能是反爬拦截或需要登录。` }, 502);

  let html = await res.text();
  // 移除脚本与防调试代码，保留样式与正文结构
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
             .replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].trim();

  return json({ html, title, base: page.href });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
