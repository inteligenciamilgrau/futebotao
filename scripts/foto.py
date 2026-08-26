"""Tira uma foto da mesa 3D num navegador headless.

Existe por um motivo específico: quem revisa o visual do jogo não tem como
julgar lendo código. "A torcida ficou melhor" não se descobre no diff. Este
script abre o jogo de verdade num Chromium sem tela, com WebGL por software,
monta uma partida e salva PNGs de vários ângulos.

Precisa do servidor no ar (o padrão é http://localhost:3000).

    python scripts/foto.py                       fotos padrão em fotos/
    python scripts/foto.py --saida antes/        outra pasta
    python scripts/foto.py --camera jogador      um ângulo só
    python scripts/foto.py --espera 6            mais tempo de cena antes da foto

Ele cria uma partida própria com dois bots e não encosta nas suas.
"""
import argparse
import json
import os
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

# SwiftShader é renderização por software: lenta, mas é o que permite WebGL sem
# GPU. Sem estas flags o three.js nem inicializa aqui.
FLAGS = [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-dev-shm-usage',
]

CAMERAS = ['tresQuartos', 'alto', 'lateral', 'rasante', 'timeB']


def api(base, metodo, caminho, corpo=None, token=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    req = urllib.request.Request(base + caminho, data=dados, method=metodo)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', 'Bearer ' + token)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode())


def montar_partida(base, sufixo):
    """Cria uma partida com dois bots e devolve (token, gameId)."""
    eu = api(base, 'POST', '/api/auth/register', {
        'name': f'foto-{sufixo}', 'password': 'foto12345678',
    })
    jogo = api(base, 'POST', '/api/games', {
        'name': f'Foto {sufixo}',
        'slotsA': 1, 'slotsB': 1,
        'config': {'buttonsPerTeam': 5, 'maxTurns': 0, 'turnTimeoutMs': 0,
                   'touchesPerPossession': 0, 'maxPossessions': 0},
    }, token=eu['token'])
    gid = jogo['gameId']
    for time_ in ('A', 'B'):
        api(base, 'POST', f'/api/games/{gid}/bot', {'team': time_}, token=eu['token'])
    return eu, gid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', default='http://localhost:3000')
    ap.add_argument('--saida', default='fotos')
    ap.add_argument('--camera', default=None, help='um ângulo só, em vez de todos')
    ap.add_argument('--espera', type=float, default=5.0,
                    help='segundos de jogo antes da primeira foto')
    ap.add_argument('--largura', type=int, default=1280)
    ap.add_argument('--altura', type=int, default=800)
    args = ap.parse_args()

    sufixo = str(int(time.time()))[-6:]
    try:
        eu, gid = montar_partida(args.base, sufixo)
    except Exception as e:
        print(f'não consegui montar a partida em {args.base}: {e}')
        print('o servidor está no ar? (node server/index.js)')
        return 1

    os.makedirs(args.saida, exist_ok=True)
    cameras = [args.camera] if args.camera else CAMERAS

    with sync_playwright() as p:
        navegador = p.chromium.launch(headless=True, args=FLAGS)
        pagina = navegador.new_page(viewport={'width': args.largura, 'height': args.altura})

        erros = []
        pagina.on('console', lambda m: erros.append(m.text) if m.type == 'error' else None)
        pagina.on('pageerror', lambda e: erros.append(str(e)))

        # A sessão vive no localStorage: injetamos antes de a página carregar,
        # senão ela abre na tela de login.
        pagina.add_init_script(f"""
          localStorage.setItem('fb_token', {json.dumps(eu['token'])});
          localStorage.setItem('fb_playerId', {json.dumps(eu['playerId'])});
          localStorage.setItem('fb_playerName', {json.dumps(eu['name'])});
        """)
        pagina.goto(f'{args.base}/?game={gid}', wait_until='networkidle', timeout=60000)

        # Espera a cena existir de fato, não só a página responder.
        try:
            pagina.wait_for_function('window.__cena || document.querySelector("#tela3d")',
                                     timeout=30000)
        except Exception:
            pass
        time.sleep(args.espera)

        salvos = []
        for cam in cameras:
            pagina.evaluate(
                "(nome) => document.querySelector(`[data-camera='${nome}']`)?.click()", cam)
            time.sleep(1.2)                       # deixa a câmera assentar
            caminho = os.path.join(args.saida, f'{cam}.png')
            pagina.locator('#tela3d').screenshot(path=caminho)
            salvos.append(caminho)
            print(f'  {caminho}')

        # Quadros por segundo: mede o custo real das mudanças de cena.
        fps = pagina.evaluate("""
          () => new Promise((ok) => {
            let n = 0;
            const t0 = performance.now();
            const conta = () => {
              n++;
              if (performance.now() - t0 < 3000) requestAnimationFrame(conta);
              else ok(Math.round((n * 1000) / (performance.now() - t0)));
            };
            requestAnimationFrame(conta);
          })
        """)

        info = pagina.evaluate("""
          () => {
            const r = window.__cena?.renderer;
            if (!r) return null;
            return {
              draws: r.info.render.calls,
              triangulos: r.info.render.triangles,
              texturas: r.info.memory.textures,
              geometrias: r.info.memory.geometries,
              programas: r.info.programs?.length ?? null,
            };
          }
        """)

        navegador.close()

    print(f'\nfotos: {len(salvos)}  ·  quadros por segundo (software): {fps}')
    if info:
        print('cena:', json.dumps(info))
    else:
        print('cena: o renderer não está exposto em window.__cena '
              '(veja o fim de public/js/app.js)')
    if erros:
        print('\nerros do navegador:')
        for e in erros[:10]:
            print('  ' + e[:160])
    return 0


if __name__ == '__main__':
    sys.exit(main())
