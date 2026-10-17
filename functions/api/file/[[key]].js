// GET /api/file/<key...>  从 R2 下载已保存的文件
export async function onRequestGet({ env, params }) {
  if (!env.BUCKET) return new Response('R2 未绑定', { status: 500 });
  const key = (params.key || []).join('/');
  if (!key) return new Response('missing key', { status: 400 });

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('文件不存在或已过期。', { status: 404 });

  const filename = key.split('/').pop() || 'export';
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
