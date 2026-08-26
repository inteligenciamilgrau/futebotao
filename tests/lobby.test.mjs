// O lobby só pode oferecer o time que tem vaga.
const BASE = process.env.BASE || 'http://localhost:3100';
let fails=0;
const ok=(n,c,i='')=>{console.log((c?'  PASS ':'  FAIL ')+n+(i?'  -> '+i:''));if(!c)fails++;};
const secao=(t)=>console.log('\n== '+t+' ==');

async function api(m,p,{token,body}={}) {
  const r = await fetch(BASE+p,{method:m,
    headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
    body: body?JSON.stringify(body):undefined});
  const t = await r.text(); let j; try{j=JSON.parse(t);}catch{j={raw:t};}
  return {status:r.status, json:j};
}
const sfx = Math.random().toString(36).slice(2,8);
const reg = async (n)=> (await api('POST','/api/auth/register',{body:{name:`${n}-${sfx}`,password:'lobby1234'}})).json;

const dono = await reg('lob-dono');
const outro = await reg('lob-outro');
const terceiro = await reg('lob-terceiro');

const cria = await api('POST','/api/games',{token:dono.token,
  body:{name:'Teste lobby '+sfx, slotsA:1, slotsB:1, config:{buttonsPerTeam:5}}});
const GID = cria.json.gameId;
const acha = (lista) => lista.games.find(g=>g.gameId===GID);

secao('Partida vazia: os dois times têm vaga');
{
  const l = acha((await api('GET','/api/games',{token:outro.token})).json);
  ok('time A com vaga', l.teams.A.vagas === 1, String(l.teams.A.vagas));
  ok('time B com vaga', l.teams.B.vagas === 1, String(l.teams.B.vagas));
  ok('não estou em nenhum time', l.seuTime === null, String(l.seuTime));
}

secao('Alguém entra no A: só B fica livre');
await api('POST',`/api/games/${GID}/join`,{token:dono.token,body:{team:'A'}});
{
  const l = acha((await api('GET','/api/games',{token:outro.token})).json);
  ok('time A sem vaga', l.teams.A.vagas === 0, String(l.teams.A.vagas));
  ok('time B ainda livre', l.teams.B.vagas === 1, String(l.teams.B.vagas));
  ok('A aparece como cheio', l.teams.A.ocupadas === l.teams.A.slots, `${l.teams.A.ocupadas}/${l.teams.A.slots}`);

  // E o servidor recusa mesmo quem insistir no time cheio.
  const insiste = await api('POST',`/api/games/${GID}/join`,{token:outro.token,body:{team:'A'}});
  ok('entrar no time cheio é recusado', insiste.status === 409 && insiste.json.code === 'TEAM_FULL',
     insiste.json.error);
}

secao('Quem já está na partida vê o próprio time');
{
  const l = acha((await api('GET','/api/games',{token:dono.token})).json);
  ok('dono vê seuTime = A', l.seuTime === 'A', String(l.seuTime));
  const lOutro = acha((await api('GET','/api/games',{token:outro.token})).json);
  ok('quem não entrou continua sem time', lOutro.seuTime === null, String(lOutro.seuTime));
}

secao('Times cheios: nenhum botão de entrar');
await api('POST',`/api/games/${GID}/join`,{token:outro.token,body:{team:'B'}});
{
  const l = acha((await api('GET','/api/games',{token:terceiro.token})).json);
  ok('A sem vaga', l.teams.A.vagas === 0);
  ok('B sem vaga', l.teams.B.vagas === 0);
  ok('terceiro não está em time nenhum', l.seuTime === null);
  const tenta = await api('POST',`/api/games/${GID}/join`,{token:terceiro.token,body:{team:'B'}});
  ok('terceiro é recusado nos dois times', tenta.status === 409, tenta.json.error);
}

secao('Sem token o lobby ainda funciona');
{
  const l = acha((await api('GET','/api/games')).json);
  ok('lista responde sem autenticação', !!l);
  ok('vagas continuam visíveis', typeof l.teams.A.vagas === 'number');
  ok('seuTime é nulo sem token', l.seuTime === null, String(l.seuTime));
}

secao('Time com várias vagas');
{
  const c2 = await api('POST','/api/games',{token:dono.token,
    body:{name:'Dois contra um '+sfx, slotsA:2, slotsB:1}});
  const G2 = c2.json.gameId;
  await api('POST',`/api/games/${G2}/join`,{token:dono.token,body:{team:'A'}});
  const l = (await api('GET','/api/games',{token:terceiro.token})).json.games.find(g=>g.gameId===G2);
  ok('A com 2 vagas e 1 ocupada mostra 1 livre', l.teams.A.vagas === 1, `${l.teams.A.ocupadas}/${l.teams.A.slots}`);
  ok('A continua oferecível', l.teams.A.vagas > 0);
}

console.log(fails===0?'\nTUDO OK\n':`\n${fails} FALHA(S)\n`);
// Sair com process.exit() no meio das conexões keep-alive do fetch derruba o
// Node no Windows (assertion do libuv). Marcar o código e deixar o processo
// terminar sozinho evita isso.
process.exitCode = fails ? 1 : 0;
