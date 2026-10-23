// Website Audit FTP login tests (no database, no outside network: a fake FTP server on localhost): `npm test`.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://x:x@localhost:1/x';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const express = require('express');

const auditRouter = require('../routes/websiteAudit');

// Answers like the cPanel FTP server: 530 unless USER/PASS match exactly.
function fakeFtp(user, pass) {
  const logins = [];
  const server = net.createServer((sock) => {
    let u = null;
    sock.write('220 fake ftp ready\r\n');
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const sp = line.indexOf(' ');
        const cmd = (sp < 0 ? line : line.slice(0, sp)).toUpperCase();
        const arg = sp < 0 ? '' : line.slice(sp + 1);
        if (cmd === 'USER') { u = arg; sock.write('331 Password required\r\n'); }
        else if (cmd === 'PASS') {
          logins.push({ user: u, pass: arg });
          sock.write(u === user && arg === pass ? '230 Logged in\r\n' : '530 Login authentication failed\r\n');
        } else if (cmd === 'QUIT') { sock.end('221 Bye\r\n'); }
        else sock.write('200 OK\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, logins })));
}

function app() {
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.user = { userId: 'test-user' }; next(); });
  a.use('/api/audit', auditRouter);
  return new Promise((resolve) => { const s = a.listen(0, '127.0.0.1', () => resolve(s)); });
}

async function ftpTest(body) {
  const s = await app();
  try {
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/audit/ftp-test`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return await r.json();
  } finally { s.close(); }
}

test('ftp-test: a login pasted with trailing whitespace connects, like _blog-ftp.env does on the PC', async () => {
  const ftp = await fakeFtp('so2wm0yi', 'Corr3ct!pass');
  try {
    const out = await ftpTest({ host: ' 127.0.0.1 ', user: 'so2wm0yi\t', password: 'Corr3ct!pass \n', port: ftp.port });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(ftp.logins.at(-1), { user: 'so2wm0yi', pass: 'Corr3ct!pass' });
  } finally { ftp.server.close(); }
});

test('ftp-test: a wrong password still reports the 530', async () => {
  const ftp = await fakeFtp('so2wm0yi', 'Corr3ct!pass');
  try {
    const out = await ftpTest({ host: '127.0.0.1', user: 'so2wm0yi', password: 'wrong', port: ftp.port });
    assert.equal(out.ok, false);
    assert.match(out.message, /530/);
  } finally { ftp.server.close(); }
});

test('ftp-test: a blank password after trimming is refused before connecting', async () => {
  const out = await ftpTest({ host: '127.0.0.1', user: 'so2wm0yi', password: '  \n' });
  assert.equal(out.error, 'host, user, and password are required');
});
