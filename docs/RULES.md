# Regras e física do Futebotão

## A mesa

Retângulo de **200 × 120 cm**, origem `(0,0)` no canto inferior esquerdo.
`x` cresce para a direita, `y` cresce **para cima**.

```
 y=120 ┌──────────────────────────────────────────┐
       │                    ┊                     │
  y=75 ╡  ┌─────────┐       ┊       ┌─────────┐  ╞  ← abertura do gol
       │  │  área   │      (·)      │  área   │  │
  y=45 ╡  └─────────┘       ┊       └─────────┘  ╞
       │                    ┊                     │
   y=0 └──────────────────────────────────────────┘
      x=0                 x=100                 x=200
   gol do time A                            gol do time B
   (A ataca para +x)                        (B ataca para -x)
```

O campo tem **linhas abertas**: não há tabelas. A bola cruza a linha e **sai** de jogo.
Os botões, não — eles param na linha, porque um disco fora do campo não faz sentido.

A bola tem **altura**: ela pode subir e passar por cima dos botões (~1 cm) e da caixa
do goleiro (5 cm). O travessão está a **9 cm** — acima disso não é gol.

Cada gol tem duas **traves**, círculos de raio 1,3 cm nos cantos da abertura.
Bola na trave não é gol.

## As peças

| Peça | Forma | Tamanho | Massa |
|---|---|---|---|
| Botão de linha | disco | raio 2,4 cm, 1,1 cm de altura | 1,00 |
| Goleiro | **caixa de fósforo** | 16 × 4,5 cm, 5 cm de altura | fixa (não se move) |
| Bola | esfera | raio 1,15 cm | 0,45 |

Ids são `A1..A9` e `AG` (goleiro) para o time A, `B1..B9` e `BG` para o time B.
A quantidade de botões de linha é configurável de 1 a 11 (`buttonsPerTeam`, padrão 5).

### Goleiro: uma caixa que o adversário posiciona

O goleiro é um **retângulo fixo** de 16 × 4,5 cm — uma caixa de fósforo. Ele não se
move quando é atingido, e nunca é lançado (tentar devolve **400 `KEEPER_IS_BOX`**).

Quem posiciona a caixa é o **time defensor**, e só quando o atacante declara um chute:

```
atacante: POST /declare        -> a vez passa para o defensor
defensor: POST /keeper {x,y,anguloDeg}   (quantas vezes quiser, tudo é difundido ao vivo)
defensor: POST /keeper {confirmar:true}  -> a vez volta para o atacante
atacante: POST /move                     -> agora sim, o chute
```

A caixa fica dentro da área do time (32 cm de profundidade, 74 de largura). O ângulo
importa muito: **90° = atravessada**, cobrindo 16 dos 30 cm da boca; **0° = de lado**,
cobrindo quase nada.

**A caixa não entra em cima de ninguém.** Bola, botão ou trave no lugar pretendido, e a
posição é recusada (`KEEPER_BLOCKED`): nada se move, nem a caixa nem quem está no caminho.
A regra existe porque antes dela o motor SEPARAVA os corpos depois de mover a caixa — quem
defendia reposicionava as peças do atacante só arrastando o goleiro por cima delas, e a bola
encostada na trave saía do lugar junto. Como a área do goleiro é justamente onde a bola morre
e onde os atacantes se amontoam, a posição ideal costuma estar ocupada: a saída é escolher
outra, e quem posiciona por API precisa tratar a recusa.

Se o defensor demorar mais que `tempoGoleiroMs`, a caixa fica onde estava e a vez volta.

## A palheta

Você não empurra o botão com a mão. Como no jogo de verdade, apoia uma **palheta** no
ombro biselado do botão e pressiona: ele escapa por baixo e desliza. É por isso que o
botão tem a borda arredondada — num disco de lado reto nada escaparia.

```
       palheta
         \                      avanco = 0    apoio na quina da borda
          \___                  avanco = 0.35 apoio ótimo
         /    \                 avanco = 1    apoio no centro do topo
        /      \  <- bisel
       |________|               inclinacao = ângulo da palheta com a mesa
    ================ mesa
```

