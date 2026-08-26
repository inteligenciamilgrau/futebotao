// Broker estilo MQTT sobre WebSocket: tópicos, curingas (+ e #), retain
// e um controle de acesso simples. É por aqui que os jogadores "escutam" o jogo.
//
// Tópicos publicados pelo servidor:
//   game/{id}/state    snapshot completo + trajetória (pesado)
//   game/{id}/turn     de quem é a vez agora (leve)
//   game/{id}/event    gol, falta, timeout, início, fim (leve)
//   game/{id}/chat     mensagens dos jogadores
//   game/{id}/lobby    entradas e saídas
//   player/{id}/turn   privado: "é a sua vez" + token do turno (leve)
//   player/{id}/inbox  privado: erros e avisos direcionados

import { topicMatches, newId } from './util.js';

export class Broker {
  constructor() {
    this.clients = new Map();     // clientId -> session
    this.retained = new Map();    // topic -> envelope
    this.seq = 0;
  }

  /* ---------------- sessões ---------------- */

  attach(conn, ctx = {}) {
    const id = newId('cli', 8);
    const session = {
      id, conn,
      playerId: null,
      name: null,
      subs: new Set(),
      connectedAt: Date.now(),
      delivered: 0,
      ...ctx,
    };
    this.clients.set(id, session);
    conn.on('close', () => this.clients.delete(id));
    return session;
  }

  detach(session) {
    this.clients.delete(session.id);
  }

  /* ---------------- assinaturas ---------------- */

  canSubscribe(session, filter) {
    // Tópicos privados de jogador só podem ser assinados pelo próprio dono.
    if (filter.startsWith('player/')) {
      const parts = filter.split('/');
      if (parts[1] === '+' || parts[1] === '#') return false;
      return session.playerId === parts[1];
    }
    return true;
  }

  subscribe(session, filters) {
    const aceitos = [];
    const negados = [];
    for (const f of filters) {
      const filter = String(f).trim();
      if (!filter) continue;
      if (!this.canSubscribe(session, filter)) { negados.push(filter); continue; }
      session.subs.add(filter);
      aceitos.push(filter);
      // Entrega o retido que casa com o novo filtro.
      for (const [topic, env] of this.retained) {
        if (topicMatches(filter, topic)) session.conn.sendJSON({ ...env, retained: true });
      }
    }
    return { aceitos, negados };
  }

  unsubscribe(session, filters) {
    for (const f of filters) session.subs.delete(String(f).trim());
    return [...session.subs];
  }

  /* ---------------- publicação ---------------- */

  publish(topic, payload, { retain = false, exclude = null } = {}) {
    this.seq += 1;
    const env = { op: 'message', topic, payload, seq: this.seq, ts: Date.now() };
    if (retain) this.retained.set(topic, env);

    let entregues = 0;
    for (const s of this.clients.values()) {
      if (exclude && s.id === exclude) continue;
      if (!s.conn.open) continue;
      for (const filter of s.subs) {
        if (topicMatches(filter, topic)) {
          if (s.conn.sendJSON(env)) { entregues++; s.delivered++; }
          break;
        }
      }
    }
    return { seq: env.seq, entregues };
  }

  /** Envia direto a um jogador, esteja ele inscrito ou não. */
  publishToPlayer(playerId, topic, payload) {
    this.seq += 1;
    const env = { op: 'message', topic, payload, seq: this.seq, ts: Date.now(), direct: true };
    let entregues = 0;
    for (const s of this.clients.values()) {
      if (s.playerId === playerId && s.conn.open) {
        if (s.conn.sendJSON(env)) entregues++;
      }
    }
    return { seq: env.seq, entregues };
  }

  clearRetained(prefix) {
    for (const t of [...this.retained.keys()]) {
      if (t.startsWith(prefix)) this.retained.delete(t);
    }
  }

  sessionsOfPlayer(playerId) {
    return [...this.clients.values()].filter((s) => s.playerId === playerId);
  }

  stats() {
    return {
      clients: this.clients.size,
      autenticados: [...this.clients.values()].filter((s) => s.playerId).length,
      assinaturas: [...this.clients.values()].reduce((n, s) => n + s.subs.size, 0),
      retidos: this.retained.size,
      publicados: this.seq,
    };
  }
}

export const broker = new Broker();
