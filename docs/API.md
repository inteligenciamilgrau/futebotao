# API do Futebotão

Base: `http://localhost:3000`. Tudo é JSON. CORS liberado.

Autenticação por token no header `Authorization: Bearer <token>`
(também aceita `X-Token:` ou `?token=` na query, para `<img>` e WebSocket).

Erros vêm como `{ "error": "mensagem", "status": 409, "code": "NOT_YOUR_TURN" }`.

**Use o `code`, não o status.** Um 403 pode ser "não é a sua vez" (desista) ou
"esse botão não é seu" (corrija e mande de novo) — coisas bem diferentes para um bot.

| `code` | HTTP | Dá para corrigir e reenviar? |
|---|---|---|
| `NOT_YOUR_TURN` | 403 | não, a vez é de outro |
| `STALE_TURN_TOKEN` | 409 | não, o turno virou |
| `GAME_NOT_RUNNING` / `GAME_FINISHED` | 409 | não |
| `NOT_YOUR_BUTTON` | 403 | **sim**, escolha um botão seu |
| `UNKNOWN_BUTTON` | 400 | **sim** |
| `KEEPER_IS_AUTO` | 400 | **sim**, escolha um botão de linha |
| `NO_DIRECTION` | 400 | **sim**, mande palheta.anguloAro (ou targetX/targetY, angleDeg, vx/vy) |
| `NO_SUCH_LANCE` | 404 | — (replay) |
| `KEEPER_IS_BOX` | 400 | **sim**, o goleiro é caixa fixa: escolha um botão de linha |
| `NOT_KEEPER_PHASE` | 409 | não, espere o goleiro ser posicionado |
| `NOT_PLACEMENT_PHASE` | 409 | posicione o botão da cobrança primeiro |
| `ALREADY_DECLARED` | 409 | você já declarou este chute |
| `KEEPER_OUT_OF_AREA` | 400 | **sim**, a caixa tem que ficar na área |
| `KEEPER_BLOCKED` | 400 | **sim**, a caixa está em cima da bola, de um botão ou da trave — vem `obstaculo: { id, kind }` |
| `PLACEMENT_TOO_FAR` | 400 | **sim**, o botão da cobrança tem que ficar perto da bola |
| `NO_PLACEMENT` | 400 | **sim**, escolha um botão antes de confirmar |
| `TEAM_FULL` / `NOT_ENOUGH_PLAYERS` | 409 | — (entrada/início de partida) |

---

## Autenticação

### `POST /api/auth/register`
```json
{ "name": "claude-1", "password": "segredo1234", "kind": "ai", "model": "claude-opus-5" }
```
`kind` é `human` ou `ai` (só rotula, não muda regra nenhuma). `model` é opcional e
serve para bots: aparece ao lado do nome na mesa, no replay e na etiqueta da palheta.
Nome com 2+ caracteres, senha com 4+. Nome duplicado devolve **409**.

```json
{ "playerId": "plr_ahp59h28a2", "name": "joao", "kind": "human",
  "stats": { "games": 0, "goals": 0, "shots": 0, "fouls": 0 },
  "token": "tok_..." }
```

### `POST /api/auth/login`
```json
{ "name": "joao", "password": "segredo1234" }
```
Aceita `playerId` no lugar de `name`. Devolve o mesmo formato acima.

### `POST /api/auth/logout` · `GET /api/me`
`/api/me` devolve o jogador mais a lista de partidas em que ele está,
com `yourTurn` em cada uma.

---

## Partidas

### `GET /api/games`
Lista resumida de todas as partidas.

### `POST /api/games` 🔒
```json
{
  "name": "Pelada",
  "teamAName": "Azuis", "teamBName": "Vermelhos",
  "slotsA": 2, "slotsB": 1,
  "config": {
    "buttonsPerTeam": 5,
    "touchesPerPossession": 3,
    "maxPossessions": 40,
    "turnTimeoutMs": 120000,
    "requireBallContact": true,
    "foulOnOpponentFirst": true,
    "autoKeeper": true,
    "kickoffJitter": 3.5
  }
}
```
`slotsA` e `slotsB` são independentes: **2 contra 1**, **3 contra 3**, o que quiser.
Dentro de um time a vez roda entre os jogadores, um toque para cada.

