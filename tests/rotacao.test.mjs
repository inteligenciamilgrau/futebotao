// Confere a rotação de vez dentro de um time com vários jogadores.
import { createGame, startGame, applyMove, fullState } from '../server/game.js';

let fails=0;
const ok=(n,c,i='')=>{console.log((c?'PASS ':'FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};

const g = createGame({ slotsA:2, slotsB:1, config:{ buttonsPerTeam:5, touchesPerPossession:3, maxPossessions:40, turnTimeoutMs:9e6 } });
g.teams.A.players.push('a1','a2');
g.teams.B.players.push('b1');
startGame(g);

/**
 * Toque LIMPO: encosta o botão na bola e empurra devagar para o meio do campo.
 * Isso mantém a posse, que é o que este teste precisa observar — antes ele
 * mirava de longe, errava a bola e a posse virava, então às vezes o time A
 * nunca chegava a ter dois turnos seguidos e a asserção falhava sem motivo.
 */
function toqueLimpo(g, playerId, buttonId) {
  const bola = g.bodies.find(b=>b.kind==='ball');
  const bot  = g.bodies.find(b=>b.id===buttonId);
  const dir  = Math.atan2(60 - bola.y, 100 - bola.x) * 180 / Math.PI;
  const rad  = dir * Math.PI / 180;
  // Cola o botão atrás da bola na direção do meio do campo.
  bot.x = bola.x - Math.cos(rad) * (3.55 + 0.6);
  bot.y = bola.y - Math.sin(rad) * (3.55 + 0.6);
  return applyMove(g, playerId, {
    buttonId,
    palheta: { anguloAro: dir + 180, inclinacao: 45, avanco: 0.35, forca: 0.3 },
  });
}

const ordem=[];
for (let i=0;i<12;i++){
  const st = fullState(g, g.currentPlayerId);
  if (st.status !== 'running') break;
  if (!st.podeJogar || !st.controllable.length) break;
  ordem.push(`${st.possession}:${g.currentPlayerId}`);
  try { toqueLimpo(g, g.currentPlayerId, st.controllable[0]); }
  catch(e){ console.log('  (jogada recusada:', e.message, ')'); break; }
  if (g.status!=='running') break;
}
console.log('\nsequência de vezes:');
ordem.forEach((o,i)=>console.log(`  turno ${i+1}: ${o}`));

const posseA = ordem.filter(o=>o.startsWith('A:')).map(o=>o.slice(2));
const posseB = ordem.filter(o=>o.startsWith('B:')).map(o=>o.slice(2));
ok('time A alterna entre os dois jogadores', new Set(posseA).size===2, [...new Set(posseA)].join(','));
ok('time B sempre o mesmo jogador', new Set(posseB).size===1, [...new Set(posseB)].join(','));

// Dois toques seguidos da MESMA posse devem ser de jogadores diferentes.
let alternouDentroDaPosse=false;
for(let i=1;i<ordem.length;i++){
  const [t1,p1]=ordem[i-1].split(':'), [t2,p2]=ordem[i].split(':');
  if(t1==='A'&&t2==='A'&&p1!==p2) alternouDentroDaPosse=true;
}
// Com toques limpos a posse fica com A, então SEMPRE há turnos consecutivos
// para observar. Se isso deixar de valer, é sinal de regressão nas regras.
ok('houve posse com mais de um toque para observar', 
   ordem.filter((o,i)=>i>0 && o.startsWith('A:') && ordem[i-1].startsWith('A:')).length > 0,
   ordem.join(' '));
ok('a vez troca de jogador a cada toque dentro da posse', alternouDentroDaPosse);

// Quem começa a posse deve mudar de uma posse para a outra.
const iniciosA=[];
for(let i=0;i<ordem.length;i++){
  const [t,p]=ordem[i].split(':');
  if(t!=='A') continue;
  if(i===0||!ordem[i-1].startsWith('A:')) iniciosA.push(p);
}
ok('quem abre a posse do time A também roda', new Set(iniciosA).size===2, iniciosA.join(' -> '));

console.log(fails===0?'\nTUDO OK':`\n${fails} FALHA(S)`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
