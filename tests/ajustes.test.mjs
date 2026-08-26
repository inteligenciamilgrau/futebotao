// Os passos de configuração da palheta precisam ser gravados e voltar no replay.
// Precisa do servidor no ar.

const BASE = process.env.BASE || 'http://localhost:3000';
let fails=0;
const ok=(n,c,i='')=>{console.log((c?'  PASS ':'  FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};
const secao=(t)=>console.log('\n== '+t+' ==');

async function api(method, p, {token, body}={}) {
  const r = await fetch(BASE+p, { method,
    headers:{'Content-Type':'application/json', ...(token?{Authorization:'Bearer '+token}:{})},
    body: body?JSON.stringify(body):undefined });
  const t = await r.text(); let j; try{j=JSON.parse(t);}catch{j={raw:t};}
  return { status:r.status, json:j };
}

const sfx = Math.random().toString(36).slice(2,8);
const reg = async (n,extra={}) => (await api('POST','/api/auth/register',{body:{name:`${n}-${sfx}`,password:'ajuste1234',...extra}})).json;

const pA = await reg('aj-a');
const pB = await reg('aj-b', { kind:'ai', model:'claude-opus-5' });

const cria = await api('POST','/api/games',{token:pA.token,body:{
  name:'Teste de ajustes', slotsA:1, slotsB:1,
  config:{ buttonsPerTeam:5, maxPossessions:30, turnTimeoutMs:600000 }}});
const GID = cria.json.gameId;
await api('POST',`/api/games/${GID}/join`,{token:pA.token,body:{team:'A'}});
await api('POST',`/api/games/${GID}/join`,{token:pB.token,body:{team:'B'}});
await api('POST',`/api/games/${GID}/start`,{token:pA.token});

secao('Nome e modelo aparecem no estado');
{
  const st = (await api('GET',`/api/games/${GID}/state`,{token:pA.token})).json;
  const b = st.teams.B.players[0];
  ok('jogador vem com nome, não só id', typeof b?.name === 'string' && !b.name.startsWith('plr_'), b?.name);
  ok('bot expõe o modelo', b?.model === 'claude-opus-5', b?.model);
  ok('currentPlayer traz o perfil', !!st.currentPlayer?.name, st.currentPlayer?.name);
}

secao('Sequência de ajustes vira passos');
const st = (await api('GET',`/api/games/${GID}/state`,{token:pA.token})).json;
const botao = st.controllable[0];
const bt = st.bodies.find(b=>b.id===botao);
const bola = st.bodies.find(b=>b.id==='ball');
const dir = Math.atan2(bola.y-bt.y, bola.x-bt.x)*180/Math.PI;

// Simula um jogador mexendo nos controles: cinco ajustes, o último é o jogado.
const passos = [
  { anguloAro: (dir+180+40)%360, inclinacao: 30, avanco: 0.20, forca: 0.30 },
  { anguloAro: (dir+180+20)%360, inclinacao: 38, avanco: 0.28, forca: 0.45 },
  { anguloAro: (dir+180+8)%360,  inclinacao: 45, avanco: 0.35, forca: 0.55 },
  { anguloAro: (dir+180)%360,    inclinacao: 45, avanco: 0.35, forca: 0.60 },
];
for (const p of passos) {
  const r = await api('POST',`/api/games/${GID}/aim`,{token:pA.token,body:{buttonId:botao,palheta:p}});
  if (r.status!==200) { ok('aim aceito', false, r.json.error); break; }
}
ok('quatro ajustes transmitidos', true);

// Repetir o MESMO ajuste não deve virar passo novo.
await api('POST',`/api/games/${GID}/aim`,{token:pA.token,body:{buttonId:botao,palheta:passos[3]}});

const mv = await api('POST',`/api/games/${GID}/move`,{token:pA.token,
  body:{ buttonId:botao, palheta:passos[3], turnToken:st.turnToken }});
ok('jogada aceita', mv.status===200, mv.json.error||mv.json.result?.outcome);

secao('Replay devolve os passos');
const lance = (await api('GET',`/api/games/${GID}/replay/0`)).json;
const aj = lance.ajustes || [];
ok('lance guarda os ajustes', aj.length === 4, aj.length + ' passos');
ok('ajuste repetido não duplicou', aj.length === 4);
ok('primeiro passo é o primeiro ajuste', Math.abs(aj[0].palheta.forca - 0.30) < 1e-6, 'forca '+aj[0]?.palheta?.forca);
ok('último passo é o que foi jogado', aj[aj.length-1].definitivo === true);
ok('último passo bate com a palheta do lance',
   Math.abs(aj[aj.length-1].palheta.anguloAro - lance.palheta.anguloAro) < 0.01);
ok('cada passo traz rendimento e aviso', aj.every(a=>typeof a.rendimento==='number' && typeof a.aviso==='string'));
ok('cada passo traz o ponto de apoio', aj.every(a=>typeof a.apoio?.x==='number'));
ok('cada passo traz quem estava segurando', aj.every(a=>typeof a.playerName==='string' && a.playerName.length>0), aj[0]?.playerName);
ok('passos mostram o rendimento melhorando', aj[0].rendimento < aj[aj.length-1].rendimento,
   `${aj[0].rendimento} -> ${aj[aj.length-1].rendimento}`);

secao('Índice e replay completo');
const idx = (await api('GET',`/api/games/${GID}/replay`)).json;
ok('índice conta os ajustes', idx.lances[0].ajustes === 4, idx.lances[0].ajustes+'');
const full = (await api('GET',`/api/games/${GID}/replay?full=1`)).json;
ok('replay completo inclui os ajustes', Array.isArray(full.trajetorias[0].ajustes) && full.trajetorias[0].ajustes.length===4);

secao('Jogada sem mira nenhuma ainda tem um passo');
{
  // O time B joga direto, sem transmitir mira.
  const s2 = (await api('GET',`/api/games/${GID}/state?brief=1`)).json;
  const tok = s2.currentPlayerId === pA.playerId ? pA.token : pB.token;
  const sv = (await api('GET',`/api/games/${GID}/state`,{token:tok})).json;
  if (sv.yourTurn) {
    const b2 = sv.bodies.find(b=>b.id==='ball');
    const t2 = sv.bodies.find(b=>b.id===sv.controllable[0]);
    const d2 = Math.atan2(b2.y-t2.y, b2.x-t2.x)*180/Math.PI;
    await api('POST',`/api/games/${GID}/move`,{token:tok,
      body:{ buttonId:sv.controllable[0], palheta:{anguloAro:(d2+180)%360, inclinacao:45, avanco:0.35, forca:0.5}, turnToken:sv.turnToken }});
    const l1 = (await api('GET',`/api/games/${GID}/replay/1`)).json;
    ok('sem mira, o replay ainda tem a palheta jogada', (l1.ajustes||[]).length === 1 && l1.ajustes[0].definitivo === true,
       (l1.ajustes||[]).length + ' passo');
  } else { ok('vez para o teste sem mira', false); }
}

secao('Ajustes não vazam entre turnos');
{
  const l0 = (await api('GET',`/api/games/${GID}/replay/0`)).json;
  const l1 = (await api('GET',`/api/games/${GID}/replay/1`)).json;
  ok('cada lance tem os seus próprios passos', l0.ajustes.length !== l1.ajustes.length || l0.turnNo !== l1.turnNo,
     `t${l0.turnNo}:${l0.ajustes.length} vs t${l1.turnNo}:${l1.ajustes.length}`);
}

console.log(fails===0?'\nTUDO OK\n':`\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Basta marcar o código e deixar o
// processo terminar sozinho.
process.exitCode = fails ? 1 : 0;
