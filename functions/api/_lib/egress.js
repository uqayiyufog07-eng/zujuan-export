// 出口通道库：Worker 经 SOCKS5 / HTTP-CONNECT 代理抓取目标页面
// 参考 edgetunnel（_worker.js 的 socks5Connect/httpConnect）实现：
//   Workers 原生 fetch() 无法指定出口 IP（固定走 Cloudflare 机房 IP，会被
//   zujuan 的阿里云 WAF 405 封禁）；改用 cloudflare:sockets 的 connect() 开
//   原始 TCP，手写 SOCKS5 握手 → startTls 升级 → HTTP/1.1 请求，
//   出口 IP 即代理服务器 IP，可绕开封禁。
//
// 支持代理格式（Pages 环境变量 PROXY_URL）：
//   socks5://host:port
//   socks5://user:pass@host:port
//   http://host:port            （HTTP CONNECT，明文代理）
//   https://user:pass@host:port （HTTPS 代理，TLS 直连）

import { connect } from 'cloudflare:sockets';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function parseProxy(proxyUrl) {
  const u = new URL(proxyUrl);
  const scheme = u.protocol.replace(':', '');
  if (!['socks5', 'socks5h', 'http', 'https'].includes(scheme)) throw new Error('不支持的代理协议（仅 socks5/http/https）');
  return {
    scheme: scheme.startsWith('socks5') ? 'socks5' : scheme,
    hostname: u.hostname,
    port: Number(u.port) || (scheme === 'https' ? 443 : 1080),
    username: decodeURIComponent(u.username || ''),
    password: decodeURIComponent(u.password || ''),
  };
}

class BufReader {
  constructor(reader) { this.reader = reader; this.buf = new Uint8Array(0); }
  async fill() {
    const { done, value } = await this.reader.read();
    if (done) throw new Error('代理连接被提前关闭');
    const next = new Uint8Array(this.buf.length + value.length);
    next.set(this.buf); next.set(value, this.buf.length);
    this.buf = next;
  }
  async read(n) {
    while (this.buf.length < n) await this.fill();
    const out = this.buf.subarray(0, n);
    this.buf = this.buf.subarray(n);
    return out;
  }
  async readUntilCRLFCRLF(max = 65536) {
    while (true) {
      const idx = indexOfCRLFCRLF(this.buf);
      if (idx !== -1) return { head: this.buf.subarray(0, idx), rest: this.buf.subarray(idx + 4) };
      if (this.buf.length > max) throw new Error('代理响应头过长');
      await this.fill();
    }
  }
  get rest() { return this.buf; }
}

function indexOfCRLFCRLF(b) {
  for (let i = 0; i < b.length - 3; i++) {
    if (b[i] === 0x0d && b[i + 1] === 0x0a && b[i + 2] === 0x0d && b[i + 3] === 0x0a) return i;
  }
  return -1;
}

async function socks5Handshake(socket, proxy, targetHost, targetPort) {
  const writer = socket.writable.getWriter();
  const br = new BufReader(socket.readable.getReader());
  const enc = new TextEncoder();

  const greet = proxy.username && proxy.password
    ? new Uint8Array([0x05, 0x02, 0x00, 0x02])
    : new Uint8Array([0x05, 0x01, 0x00]);
  await writer.write(greet);
  const sel = await br.read(2);
  if (sel[0] !== 0x05) throw new Error('SOCKS5 响应非法');
  if (sel[1] === 0x02) {
    const u = enc.encode(proxy.username), p = enc.encode(proxy.password);
    await writer.write(new Uint8Array([0x01, u.length, ...u, p.length, ...p]));
    const auth = await br.read(2);
    if (auth[1] !== 0x00) throw new Error('SOCKS5 认证失败');
  } else if (sel[1] !== 0x00) {
    throw new Error(`SOCKS5 不支持的认证方式 ${sel[1]}`);
  }

  const hb = enc.encode(targetHost);
  await writer.write(new Uint8Array([0x05, 0x01, 0x00, 0x03, hb.length, ...hb, targetPort >> 8, targetPort & 0xff]));
  const resp = await br.read(4);
  if (resp[1] !== 0x00) throw new Error(`SOCKS5 连接目标失败（code ${resp[1]}）`);
  // 读取绑定地址（ATYP + addr + port），避免残留字节污染 TLS 流
  const atyp = (await br.read(1))[0];
  let addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? (await br.read(1))[0] : 0;
  if (addrLen) await br.read(addrLen + 2);
  writer.releaseLock();
  // 把可能多读到的字节回灌（SOCKS5 响应通常没有多余数据，稳妥起见丢弃）
  return socket;
}