### `POST /api/games/{id}/join` 🔒
```json
{ "team": "A", "autoStart": false }
```
Sem `team`, o servidor escolhe o lado com mais vaga. Entrar de novo é idempotente
(devolve `already: true`). Time cheio devolve **409**.

### `POST /api/games/{id}/leave` 🔒 · `POST /api/games/{id}/start` 🔒 · `DELETE /api/games/{id}` 🔒

`start` exige ao menos um jogador em cada time. `DELETE` só para quem criou.

---

## Estado

### `GET /api/games/{id}/state`

| Query | Efeito |
|---|---|
| `brief=1` | só o essencial (~270 bytes) |
| `describe=1` | inclui `description`: o estado em texto, pronto para um LLM |
| `frame=1` | inclui `frame.data`: PNG da mesa vista de cima, em base64 |
| `history=N` | quantos lances entram na descrição (padrão 6) |

Resposta completa:

```json
{
  "gameId": "gm_...", "status": "running",
  "scoreA": 1, "scoreB": 0,
  "turnNo": 14, "possession": "A",
  "touchIndex": 1, "touchesPerPossession": 3,
  "possessionsPlayed": 7, "maxPossessions": 40,
  "currentPlayerId": "plr_...",
  "currentPlayer": { "playerId": "plr_...", "name": "claude-1", "kind": "ai", "model": "claude-opus-5" },
  "turnDeadline": 1717171717171,
  "ball": { "x": 118.4, "y": 62.1 },
  "pitch": { "length": 200, "width": 120, "goalMin": 45, "goalMax": 75, "...": "..." },
  "teams": {
    "A": {
      "name": "Azuis", "slots": 2, "score": 1, "attacks": "+x",
      "players": [
        { "playerId": "plr_...", "name": "joao", "kind": "human", "model": null },
        { "playerId": "plr_...", "name": "claude-1", "kind": "ai", "model": "claude-opus-5" }
      ]
    },
    "B": { "...": "..." }
  },
  "bodies": [
    { "id": "A1", "kind": "button", "team": "A", "x": 42.5, "y": 60.0, "r": 2.4 },
    { "id": "AG", "kind": "keeper", "team": "A", "x": 7.0, "y": 60.0, "forma": "caixa", "w": 16, "h": 4.5, "ang": 1.57 },
    { "id": "traveB1", "kind": "post", "team": null, "x": 200, "y": 45, "r": 1.3 },
    { "id": "ball", "kind": "ball", "team": null, "x": 118.4, "y": 62.1, "z": 0, "r": 1.15 }
  ],
  "fase": "jogada",
  "reinicio": null,
  "declarado": false,
  "podeJogar": true, "podeDeclarar": true,
  "podePosicionarGoleiro": false, "podeCobrar": false,
  "cobrancaOpcional": false, "formacao": null, "cobranca": null,
  "posicionaveis": [],
  "goleiros": { "A": { "...": "..." }, "B": { "...": "..." } },
  "areaGoleiro": { "A": { "...": "..." }, "B": { "...": "..." } },
  "yourTeam": "A", "yourTurn": true,
  "controllable": ["A1", "A2", "A3", "A4", "A5"],
  "turnToken": "trn_...",
  "segundosRestantes": 42,
  "lastResolution": { "...": "..." },
  "result": null
}
```

`turnToken` e `controllable` só aparecem para quem tem a vez.

Campos que valem conhecer:

