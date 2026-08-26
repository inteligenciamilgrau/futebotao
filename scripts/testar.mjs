// Roda a suíte inteira num servidor SÓ DELA.
//
// Os testes de API precisam de um servidor no ar, e por muito tempo isso quis
// dizer "aponte para o seu servidor". O preço aparecia depois: cada rodada
// deixava dezenas de jogadores de teste em data/players.json e enchia o lobby
// de partidas chamadas "Convite a1b2". Aqui o servidor de teste sobe numa
// porta própria, com um DATA_DIR descartável, e morre no fim. O seu servidor e
// os seus dados não são tocados.
//
//   node scripts/testar.mjs            roda tudo
//   node scripts/testar.mjs regras     roda só os que casam com "regras"

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORTA = Number(process.env.PORT_TESTE || 3199);
const BASE = `http://localhost:${PORTA}`;
const filtro = process.argv[2] || '';

const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'futebotao-teste-'));

const arquivos = fs.readdirSync(path.join(raiz, 'tests'))
  .filter((f) => f.endsWith('.test.mjs'))
  .filter((f) => !filtro || f.includes(filtro))
  .sort();

if (!arquivos.length) {
  console.error(`nenhum teste casa com "${filtro}"`);
  process.exit(1);
}

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

/** Sobe o servidor de teste e espera ele responder. */
async function subirServidor() {
  const proc = spawn(process.execPath, ['server/index.js'], {
    cwd: raiz,
    env: { ...process.env, PORT: String(PORTA), DATA_DIR: dados, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\no servidor de teste caiu (código ${code}):\n${log}`);
    }
  });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/rules`);
      if (r.ok) return proc;
    } catch { /* ainda subindo */ }
    await dorme(150);
  }
  proc.kill();
  throw new Error(`o servidor de teste não respondeu em ${BASE}\n${log}`);
}

/** Roda um arquivo de teste e devolve se passou. */
function rodar(arquivo) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join('tests', arquivo)], {
      cwd: raiz,
      env: { ...process.env, BASE },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let saida = '';
    proc.stdout.on('data', (d) => { saida += d; });
    proc.stderr.on('data', (d) => { saida += d; });
    proc.on('close', (code) => resolve({ arquivo, ok: code === 0, saida }));
  });
}

const servidor = await subirServidor();
console.log(`servidor de teste em ${BASE}  ·  dados em ${dados}\n`);

let falhas = 0;
for (const arquivo of arquivos) {
  const nome = arquivo.replace('.test.mjs', '');
  process.stdout.write(nome.padEnd(16));
  const r = await rodar(arquivo);
  if (r.ok) {
    console.log('OK');
  } else {
    falhas++;
    console.log('FALHOU');
    // Só as linhas que interessam: as que falharam e o resumo.
    const linhas = r.saida.split('\n').filter((l) => /FAIL|FALHA|Error|error:/i.test(l));
    for (const l of linhas.slice(0, 12)) console.log('   ' + l.trim());
  }
}

servidor.kill();
await dorme(200);
fs.rmSync(dados, { recursive: true, force: true });

console.log(falhas === 0
  ? `\n${arquivos.length} arquivos, tudo passando.`
  : `\n${falhas} de ${arquivos.length} arquivos falharam.`);
process.exit(falhas ? 1 : 0);
