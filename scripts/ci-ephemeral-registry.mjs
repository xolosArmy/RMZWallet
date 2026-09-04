/**
 * TEMPORARY PRE-PUBLISH CI INFRASTRUCTURE:
 * This ephemeral registry proxy is strictly for pre-publication validation of PR2
 * before @xolosarmy/tonalli-memo-protocol@0.2.0 is published on npmjs.com.
 *
 * DO NOT MERGE TO MAIN:
 * Once PR1 of tonalli-memo is published to npmjs.com, this script and its workflow
 * reference will be deleted, allowing RMZWallet to run standard unproxied `npm ci`.
 */
import http from 'node:http';
import fs from 'node:fs';
import https from 'node:https';

const tarballPath = process.argv[2];
if (!tarballPath || !fs.existsSync(tarballPath)) {
  console.error(`Usage: node scripts/ci-ephemeral-registry.mjs <path-to-protocol-tarball>`);
  process.exit(1);
}

const PORT = parseInt(process.env.EPHEMERAL_REGISTRY_PORT || '4873', 10);

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url || '');

  if (url === '/@xolosarmy/tonalli-memo-protocol') {
    const metadata = {
      name: '@xolosarmy/tonalli-memo-protocol',
      'dist-tags': { latest: '0.2.0' },
      versions: {
        '0.2.0': {
          name: '@xolosarmy/tonalli-memo-protocol',
          version: '0.2.0',
          dist: {
            tarball: `http://127.0.0.1:${PORT}/@xolosarmy/tonalli-memo-protocol/-/tonalli-memo-protocol-0.2.0.tgz`,
            shasum: '312a1769ecfe0c61a7a1192f08c71c9623f8e674',
            integrity: 'sha512-dTY95QEpDXFmIPV0lGdXVrx5f7UfmEovpOddNAzvtRn8N4msXI3kuCfMI4gIkfx5E7MXiYAej1+0KkHbvXwx4w=='
          }
        }
      }
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metadata));
    return;
  }

  if (url.includes('/tonalli-memo-protocol-0.2.0.tgz')) {
    const stream = fs.createReadStream(tarballPath);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    stream.pipe(res);
    return;
  }

  // Fast-bypass / mock quick security audit endpoint to prevent hanging CI
  if (url.startsWith('/-/npm/v1/security/audits/quick')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ actions: [], advisories: {}, muted: [] }));
    return;
  }

  // Proxy all standard packages to upstream npmjs.org
  const upstreamReq = https.request(`https://registry.npmjs.org${req.url}`, {
    method: req.method,
    headers: { ...req.headers, host: 'registry.npmjs.org' }
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 500, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    res.writeHead(502);
    res.end(err.message);
  });

  req.pipe(upstreamReq);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ci-ephemeral-registry] Running on http://127.0.0.1:${PORT}`);
});