| Campo | O que é |
|---|---|
| `fase` | `jogada`, `goleiro` ou `cobranca` |
| `reinicio` | nome da bola parada em curso (`"saída de bola"`, `"lateral"`…) ou `null`. Enquanto não for `null`, **não dá para declarar chute a gol** |
| `cobrancaOpcional` | `true` na formação da saída: dá para arrumar **e** bater |
| `formacao` | na saída, `{ prontos: {A,B}, maxNoCirculo }` |
| `cobranca.area` | a região onde os seus botões podem ficar — depende de quem pergunta |
| `posicionaveis` | os botões que **você** pode posicionar agora |
| `segundosRestantes` | prazo da vez em segundos, ou `null` se a partida não tem prazo |
| `bodies[].forma` | `caixa` no goleiro (com `w`, `h`, `ang`); os demais são círculos |
| `bodies[].z` | altura da bola (ela sobe quando o botão a levanta) |
| `kind: "post"` | as traves são corpos de verdade e aparecem aqui |

### `GET /api/games/{id}/frame.png`
O PNG puro. Aceita `?token=` e `?message=texto` (escreve o texto no rodapé da imagem).

### `GET /api/games/{id}/log?since=N`
Eventos com `seq > N`, cada um já com um `texto` legível.

---

## As três fases do turno

`state` traz `fase` e três booleanos que dizem o que VOCÊ pode fazer agora.
Use-os em vez de deduzir: eles já consideram de quem é a vez.

| `fase` | quem age | booleano | rota |
|---|---|---|---|
| `jogada` | quem tem a posse | `podeJogar` | `POST /move` |
| `goleiro` | o time **defensor** | `podePosicionarGoleiro` | `POST /keeper` |
| `cobranca` | quem recebeu a bola | `podeCobrar` | `POST /place` |

Existe também `podeDeclarar`: você tem a posse, está na fase de jogada, ainda não
declarou **e a bola não está parada** (veja abaixo).

A fase `cobranca` tem dois sabores, e `cobrancaOpcional` diz qual:

| | cobrança comum (lateral, escanteio, tiro de meta) | formação da saída de bola |
|---|---|---|
| `cobrancaOpcional` | `false` | `true` |
| quem arruma | só quem recebeu a bola | **os dois times, ao mesmo tempo** |
| região | até `cobranca.raio` cm da bola | o campo do time (+ o círculo central, para quem bate) |
| dá para jogar sem arrumar? | não | **sim** — bater fecha a fase |

### `POST /api/games/{id}/declare` 🔒

Anuncia que você vai chutar a gol. Corpo vazio. **Sem isso o gol é anulado.**
A vez passa para o defensor posicionar a caixa; depois volta para você — com a
**mesma palheta** que você tinha montado (o servidor a guarda e a republica em
`game/{id}/aim` com `restaurada: true` quando o defensor confirma).

```json
{ "ok": true, "fase": "goleiro", "defensor": "plr_...", "turnToken": "trn_...", "deadline": 1717... }
```

**Em bola parada não se declara.** Saída de bola (o primeiro toque da partida e
o de depois de cada gol), lateral, escanteio e tiro de meta devolvem **409
`CANNOT_DECLARE_ON_RESTART`**. Dê o primeiro toque e declare na jogada seguinte.
O estado traz `reinicio` com o nome da bola parada em curso, ou `null`.

**Uma declaração, um chute.** Declarou, bateu e não fez gol? A declaração acaba ali,
mesmo que a posse siga sua: o resultado do lance vem com `declaracaoConsumida: true`,
a caixa do goleiro **fica onde está** (quem decide movê-la é o defensor) e `podeDeclarar` fica `true` de novo. Para
chutar a gol outra vez, declare outra vez — e o defensor rearruma a caixa.

### `POST /api/games/{id}/keeper` 🔒

Move a caixa do seu goleiro. Só o time defensor, só na fase `goleiro`.
Chame quantas vezes quiser — cada uma é difundida em `game/{id}/keeper`.

```json
{ "x": 192, "y": 52, "anguloDeg": 75 }
{ "confirmar": true }
```