Quatro números definem a jogada:

| Campo | Faixa | O que faz |
|---|---|---|
| `anguloAro` | 0–359° | **onde** a palheta encosta. O botão sai a `anguloAro + 180` |
| `inclinacao` | 10–80° | ângulo com a mesa |
| `avanco` | 0–1 | da borda (0) ao centro do topo (1) |
| `forca` | 0.05–1 | quanto se aperta |

### Rendimento e altura: a inclinação faz duas coisas

`inclinacao` e `avanco` entram numa gaussiana cada um, centradas em **45°** e **0.35**;
o rendimento é o produto. Mas a curva da inclinação é **assimétrica**, e por um motivo
físico: deitada demais a palheta desliza no bisel e a força se **perde**; em pé, a força
não some — ela é **redirecionada para cima**.

| inclinacao | rendimento | a bola sobe |
|---|---|---|
| 12° | 2% — escorrega, jogada perdida | 0 |
| 25° | 25% | 0 |
| 35° | 71% | 0 |
| **45°** | **100% — apoio limpo, o mais forte** | **0 (rasteiro)** |
| 55° | 93% | ~3 cm |
| 65° | 74% | ~7 cm |
| 75° | 51% | ~8 cm |
| 80° | 40% | ~7 cm |

Confira com `node tests/palheta.test.mjs`.

Sobre o avanço: 0.35 rende mais; abaixo de ~0.12 escorrega da quina; acima de ~0.75 prende
o botão. Acima de 0.55 também **torce a saída** até ~31°, para o lado que a inclinação
decide — determinístico, dá para aprender e corrigir.

### A bola sobe

A borda arredondada do botão pega **por baixo** da bola e a levanta. Quanto mais em pé a
palheta, mais da pancada vira altura:

```
vz_da_bola = elevacao × 1.6 × velocidade_do_impacto
elevacao   = (inclinacao − 45) / 35, limitado a [0, 1]
```

No ar a bola quase não freia (μ = 0,02), cai por gravidade e quica com restituição 0,5.
Enquanto está mais alta que um corpo, **passa por cima dele**:

| Obstáculo | Altura |
|---|---|
| Botão de linha | 1,1 cm |
| Caixa do goleiro | 5 cm |
| Travessão | 9 cm — acima disso não é gol, é linha de fundo |

O voo dura cerca de **30 cm**. Uma chapelada de longe já desceu antes de chegar no gol —
para passar por cima da caixa é preciso bater de perto, entre 15 e 30 cm.
Confira com `node tests/bolaalta.test.mjs`.

### Cavadinha

`inclinacao >= 66` com `forca >= 0.45` faz o botão **pular**. Durante o voo
(0,14 s + 0,34 s × força) ele passa **por cima** de todos os outros corpos e quase não
freia (μ = 0,03 no ar). É a jogada para alcançar a bola quando o caminho está bloqueado.
Custa velocidade, porque a palheta em pé rende pouco.

### Modo simples

A API também aceita `targetX`/`targetY` + `power`. O servidor apenas **deduz a palheta
ideal** para aquela direção e força — os dois caminhos usam a mesma física, então
`power` equivale a `forca` com apoio ótimo.

## A jogada

Você lança **um** botão por vez. Ele desliza, perde velocidade por atrito, colide com
quem estiver no caminho e para. O servidor simula até tudo parar (ou 9 s, o que vier
antes) e devolve a trajetória inteira.

### Turnos: você joga até errar

**Não há limite de toques.** Enquanto suas jogadas forem limpas, você continua jogando.
A vez só passa quando acontece uma destas quatro coisas:

| Motivo | `motivo` no resultado | O que foi |
|---|---|---|
| **Falta** | `falta` | seu botão encostou num botão adversário antes da bola |
| **Sem contato** | `sem_contato` | o botão lançado não encostou na bola |
| **Bola fora** | `bola_fora` | a bola cruzou uma linha |
| **Último toque** | `ultimo_toque` | a bola parou tendo tocado por último num botão adversário |

