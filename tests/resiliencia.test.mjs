// O servidor tem que sobreviver a clientes se comportando mal.
import net from 'node:net';
import crypto from 'node:crypto';

const BASE = process.env.BASE || 'http://localhost:3000';
const PORT = Number(new URL(BASE).port || 80);
const HOST = new URL(BASE).hostname;

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'  PASS ':'  FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};
const vivo = async () => { try { const r = await fetch(BASE+'/api/health'); return (await r.json()).ok===true; } catch { return false; } };
const espera = (ms)=>new Promise(r=>setTimeout(r,ms));

ok('servidor no ar antes do teste', await vivo());

// 1) Conexão WebSocket cortada no meio (ECONNRESET) — foi isso que derrubava o servidor.
{
  const key = crypto.randomBytes(16).toString('base64');
  const s = net.connect(PORT, HOST);
  await new Promise((r)=>s.on('connect',r));
  s.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await espera(250);
  s.resetAndDestroy();          // RST puro, sem close handshake
  await espera(400);
  ok('sobrevive a WebSocket cortado com RST', await vivo());
}

// 2) Lixo binário no lugar de frames válidos
{
  const key = crypto.randomBytes(16).toString('base64');
  const s = net.connect(PORT, HOST);
  await new Promise((r)=>s.on('connect',r));
  s.on('error',()=>{});
  s.write(`GET /ws HTTP/1.1\r\nHost: ${HOST}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await espera(200);
  s.write(crypto.randomBytes(600));
  await espera(400);
  s.destroy();
  await espera(300);
  ok('sobrevive a lixo binário no socket', await vivo());
}

// 3) Handshake inválido
{
  const s = net.connect(PORT, HOST);
  await new Promise((r)=>s.on('connect',r));
  s.on('error',()=>{});
  s.write('GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'); // sem key nem version
  await espera(300);
  s.destroy();
  ok('recusa handshake sem chave sem cair', await vivo());
}

// 4) JSON inválido numa conexão legítima
{
  const ws = new WebSocket(BASE.replace(/^http/,'ws')+'/ws');
  await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
  ws.send('nao sou json {{{');
  ws.send(JSON.stringify({ op: 'op-que-nao-existe' }));
  ws.send(JSON.stringify({ op: 'subscribe', topics: null }));
  ws.send(JSON.stringify({ op: 'aim', gameId: 'gm_inexistente', palheta: {} }));
  await espera(400);
  ok('sobrevive a mensagens malformadas', await vivo());
  ws.close();
}

// 5) Corpo enorme no REST
{
  const r = await fetch(BASE+'/api/auth/register', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ name:'x'.repeat(400000), password:'y' }),
  }).catch(()=>({status:0}));
  ok('rejeita corpo gigante sem cair', r.status===413||r.status===400, 'status '+r.status);
  ok('servidor segue vivo no fim', await vivo());
}

console.log(fails===0?'\nTUDO OK\n':`\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