`anguloDeg`: **90 = atravessada** na frente do gol (cobre 16 dos 30 cm da boca);
**0 = de lado** (quase não cobre). Fora da área devolve **400 `KEEPER_OUT_OF_AREA`**;
o estado traz `areaGoleiro.A` e `areaGoleiro.B` com os limites.

**A caixa tem que caber.** Se a posição pedida deixar a caixa por cima da bola, de um botão
ou de uma trave, a chamada devolve **400 `KEEPER_BLOCKED`** com `obstaculo: { id, kind }` e
NADA se move — nem a caixa, nem quem estava no caminho. Bot que posiciona goleiro precisa
tratar isto: a área do goleiro é justamente onde a bola morre e onde os atacantes se
amontoam, então a posição ideal costuma estar ocupada. `bot/heuristic-bot.js` mostra a
saída: `caixaLivre()` (em `bot/client.js`) testa antes, e a busca varre posições vizinhas
até achar uma livre.

### `POST /api/games/{id}/place` 🔒

Posiciona um botão na fase `cobranca`. `state.posicionaveis` lista os botões que
você pode mexer e `state.cobranca.area` descreve onde eles podem ficar.
Difundido em `game/{id}/place`.

```json
{ "buttonId": "B3", "x": 118, "y": 6 }
{ "confirmar": true }
```

**Cobrança comum.** Um botão só, a até `area.raio` (18 cm) da bola:

```json
"area": { "tipo": "perto da bola", "x": 118, "y": 3, "raio": 18, "maxBotoes": 1 }
```

**Formação da saída de bola.** Os dois times arrumam ao mesmo tempo, cada um
os próprios botões, cada um no seu campo. Quem vai bater pode adiantar até
2 botões para dentro do círculo central; o adversário fica todo fora dele.

```json
"area": {
  "tipo": "formação",
  "campo": { "xMin": 0, "xMax": 100, "yMin": 0, "yMax": 120 },
  "circulo": { "x": 100, "y": 60, "raio": 22 },
  "podeNoCirculo": true, "maxNoCirculo": 2, "usadosNoCirculo": 1, "bate": true
}
```

`{ "confirmar": true }` significa "terminei". Se quem confirma é o time que
**bate**, a fase fecha e a jogada libera; se é o adversário, ele só sai de cena
(`fase` continua `cobranca`, e a vez não muda). Arrumar é opcional dos dois
lados: a formação padrão já é válida, e um `POST /move` de quem bate fecha a
fase sozinho.

| erro | quando |
|---|---|
| 400 `PLACEMENT_TOO_FAR` | fora do raio, na cobrança comum |
| 400 `OUT_OF_HALF` | na formação, fora do próprio campo |
| 409 `CIRCLE_IS_THEIRS` | na formação, o time que **não** bate tentou entrar no círculo |
| 409 `CIRCLE_LIMIT` | já há `maxNoCirculo` botões seus no círculo |
| 409 `PLACEMENT_LIMIT` | cota de botões da cobrança comum estourada |
| 409 `ALREADY_READY` | você já confirmou a formação |
| 403 `NOT_YOUR_BUTTON` | o botão é do outro time |

### `POST /api/games/{id}/encerrar` 🔒

Acaba a partida agora, com o placar como está. Corpo vazio. Pode encerrar quem está
jogando nela, ou quem a criou (mesmo de fora — o estado traz `souDono`).

```json
{ "ok": true, "status": "finished", "result": { "scoreA": 2, "scoreB": 1, "winner": "A", "reason": "encerrada por joao" } }
```

Depois disso **todo comando de jogo é recusado com 409 `GAME_FINISHED`**, e a resposta
diz o que houve em vez de um "não está em andamento" seco:

```json
{
  "error": "a partida acabou (encerrada por joao) — placar final 2 x 1. Não dá mais para jogar nela.",
  "status": 409, "code": "GAME_FINISHED",
  "result": { "scoreA": 2, "scoreB": 1, "winner": "A", "reason": "encerrada por joao" }
}
```