Encostar nos **próprios** botões antes da bola é permitido: é passe ou carambola.
Chutar em cima do goleiro entrega a posse — a caixa conta como botão adversário.

Num time com vários jogadores, a vez roda a cada toque. Estourar `turnTimeoutMs`
(padrão 120 s) também entrega a posse.

`requireBallContact`, `foulOnOpponentFirst` e `perdeNoUltimoToque` desligam essas
regras individualmente.

### Bola fora e cobrança

Saiu pela **lateral** → reposição na linha, no ponto onde saiu.
Saiu pela **linha de fundo** → escanteio ou tiro de meta, conforme quem vai cobrar.

A bola descansa **em cima da linha** — na risca mesmo, como na mesa de verdade.

Em qualquer um dos casos abre a **fase de cobrança**: quem recebe a bola escolhe **um
botão** e o coloca onde quiser a até `raioCobranca` (18 cm) da bola, e só depois joga.
Esse botão **pode ficar fora do campo** (até `margemFora`, 10 cm além da linha): é assim
que se cobra uma lateral, com o disco de fora trazendo a bola para dentro. A regra não é
"botão nunca fica fora", é **botão não sai**: uma vez dentro, a linha o segura.

```
POST /place {"buttonId":"B3","x":..,"y":..}    (quantas vezes quiser, difundido ao vivo)
POST /place {"confirmar":true}                 -> agora pode jogar
```

Isso existe por necessidade: sem ele a bola cairia no canto longe de todo mundo e o
time perderia a posse na jogada seguinte por não alcançá-la.

### Gol: só vale se foi declarado

Um gol só conta se o atacante **declarou** o chute antes de bater. Sem declaração o
gol é **anulado** e sai tiro de meta.

Isso não é capricho: declarar entrega ao adversário o direito de reposicionar a caixa
do goleiro. Se o gol valesse sem declarar, ninguém declararia nunca, e o goleiro nunca
sairia do lugar. Configurável em `golExigeDeclaracao`.

Gol contra conta para o adversário — o servidor decide pelo gol em que a bola entrou.

**Em bola parada não se declara.** Nem na saída de bola (o primeiro toque da partida
e o de depois de cada gol), nem em lateral, escanteio ou tiro de meta. Você dá o
primeiro toque e declara na jogada seguinte — o que faz sentido: a graça de declarar
é anunciar uma chance que você já construiu, não sair anunciando gol da bola parada.
A API devolve 409 `CANNOT_DECLARE_ON_RESTART`, e o estado diz por quê em `reinicio`.

**A palheta volta como estava.** Declarar não custa a sua mira: o servidor guarda os
quatro números da palheta no momento da declaração e os devolve quando o defensor
termina de posicionar o goleiro. Você posiciona, vê que dá gol, avisa — e continua
exatamente de onde estava.

**A declaração vale por um chute.** Declarou, bateu e não fez? A declaração acaba ali,
mesmo que a posse continue sua. Para
chutar a gol de novo é preciso declarar de novo, e o defensor arruma a caixa outra vez.
Sem isso, uma única declaração valeria para o resto da posse: você chutaria quantas vezes
quisesse sem o defensor poder reagir. A caixa NÃO volta ao lugar padrão: ela fica onde o
defensor a deixou, e é ele quem decide se sai de lá — pode muito bem querer mantê-la ali.
O resultado do
lance traz `declaracaoConsumida: true` quando isso acontece.

### Fim da partida

A partida acaba em `maxTurns` jogadas (padrão 120). Não há troca de lado: o time A
defende `x=0` do começo ao fim, o que mantém as coordenadas estáveis para quem joga
por API. `maxPossessions` continua existindo como limite alternativo (0 = desligado).

### Saída de bola: os dois times montam a mesa

Bola no centro, formações refeitas, o time defensor sai do círculo central (raio 22)
e quem bate fica encostado atrás da bola. Essa é a formação **padrão** — e a partir
dela os dois times arrumam a mesa, ao mesmo tempo:

