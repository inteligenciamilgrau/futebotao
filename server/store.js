// Persistência simples em arquivo JSON. Jogadores sobrevivem ao restart;
// partidas ficam em memória (uma partida em andamento é efêmera por natureza).

import fs from 'node:fs';
import path from 'node:path';
import { SERVER } from './config.js';
import { newId, hashPassword, verifyPassword, safeEqual } from './util.js';

const dir = SERVER.dataDir;
const playersFile = path.join(dir, 'players.json');

fs.mkdirSync(dir, { recursive: true });

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

let players = load(playersFile, {});   // playerId -> { id, name, pass, createdAt, stats }
let saveTimer = null;

/**
 * O que vai para o disco. Jogadores EFÊMEROS ficam de fora: são as contas
 * que o servidor cria sozinho para os bots do botão "Jogar contra a IA".
 * Elas valem só enquanto a partida existe, e persisti-las enchia o arquivo
 * de "IA Vermelhos a1b2" para sempre.
 */
function paraODisco() {
  const saida = {};
  for (const [id, p] of Object.entries(players)) if (!p.efemero) saida[id] = p;
  return saida;
}

function savePlayers() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFileSync(playersFile, JSON.stringify(paraODisco(), null, 2));
  }, 200);
}

export function flush() {
  clearTimeout(saveTimer);
  fs.writeFileSync(playersFile, JSON.stringify(paraODisco(), null, 2));
}

/* ---------------- Jogadores ---------------- */

export function registerPlayer({ name, password, kind = 'human', model = null, efemero = false }) {
  if (!name || String(name).trim().length < 2) {
    const e = new Error('name precisa de ao menos 2 caracteres'); e.status = 400; throw e;
  }
  if (!password || String(password).length < 4) {
    const e = new Error('password precisa de ao menos 4 caracteres'); e.status = 400; throw e;
  }
  const clean = String(name).trim().slice(0, 32);
  if (Object.values(players).some((p) => p.name.toLowerCase() === clean.toLowerCase())) {
    const e = new Error(`já existe um jogador chamado "${clean}"`); e.status = 409; throw e;
  }
  const id = newId('plr');
  players[id] = {
    id,
    name: clean,
    kind: kind === 'ai' ? 'ai' : 'human',
    // Para bots: qual modelo está jogando. Aparece na mesa e no replay.
    model: model ? String(model).slice(0, 48) : null,
    pass: hashPassword(password),
    createdAt: Date.now(),
    // Conta de bot criada pelo próprio servidor: vive só nesta execução.
    efemero: !!efemero,
    stats: { games: 0, goals: 0, shots: 0, fouls: 0 },
  };
  savePlayers();
  return publicPlayer(players[id]);
}

export function authenticate({ playerId, name, password }) {
  let p = null;
  if (playerId) p = players[playerId];
  else if (name) p = Object.values(players).find((q) => q.name.toLowerCase() === String(name).toLowerCase());
  if (!p || !verifyPassword(password, p.pass)) {
    const e = new Error('credenciais inválidas'); e.status = 401; throw e;
  }
  return p;
}

export function getPlayer(id) {
  return players[id] || null;
}

export function publicPlayer(p) {
  if (!p) return null;
  return { playerId: p.id, name: p.name, kind: p.kind, model: p.model || null, stats: p.stats };
}

export function bumpStat(playerId, field, n = 1) {
  const p = players[playerId];
  if (!p) return;
  p.stats[field] = (p.stats[field] || 0) + n;
  savePlayers();
}

export function listPlayers() {
  return Object.values(players).map(publicPlayer);
}

/* ---------------- Tokens de sessão ---------------- */

const tokens = new Map();   // token -> { playerId, expires }

export function issueToken(playerId) {
  const token = newId('tok', 24);
  tokens.set(token, { playerId, expires: Date.now() + SERVER.tokenTtlMs });
  return token;
}

export function resolveToken(token) {
  if (!token) return null;
  const t = tokens.get(token);
  if (!t) return null;
  if (Date.now() > t.expires) { tokens.delete(token); return null; }
  return t.playerId;
}

export function revokeToken(token) {
  return tokens.delete(token);
}

/* ---------------- Partidas (memória) ---------------- */

const games = new Map();

export const gameStore = {
  put(game) { games.set(game.id, game); return game; },
  get(id) { return games.get(id) || null; },
  all() { return [...games.values()]; },
  delete(id) { return games.delete(id); },
  size() { return games.size; },
};

export { safeEqual };