Os bots embutidos param sozinhos: o relógio deles só age em partida em andamento.
Um bot externo deve tratar `GAME_FINISHED` como "fim de expediente" e sair do laço.

> Todo erro da API carrega o contexto que ajuda a corrigir a chamada — a área válida
> num posicionamento recusado, de quem é a vez num `NOT_YOUR_TURN`, o placar final aqui.

### `POST /api/games/{id}/aguardar` 🔒

Guarda uma vaga para uma IA **de fora** — uma LLM, um subagente, qualquer coisa
que fale esta API. Sem isso não dá para esperar por uma: o tempo entre pedir a ela
que jogue e ela de fato entrar é exatamente quando alguém do lobby ocupa a vaga.

```json
{ "team": "B" }
```
```json
{
  "ok": true, "gameId": "gm_...", "team": "B", "timeNome": "Vermelhos",
  "convite": "cvt_...", "base": "http://localhost:3000",
  "comando": "node bot/ai-bot.js --game=gm_... --team=B --convite=cvt_... --base=...",
  "prompt": "Jogue futebol de botão pela API em ..."
}
```

Cada time tem a sua reserva: dá para guardar uma vaga no A, outra no B, e assistir a
uma LLM jogar contra a outra. Cada uma recebe o seu convite, e o convite de um time
não abre a vaga do outro.

Enquanto a reserva existe, a vaga aparece como **ocupada** no lobby
(`teams.B.vagas === 0`, `teams.B.esperandoIA === true`) e um `join` sem convite leva
**409 `SLOT_RESERVED`**. Quem apresenta o convite entra e a reserva se desfaz:

```json
POST /api/games/{id}/join   { "team": "B", "convite": "cvt_...", "autoStart": true }
```

O `prompt` é o passo a passo pronto para colar num agente. O estado traz
`reservas.A` / `reservas.B` (sem o convite, que é segredo de quem pediu a espera).

Erros: **409 `ALREADY_RESERVED`** (o time já espera alguém), **409 `TEAM_FULL`**.

### `DELETE /api/games/{id}/aguardar?team=B` 🔒

Cancela a espera e devolve a vaga ao lobby. Só quem pediu (ou o dono da partida):
os outros levam **403 `NOT_YOURS`**; sem reserva, **404 `NO_RESERVATION`**.

### `POST /api/games/{id}/bot` 🔒

Põe um adversário de IA embutido (heurística fixa, roda dentro do servidor) na
vaga pedida. Com a mesa cheia, a partida começa sozinha.

```json
{ "team": "B" }
```
```json
{ "ok": true, "bot": { "playerId": "plr_...", "name": "IA Vermelhos a1b2", "kind": "ai", "model": "heurística local", "team": "B" }, "status": "running" }
```

Time cheio devolve **409 `TEAM_FULL`**.

---

## Mira ao vivo (a palheta antes de apertar)

### `POST /api/games/{id}/aim` 🔒

Mostra como você está posicionando a palheta **sem jogar**. Só quem tem a vez pode.

A resposta traz `previsao.bola.voo`: o PULO da bola, ou `null` se ela vai rasteira.

```json
"voo": {
  "alturaMax": 6.3,      // centímetros no ponto mais alto
  "ondeMax": 13.7,       // a que distância do toque fica o pico
  "pouso": 32,           // onde ela volta ao chão
  "pontos": [[0,0], [2,1.4], [4,2.6], "..."]   // [distância, altura] para desenhar
}
```

É com isto que se decide a cavadinha: a caixa do goleiro tem 5 cm de altura, então a bola
passa por cima dela só no trecho em que `altura > 5`. O campo `bateEm` já leva isso em
conta — ele não acusa o goleiro quando a bola voa por cima.
Cada chamada difunde em `game/{id}/aim`, então quem assiste vê o ajuste acontecendo —
é isso que permite acompanhar uma IA escolhendo o lance.

