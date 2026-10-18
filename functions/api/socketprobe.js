// GET /api/socketprobe?host=&port=&tls=1&flow=socks5&target=host:port
// 分步复现 SOCKS5 全流程，逐步 try/catch，定位 workerd internal error 抛出的环节。
import { connect } from 'cloudflare:sockets';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36';

export async function onRequestGet({ request }) {
  const u = new URL(request.url);
  const host = u.searchParams.get('host') || 'zujuan.xkw.com';
  const port = Number(u.searchParams.get('port') || 443);
  const flow = u.searchParams.get('flow') || '';
  const target = u.searchParams.get('target') || 'zujuan.xkw.com:443';
  const [tHost, tPort = '443'] = target.split(':');
  const out = { host, port, flow, target, steps: [], errors: {} };
  const step = async (name, fn) => {
    try { const r = await fn(); out.steps.push(`${name}: ok`); return r; }
    catch (e) { out.steps.push(`${name}: FAIL`); out.errors[name] = String(e?.message || e).slice(0, 200); throw e; }
  };

  let socket;
  try {
    socket = connect({ hostname: host, port }, { secureTransport: 'starttls', allowHalfOpen: false });
    await socket.opened;
  } catch (e) {
    out.error = `connect 失败: ${String(e.message || e).slice(0, 200)}`;
    return json(out);
  }
  socket.closed.catch(() => {}); // 避免未处理拒绝

  try {
    if (flow === 'socks5') {
      // 1) SOCKS5 握手（无认证）
      await step('socks5-greet', async () => {
        const w = socket.writable.getWriter();
        await w.write(new Uint8Array([0x05, 0x01, 0x00]));
        w.releaseLock();
        const r = socket.readable.getReader();
        const { value } = await r.read();
        r.releaseLock();
        if (!value || value[0] !== 0x05) throw new Error('bad method resp');
      });
      await step('socks5-connect', async () => {
        const w = socket.writable.getWriter();
        const hb = new TextEncoder().encode(tHost);
        const p = Number(tPort);
        await w.write(new Uint8Array([0x05, 0x01, 0x00, 0x03, hb.length, ...hb, p >> 8, p & 0xff]));
        w.releaseLock();
        const r = socket.readable.getReader();
        const { value } = await r.read();
        r.releaseLock();
        if (!value || value[1] !== 0x00) throw new Error(`connect failed code=${value ? value[1] : 'null'}`);
      });
    }

    // 2) TLS 升级（sni 参数 → expectedServerHostname，可能同时影响 SNI 与证书校验）
    let io;
    const sni = u.searchParams.get('sni') || '';
    await step('startTls', () => { io = socket.startTls(sni ? { expectedServerHostname: sni } : undefined); });
    out.startTlsReturnedNew = io !== socket;
    io.closed.catch(() => {});

    // 3) 写请求
    await step('write-request', async () => {
      const w = io.writable.getWriter();
      await w.write(new TextEncoder().encode(
        `GET / HTTP/1.1\r\nHost: ${tHost}\r\nUser-Agent: ${UA}\r\nAccept: */*\r\nConnection: close\r\n\r\n`
      ));
      w.releaseLock();
    });

    // 4) 读响应
    await step('read-response', async () => {
      const r = io.readable.getReader();
      const { value } = await r.read();
      r.releaseLock();
      out.firstBytes = value ? new TextDecoder().decode(value.slice(0, 80)) : '(empty)';
      out.firstBytesLen = value ? value.length : 0;
    });
  } catch (e) {
    out.failedAt = out.steps[out.steps.length - 1];
  } finally {
    try { socket.close(); } catch {}
  }
  return json(out);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
