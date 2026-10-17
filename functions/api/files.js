// POST /api/files  上传生成好的文件 → 存 R2，元数据索引写 KV
//   headers: x-filename, x-format (pdf|docx), x-source-url
// GET  /api/files  从 KV 读取最近导出记录列表
const INDEX_KEY = 'export:index';
const MAX_KEEP = 100;

export async function onRequestPost({ request, env }) {
  if (!env.BUCKET || !env.EXPORT_INDEX) {
    return json({ error: '服务端未绑定 R2 / KV，请检查 wrangler.toml 配置。' }, 500);
  }
  const filename = request.headers.get('x-filename') || 'export.bin';
  const format = request.headers.get('x-format') || 'bin';
  const sourceUrl = request.headers.get('x-source-url') || '';
  const body = await request.arrayBuffer();
  if (!body.byteLength) return json({ error: '空文件。' }, 400);
  if (body.byteLength > 45 * 1024 * 1024) return json({ error: '文件超过 45MB 限制。' }, 413);

  const now = new Date();
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  let domain = 'unknown';
  try { domain = new URL(sourceUrl).hostname; } catch {}
  const key = `exports/${day}/${domain}/${Date.now()}-${filename.replace(/[^\w.一-龥-]+/g, '_')}`;

  await env.BUCKET.put(key, body, {
    httpMetadata: { contentType: format === 'pdf' ? 'application/pdf'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  });

  const record = { key, filename, format, size: body.byteLength, sourceUrl, createdAt: now.toISOString() };
  let index = [];
  try { index = (await env.EXPORT_INDEX.get(INDEX_KEY, 'json')) || []; } catch {}
  index.unshift(record);
  if (index.length > MAX_KEEP) index.length = MAX_KEEP;
  await env.EXPORT_INDEX.put(INDEX_KEY, JSON.stringify(index));

  return json({ ok: true, key, url: '/api/file/' + key.split('/').map(encodeURIComponent).join('/') });
}

export async function onRequestGet({ env }) {
  let index = [];
  try { index = (await env.EXPORT_INDEX?.get(INDEX_KEY, 'json')) || []; } catch {}
  return json({ files: index });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
