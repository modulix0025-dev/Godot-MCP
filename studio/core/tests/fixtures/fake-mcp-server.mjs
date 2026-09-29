// SPDX-License-Identifier: Apache-2.0
// Minimal stand-in for gamedev-mcp-server in unit tests: parses the real token-mode arguments, serves /help,
// requires the bearer on /api/system-tools/ping, and exits on POST /crash (to exercise restart supervision).
import { createServer } from 'node:http';
const arg = (k) => process.argv.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1);
const port = Number(arg('port'));
const token = arg('token');
if (arg('auth') !== 'token' || !token || arg('client-transport') !== 'streamableHttp') process.exit(2);
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/help') return res.writeHead(200).end('help');
    if (req.url === '/crash') return process.exit(3);
    if (req.url === '/api/system-tools/ping') {
      if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
      const msg = JSON.parse(body || '{}').message ?? 'pong';
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ status: 'success', structured: { result: msg } }));
    }
    res.writeHead(404).end();
  });
}).listen(port, '127.0.0.1');