```json
{ "buttonId": "A3", "palheta": { "anguloAro": 215, "inclinacao": 45, "avanco": 0.35, "forca": 0.62 } }
```

Resposta (e conteúdo do tópico):

```json
{
  "gameId": "gm_...", "playerId": "plr_...", "playerName": "claude-1", "turnNo": 14,
  "buttonId": "A3",
  "botao": { "x": 96.5, "y": 60, "r": 2.4 },
  "palheta": { "anguloAro": 215, "inclinacao": 45, "avanco": 0.35, "forca": 0.62 },
  "apoio": { "x": 94.8, "y": 59, "raio": 1.71 },
  "direcao": 35, "desvio": 0, "rendimento": 1, "velocidade": 109,
  "escorregou": false, "cavada": false, "duracaoVoo": 0,
  "aviso": "apoio limpo",
  "previsao": {
    "direcao": 35, "corridaDisco": 38.4, "distanciaVoo": 0,
    "parada": { "x": 128.0, "y": 82.0 },
    "primeiroContato": { "id": "ball", "dist": 12.1 },
    "alcancaBola": true,
    "bola": { "direcao": 35, "velocidade": 96, "corrida": 60.4, "parada": { "x": 142.7, "y": 94.7 } }
  }
}
```

`previsao` é **geometria fechada**, não uma simulação: diz até onde o disco corre, em
quem ele bate primeiro e, se for na bola, para onde ela vai. É de propósito que não seja
a simulação completa — a ideia é ajudar a mirar, não virar uma sandbox de força bruta.

Pelo WebSocket é `{"op":"aim", ...}`, que é o caminho recomendado (dispara a cada
mexida no controle). O tópico é retido, então quem entra no meio já vê a palheta atual.

**Cada mira vira um passo gravado.** O servidor guarda a sequência de ajustes do turno
e a anexa ao lance no replay — é assim que dá para rever *como* o jogador chegou
naquela configuração, e não só o resultado. Miras idênticas seguidas não viram passo
novo, e o histórico zera a cada turno.

---

## Replay

### `GET /api/games/{id}/replay`
Índice leve de todos os lances (poucos KB numa partida inteira):

```json
{
  "gameId": "gm_...", "total": 74,
  "teams": { "A": "Azuis", "B": "Vermelhos" },
  "placarFinal": [2, 1],
  "result": { "winner": "A", "reason": "fim do tempo" },
  "lances": [
    { "n": 0, "turnNo": 1, "playerId": "plr_...", "team": "A", "buttonId": "A1",
      "outcome": "toque válido (1/3)", "goal": null, "foul": false,
      "cavada": false, "escorregou": false,
      "scoreA": 0, "scoreB": 0, "seconds": 1.2,
      "quadros": 11, "ajustes": 6 }
  ]
}
```

`?full=1` traz também `trajetorias[]` com todos os quadros **e os ajustes**, para o
navegador rever a partida inteira sem uma requisição por lance (~20 KB a cada 10 lances).

### `GET /api/games/{id}/replay/{n}`
Um lance com a palheta usada e os quadros (a 20 fps, subamostrados da animação ao vivo):

```json
{ "n": 0, "turnNo": 1, "team": "A", "buttonId": "A1",
  "palheta": { "anguloAro": 180, "inclinacao": 45, "avanco": 0.35, "forca": 0.6, "...": "..." },
  "outcome": "toque válido (1/3)", "scoreA": 0, "scoreB": 0,
  "ajustes": [
    { "playerName": "claude-1", "buttonId": "A1",
      "palheta": { "anguloAro": 206, "inclinacao": 38, "avanco": 0.28, "forca": 0.30 },
      "apoio": { "x": 94.8, "y": 59 }, "direcao": 26,
      "rendimento": 0.855, "escorregou": false, "cavada": false,
      "aviso": "rendimento 86%", "definitivo": false },
    { "...": "...", "definitivo": true }
  ],
  "ids": ["AG","A1","..."], "fps": 20,
  "frames": [ { "t": 0, "p": [7,60, 94.9,60, "..."] } ],
  "voos": [] }
```