| | time que bate | time que espera |
|---|---|---|
| onde põe os botões | no campo dele | no campo dele |
| círculo central (raio 22) | até **2 botões** dentro | **nenhum** |

```
POST /place {"buttonId":"A4","x":..,"y":..}    (quantas vezes quiser, difundido ao vivo)
POST /place {"confirmar":true}                 -> "terminei"
```

Arrumar é **opcional** dos dois lados: a formação padrão já é válida. Quem bate não
precisa nem confirmar — um `POST /move` fecha a fase. O "pronto" do time que espera
não mexe na vez de ninguém: ele só sai de cena.

Erros: `OUT_OF_HALF` (passou para o outro campo), `CIRCLE_IS_THEIRS` (quem espera
tentou entrar no círculo), `CIRCLE_LIMIT` (já tem 2 seus lá dentro).

As posições recebem um desvio aleatório de até `kickoffJitter` (3,5 cm), sorteado a
partir da semente da partida. Isso existe por um motivo concreto: a física é
determinística, então **sem esse desvio dois bots determinísticos repetiriam a mesma
sequência de lances do início ao fim da partida**. Com a semente presa à partida, o
jogo continua reproduzível, mas cada tiro de meio é diferente do anterior.

---

## Física

Modelo de disco deslizando sobre feltro.

**Atrito de Coulomb** — desaceleração constante, que é o comportamento real de um
disco deslizando (e não o decaimento exponencial que se costuma usar por
conveniência):

```
a = μ · g          g = 981 cm/s²
μ_botão = 0,16     μ_bola = 0,13
```

Daí a distância de parada sai fechada: `d = v² / (2·μ·g)`. O teste em
`tests/physics.test.mjs` confere a simulação contra essa fórmula (erro < 0,2 cm).

**Colisões** — impulso ao longo da normal com restituição `e = 0,62`, mais um
impulso tangencial limitado (`0,12`) que faz raspadas desviarem em vez de refletirem
como bola de bilhar ideal. Tabelas usam `e = 0,55`.

**Integração** — passo fixo de 1/600 s, dois passes de resolução de colisão por
passo. Keyframes gravados a 60 fps para a animação do cliente.

**Determinismo** — mesma entrada, mesma saída, bit a bit. É o que permite gravar
e reproduzir a trajetória em vez de simular no cliente.

### Força × distância

`power` de 0,05 a 1,0 vira velocidade inicial entre 10 e 170 cm/s.
Com o botão encostado na bola:

| power | disco corre | bola corre |
|---|---|---|
| 0,30 | 11 cm | 20 cm |
| 0,50 | 26 cm | 43 cm |
| 0,70 | 47 cm | 76 cm |
| 0,85 | 68 cm | 108 cm |
| 1,00 | 92 cm | 145 cm |

Reproduza com `node tests/calibration.mjs`.

Se o botão precisa andar até a bola, ele gasta energia no caminho. A conta exata
está em `forcaPara()` em [`bot/heuristic-bot.js`](../bot/heuristic-bot.js):

```
v_bola    = √(2 · μ_bola · g · corrida_desejada)
v_impacto = v_bola · (1/m_botão + 1/m_bola) · m_bola / (1 + e)
v_inicial = √(v_impacto² + 2 · μ_botão · g · distância_até_a_bola)
```

### Mandar a bola para onde você quer

A bola sai na direção da reta que liga o **centro do botão** ao **centro da bola**
no instante do toque. Para mandá-la numa direção `D`, o botão precisa passar por:

```
ponto_de_contato = posição_da_bola − D · 3,55        (3,55 = 1,15 + 2,4)
```

Se o botão já estiver encostado na bola, mire direto na direção `D`.

Quando a bola está colada numa tabela, o ponto de contato para chutar ao gol pode
cair **fora da mesa** — aí não existe jogada possível naquela direção, e é preciso
primeiro tirar a bola dali. É o caso que mais derruba heurística ingênua.