async function httpConnectHandshake(socket, proxy, targetHost, targetPort) {
  const writer = socket.writable.getWriter();
  const br = new BufReader(socket.readable.getReader());
  const auth = proxy.username && proxy.password
    ? `Proxy-Authorization: Basic ${btoa(`${proxy.username}:${proxy.password}`)}\r\n` : '';
  await writer.write(new TextEncoder().encode(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}User-Agent: ${UA}\r\nConnection: keep-alive\r\n\r\n`
  ));
  writer.releaseLock();
  const { head } = await br.readUntilCRLFCRLF();
  const status = new TextDecoder().decode(head).split('\r\n')[0].match(/HTTP\/\d\.\d\s+(\d+)/);
  if (!status || Number(status[1]) < 200 || Number(status[1]) >= 300) {
    throw new Error(`HTTP 代理 CONNECT 失败：${new TextDecoder().decode(head).split('\r\n')[0]}`);
  }
  return socket;
}

/** 经代理以 HTTP/1.1 抓取页面，返回 { status, headers, text } */
export async function fetchViaProxy(targetUrl, proxyUrl, extraHeaders = {}) {
  const proxy = parseProxy(proxyUrl);
  const target = new URL(targetUrl);
  const targetPort = target.port ? Number(target.port) : 443;

  const socketOpts = { allowHalfOpen: false };
  if (proxy.scheme === 'https') socketOpts.secureTransport = 'on';       // 代理本身是 TLS
  else if (proxy.scheme === 'socks5') socketOpts.secureTransport = 'starttls'; // 先明文 SOCKS5，再升级 TLS
  else socketOpts.secureTransport = 'off';                                // 明文 HTTP 代理

  const socket = connect({ hostname: proxy.hostname, port: proxy.port }, socketOpts);
  await socket.opened;

  if (proxy.scheme === 'socks5') await socks5Handshake(socket, proxy, target.hostname, targetPort);
  else await httpConnectHandshake(socket, proxy, target.hostname, targetPort);

  // 升级到 TLS（SNI 用目标域名）；明文 HTTP 代理且目标为 80 端口时跳过
  if (socketOpts.secureTransport === 'starttls') {
    await socket.startTls({ servername: target.hostname });
  }

  const headers = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': target.origin + '/',
    'Connection': 'close',
    ...extraHeaders,
  };
  const reqLines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const writer = socket.writable.getWriter();
  await writer.write(new TextEncoder().encode(
    `GET ${target.pathname}${target.search} HTTP/1.1\r\nHost: ${target.host}\r\n${reqLines}\r\n\r\n`
  ));
  writer.releaseLock();

  // 读取响应头
  const br = new BufReader(socket.readable.getReader());
  const { head, rest } = await br.readUntilCRLFCRLF();
  const headText = new TextDecoder().decode(head);
  const statusLine = headText.split('\r\n')[0];
  const status = Number((statusLine.match(/HTTP\/\d\.\d\s+(\d+)/) || [])[1] || 0);
  const respHeaders = {};
  for (const line of headText.split('\r\n').slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) respHeaders[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }

  // 按 Content-Length / chunked / close-delimited 读取正文
  let bodyBuf = new Uint8Array(rest);
  const te = (respHeaders['transfer-encoding'] || '').toLowerCase();
  if (te.includes('chunked')) {
    let chunks = [];
    let buf = bodyBuf;
    const dec = new TextDecoder();
    while (true) {
      let lineEnd = indexOfCRLF(buf);
      while (lineEnd === -1) { const c = await readMore(br); buf = concat(buf, c); lineEnd = indexOfCRLF(buf); }
      const size = parseInt(dec.decode(buf.subarray(0, lineEnd)), 16);
      buf = buf.subarray(lineEnd + 2);
      if (!size) break;
      while (buf.length < size + 2) buf = concat(buf, await readMore(br));
      chunks.push(buf.subarray(0, size));
      buf = buf.subarray(size + 2);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    bodyBuf = new Uint8Array(total);
    let off = 0; for (const c of chunks) { bodyBuf.set(c, off); off += c.length; }
  } else if (respHeaders['content-length']) {
    const len = Number(respHeaders['content-length']);
    while (bodyBuf.length < len) bodyBuf = concat(bodyBuf, await readMore(br));
    bodyBuf = bodyBuf.subarray(0, len);
  } else {
    while (true) { try { bodyBuf = concat(bodyBuf, await readMore(br)); } catch { break; } }
  }

  try { socket.close(); } catch {}
  return { status, headers: respHeaders, bytes: bodyBuf };
}

function indexOfCRLF(b) {
  for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x0d && b[i + 1] === 0x0a) return i;
  return -1;
}
function concat(a, b) { const n = new Uint8Array(a.length + b.length); n.set(a); n.set(b, a.length); return n; }
async function readMore(br) { await br.fill(); const out = br.rest; br.buf = new Uint8Array(0); return out; }
