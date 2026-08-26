"""Renderiza um som do jogo num navegador headless e MEDE o que saiu.

Existe pelo mesmo motivo que `scripts/foto.py`: quem trabalha no som não tem
como julgar lendo código, e "ficou melhor" não se descobre no diff. A diferença
é que aqui ninguém ouve — nem o headless nem quem revisa por texto. Então o
script faz duas coisas:

  - MEDE. Duração, pico, RMS, envelope em dez fatias e taxa de cruzamento por
    zero. É com isso que se pega som mudo, som estourado, som que não tem
    ataque e som que dura três vezes o que devia.
  - GRAVA UM .WAV. Aí uma pessoa ouve de verdade, quando quiser.

O truque: `TorcidaSom` cria o próprio `AudioContext`. Aqui `window.AudioContext`
é trocado por um `OfflineAudioContext` antes do módulo carregar, então o mesmo
código que toca no jogo é renderizado em arquivo, mais rápido que tempo real e
sem placa de som nenhuma.

    python scripts/ouvir.py gol
    python scripts/ouvir.py apito tambor palheta --segundos 3
    python scripts/ouvir.py --lista

Precisa do servidor no ar (padrão http://localhost:3000).
"""
import argparse
import base64
import json
import math
import os
import struct
import sys
import time

from playwright.sync_api import sync_playwright

FLAGS = [
    '--use-gl=swiftshader',
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
]

# Métodos de TorcidaSom que valem uma medição. `ligar` não entra: é montagem.
SONS = ['gol', 'suspiro', 'desanimo', 'apito', 'tambor', 'palheta', 'colisao', 'trave']

JS = r"""
async ({ nome, segundos, taxa, seco }) => {
  // O contexto offline entra no lugar do de verdade ANTES do módulo carregar:
  // é o que permite medir exatamente o mesmo código que toca no jogo.
  const dur = Math.round(taxa * segundos);
  let ctxCriado = null;
  class Falso extends OfflineAudioContext {
    constructor() { super(1, dur, taxa); ctxCriado = this; }
  }
  window.AudioContext = Falso;
  window.webkitAudioContext = Falso;

  const mod = await import('/js/torcida-som.js?medir=' + Math.random());
  const som = new mod.TorcidaSom();
  await som.ligar();

  // `ligar()` já deixa o murmúrio da torcida subindo. Ele faz parte da mistura
  // de verdade, então fica ligado por padrão; para medir UM efeito isolado o
  // `--seco` zera a cama e o que sobra na medição é só o efeito.
  if (seco) {
    som.ganhoTorcida.gain.cancelScheduledValues(0);
    som.ganhoTorcida.gain.setValueAtTime(0, 0);
  }

  if (typeof som[nome] !== 'function') return { erro: 'sem método ' + nome };
  som[nome]();

  const buf = await ctxCriado.startRendering();
  const d = buf.getChannelData(0);

  let pico = 0, soma = 0, cruzamentos = 0;
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i]);
    if (v > pico) pico = v;
    soma += d[i] * d[i];
    if (i && ((d[i] < 0) !== (d[i - 1] < 0))) cruzamentos++;
  }

  // Envelope em dez fatias: é o que mostra ataque, sustentação e queda sem
  // precisar de ninguém olhando uma forma de onda.
  const fatias = [];
  const passo = Math.floor(d.length / 10);
  for (let f = 0; f < 10; f++) {
    let s = 0;
    for (let i = f * passo; i < (f + 1) * passo; i++) s += d[i] * d[i];
    fatias.push(Math.sqrt(s / passo));
  }

  // Onde o som realmente acaba: último ponto acima de 1% do pico.
  let fim = 0;
  for (let i = d.length - 1; i >= 0; i--) {
    if (Math.abs(d[i]) > pico * 0.01) { fim = i; break; }
  }
  // E onde começa: primeiro ponto acima de 10% do pico, que é o ataque.
  let ataque = -1;
  for (let i = 0; i < d.length; i++) {
    if (Math.abs(d[i]) > pico * 0.1) { ataque = i; break; }
  }

  return {
    taxa: buf.sampleRate,
    amostras: d.length,
    pico,
    rms: Math.sqrt(soma / d.length),
    cruzamentosPorSegundo: cruzamentos / segundos,
    envelope: fatias,
    fimSegundos: fim / buf.sampleRate,
    ataqueSegundos: ataque < 0 ? null : ataque / buf.sampleRate,
    // Base64 de PCM 16 bits: o Python monta o cabeçalho WAV.
    pcm: (() => {
      const pcm = new Int16Array(d.length);
      for (let i = 0; i < d.length; i++) {
        const v = Math.max(-1, Math.min(1, d[i]));
        pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
      let bin = '';
      const bytes = new Uint8Array(pcm.buffer);
      const bloco = 0x8000;
      for (let i = 0; i < bytes.length; i += bloco) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + bloco));
      }
      return btoa(bin);
    })(),
  };
}
"""