`ajustes` é a **configuração passo a passo** da palheta, em ordem. O último tem
`definitivo: true` e é exatamente a palheta que foi jogada — mesmo que o jogador
não tenha transmitido mira nenhuma, nesse caso a lista tem esse único passo.

Lance inexistente devolve **404 `NO_SUCH_LANCE`**. O servidor guarda os últimos 400 lances.

### `GET /api/rules`
Geometria da mesa, constantes da física e valores padrão. Bots devem ler daqui em
vez de fixar números no código.

---

## Jogar

### `POST /api/games/{id}/move` 🔒

### Modo palheta (o jeito de verdade)

```json
{
  "buttonId": "A3",
  "palheta": { "anguloAro": 215, "inclinacao": 45, "avanco": 0.35, "forca": 0.62 },
  "turnToken": "trn_..."
}
```

| Campo | Faixa | O que faz |
|---|---|---|
| `anguloAro` | 0–359° | onde a palheta encosta no aro. **O botão sai a `anguloAro + 180`** |
| `inclinacao` | 10–80° | ângulo da palheta com a mesa. 45° rende mais; ≥66° com força faz cavadinha |
| `avanco` | 0–1 | apoio da borda (0) ao centro do topo (1). 0.35 rende mais |
| `forca` | 0.05–1.0 | quanto se aperta |

Só `anguloAro` é obrigatório; o resto assume o apoio ótimo. Sem ele: **400 `NO_DIRECTION`**.
Detalhes do modelo em [RULES.md](RULES.md#a-palheta).

### Modo simples (atalho)

```json
{ "buttonId": "A3", "targetX": 150, "targetY": 60, "power": 0.7 }
{ "buttonId": "A3", "angleDeg": 35, "power": 0.7 }
{ "buttonId": "A3", "vx": 120, "vy": 60 }
```

O servidor deduz a **palheta ideal** para aquela direção e força — os dois modos passam
pela mesma física, então `power` aqui equivale a `forca` com apoio ótimo.
`targetX`/`targetY` definem só a direção; o botão não para nesse ponto.

`turnToken` é opcional mas recomendado: se não bater com o turno atual devolve
**409 `STALE_TURN_TOKEN`**, protegendo contra jogar em cima de um estado velho.

Recusas: **403** fora da vez ou com botão do adversário, **400** botão inexistente
ou goleiro automático, **409** partida parada ou token vencido.

Resposta:

```json
{
  "ok": true,
  "result": {
    "turnNo": 14, "team": "A", "buttonId": "A3",
    "from": { "x": 96.5, "y": 60 },
    "modo": "palheta",
    "palheta": {
      "anguloAro": 215, "inclinacao": 45, "avanco": 0.35, "forca": 0.62,
      "apoio": { "x": 94.8, "y": 59 },
      "direcao": 35, "desvio": 0, "rendimento": 1,
      "escorregou": false, "cavada": false, "duracaoVoo": 0,
      "aviso": "apoio limpo"
    },
    "shot": { "vx": 118, "vy": 12, "velocidade": 109, "angleDeg": 35 },
    "seconds": 1.42,
    "touchedBall": true,
    "foul": false, "foulOn": null,
    "goal": { "team": "A", "byPlayer": "plr_...", "ownGoal": false },
    "possessionChanged": true,
    "outcome": "GOL!",
    "nextTurn": { "turnNo": 15, "possession": "B", "playerId": "plr_...", "turnToken": "trn_...", "deadline": 1717... }
  },
  "trajectory": {
    "ids": ["AG","A1","...","ball"],
    "fps": 60,
    "frames": [ { "t": 0, "p": [7,60, 42.5,60, "...", 118.4,62.1] }, "..." ],
    "events": [ { "t": 0.21, "type": "contact", "a": "A3", "b": "ball", "speed": 96 } ]
  },
  "state": { "...": "briefState" }
}
```

Em `trajectory.frames[i].p` os números vêm em pares `x,y` na ordem de `ids`.

---

## Broker (WebSocket)

`ws://localhost:3000/ws` — pode autenticar já na query (`?token=...`) ou pelo `connect`.

### Tópicos

| Tópico | Peso | Conteúdo |
|---|---|---|
| `game/{id}/state` | pesado | estado completo + trajetória (retido) |
| `game/{id}/turn` | leve | de quem é a vez (retido) |
| `game/{id}/aim` | leve | **palheta ao vivo**: quem está segurando e como está posicionada (retido) |
| `game/{id}/keeper` | leve | a caixa do goleiro sendo posicionada (retido) |
| `game/{id}/place` | leve | o botão da cobrança sendo posicionado (retido) |
| `game/{id}/event` | leve | gol, falta, timeout, início, fim |
| `game/{id}/chat` | leve | mensagens dos jogadores |
| `game/{id}/lobby` | leve | entradas e saídas |
| `player/{id}/turn` | leve | **privado**: é a sua vez, com o `turnToken` |
| `lobby/games` | leve | partidas criadas e removidas |

Curingas do MQTT valem: `+` casa um nível, `#` casa o resto.
`game/+/event` pega os gols de todas as partidas; `game/gm_x/#` pega tudo daquela.

**Controle de acesso:** `player/{id}/#` só pode ser assinado pelo próprio dono
(um `player/{id_alheio}/turn` volta na lista `negados`). Clientes só podem
publicar em `game/{id}/chat` — estado é sempre do servidor.

### Operações

```jsonc
// cliente -> servidor
{ "op": "connect",     "token": "tok_..." }
{ "op": "subscribe",   "topics": ["player/plr_x/turn", "game/gm_y/event"], "id": 1 }
{ "op": "unsubscribe", "topics": ["game/gm_y/event"] }
{ "op": "publish",     "topic": "game/gm_y/chat", "payload": { "texto": "boa!" } }
{ "op": "state",       "gameId": "gm_y", "describe": true, "frame": true, "id": 2 }
{ "op": "aim",         "gameId": "gm_y", "buttonId": "A3", "palheta": { "anguloAro": 215, "inclinacao": 45, "avanco": 0.35, "forca": 0.6 } }
{ "op": "ping" }

// servidor -> cliente
{ "op": "hello",   "clientId": "cli_...", "playerId": null, "topicos": { } }
{ "op": "connack", "ok": true, "playerId": "plr_..." }
{ "op": "suback",  "aceitos": [], "negados": [] }
{ "op": "message", "topic": "game/gm_y/turn", "payload": { }, "seq": 42, "ts": 1717... }
{ "op": "state",   "id": 2, "state": { } }
{ "op": "aimack",  "id": 3, "playerName": "claude-1", "direcao": 35, "previsao": { } }
{ "op": "pong" }
{ "op": "error",   "error": "..." }
```

`op: "state"` existe para o bot puxar o estado sem sair para o REST.

Mensagens retidas chegam com `"retained": true` assim que você assina, então um
cliente que conecta no meio da partida já recebe a situação atual.

---

## Receita para um bot

```js
import { FutebolClient } from './bot/client.js';

const cli = new FutebolClient({ name: 'meu-bot', password: 'segredo1234' });
await cli.auth();
await cli.join(gameId, 'B');

// Só o tópico privado: nada chega enquanto o adversário joga.
await cli.connectWS([`player/${cli.playerId}/turn`]);

cli.onTurn = async () => {
  const st = await cli.state(gameId, { describe: true, frame: true });
  const jogada = decidirDeAlgumJeito(st);
  await cli.move(gameId, { ...jogada, turnToken: st.turnToken });
};
```

Para "ir acompanhando", some `game/{id}/event` à assinatura — os eventos são
pequenos e não obrigam a chamar modelo nenhum. Ou consulte quando quiser com
`cli.state(gameId, { brief: true })`.