def escrever_wav(caminho, pcm_bytes, taxa):
    """Cabeçalho WAV de 44 bytes na mão: não vale uma dependência."""
    n = len(pcm_bytes)
    with open(caminho, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', 36 + n))
        f.write(b'WAVEfmt ')
        f.write(struct.pack('<IHHIIHH', 16, 1, 1, taxa, taxa * 2, 2, 16))
        f.write(b'data')
        f.write(struct.pack('<I', n))
        f.write(pcm_bytes)


def barra(v, maximo):
    """Envelope em texto: quem lê o relatório enxerga o formato do som."""
    if maximo <= 0:
        return ' ' * 10
    n = int(round(v / maximo * 10))
    return ('#' * n).ljust(10, '.')


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('sons', nargs='*', help='quais medir (padrão: todos)')
    ap.add_argument('--base', default=os.environ.get('BASE', 'http://localhost:3000'))
    ap.add_argument('--segundos', type=float, default=8.0, help='janela de renderização')
    ap.add_argument('--taxa', type=int, default=44100)
    ap.add_argument('--saida', default='sons', help='onde gravar os .wav')
    ap.add_argument('--seco', action='store_true',
                    help='zera o murmúrio da torcida, para medir um efeito sozinho')
    ap.add_argument('--lista', action='store_true', help='só lista os sons conhecidos')
    args = ap.parse_args()

    if args.lista:
        print('\n'.join(SONS))
        return 0

    alvos = args.sons or SONS
    os.makedirs(args.saida, exist_ok=True)

    with sync_playwright() as pw:
        nav = pw.chromium.launch(headless=True, args=FLAGS)
        pag = nav.new_page()
        pag.goto(args.base + '/', wait_until='domcontentloaded', timeout=60000)

        falhou = False
        for nome in alvos:
            r = pag.evaluate(JS, {'nome': nome, 'segundos': args.segundos,
                                  'taxa': args.taxa, 'seco': args.seco})
            if r.get('erro'):
                print(f'{nome:10s}  ERRO: {r["erro"]}')
                falhou = True
                continue

            pcm = base64.b64decode(r['pcm'])
            caminho = os.path.join(args.saida, nome + '.wav')
            escrever_wav(caminho, pcm, r['taxa'])

            pico, rms = r['pico'], r['rms']
            topo = max(r['envelope']) or 1e-9
            print(f'{nome}')
            print(f'  pico {pico:.3f}   rms {rms:.4f}   dura {r["fimSegundos"]:.2f}s'
                  f'   ataque {"—" if r["ataqueSegundos"] is None else f"{r['ataqueSegundos']:.3f}s"}'
                  f'   zc/s {r["cruzamentosPorSegundo"]:.0f}')
            print('  envelope ' + ' '.join(barra(v, topo) for v in r['envelope']))
            if pico >= 0.999:
                print('  AVISO: pico em 1,0 — está estourando (clipping)')
            if pico < 0.01:
                print('  AVISO: praticamente mudo')
            print(f'  {caminho}')
            print()

        nav.close()
    return 1 if falhou else 0


if __name__ == '__main__':
    sys.exit(main())
