#!/usr/bin/env python3
"""Gera as texturas novas do Teta Tacaro em assets/texturas/.
Uso: python3 gerar_texturas.py [pasta_de_saida]
Pode editar cores/textos e rodar de novo. Para usar arte própria, basta sobrescrever o arquivo com o mesmo nome."""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

OUT = sys.argv[1] if len(sys.argv) > 1 else 'assets/texturas'
os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(42)
FB = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
def font(s):
    try: return ImageFont.truetype(FB, s)
    except Exception: return ImageFont.load_default()

def hexrgb(h): h = h.lstrip('#'); return np.array([int(h[i:i+2], 16) for i in (0, 2, 4)], np.float32)

def vnoise(w, h, g):
    """ruído de valor que emenda nas bordas (tileável)"""
    a = rng.random((g, g)).astype(np.float32)
    big = np.tile(a, (3, 3))
    im = Image.fromarray((big * 255).astype(np.uint8)).resize((3 * w, 3 * h), Image.BICUBIC)
    return np.asarray(im, np.float32)[h:2*h, w:2*w] / 255.0

def fbm(w, h, scales=(4, 8, 16, 32), wts=None):
    wts = wts or [1 / (i + 1) for i in range(len(scales))]
    n = sum(vnoise(w, h, s) * k for s, k in zip(scales, wts))
    return n / sum(wts)

def solid(w, h, c): return np.ones((h, w, 3), np.float32) * hexrgb(c)
def save(arr, name, q=90):
    Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).save(os.path.join(OUT, name), quality=q)
    print('✓', name)
def save_rgba(arr, alpha, name):
    rgba = np.dstack([np.clip(arr, 0, 255), np.clip(alpha, 0, 255)]).astype(np.uint8)
    Image.fromarray(rgba, 'RGBA').save(os.path.join(OUT, name)); print('✓', name)
def pil(arr): return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
def arr(im): return np.asarray(im.convert('RGB'), np.float32)
def shade(a, n, amt): return a * (1 + (n[..., None] - .5) * amt)
def center(d, txt, cx, cy, size, fill):
    f = font(size); b = d.textbbox((0, 0), txt, font=f)
    d.text((cx - (b[2] - b[0]) / 2 - b[0], cy - (b[3] - b[1]) / 2 - b[1]), txt, font=f, fill=fill)
def speckle(a, n, light=.5, dark=.3, size=1):
    h, w, _ = a.shape; o = a.copy()
    for _ in range(n):
        x, y = rng.integers(0, w), rng.integers(0, h)
        v = 255 if rng.random() < light else 0
        al = (.25 if v else .15) * rng.random()
        o[y:y+size, x:x+size] = o[y:y+size, x:x+size] * (1 - al) + v * al
    return o
def brushed(w, h, base, amt=.18, horiz=True):
    n = rng.random((h, 1) if horiz else (1, w)).astype(np.float32)
    n = np.tile(n, (1, w) if horiz else (h, 1))
    k = vnoise(w, h, 24)
    a = solid(w, h, base)
    return a * (1 + (n[..., None] - .5) * amt + (k[..., None] - .5) * .08)

# =============== GELADEIRA / VITRINE ===============
def geladeira_interior():
    w = h = 512; a = solid(w, h, '#e6edf1')
    x = np.arange(w)[None, :]
    rib = (np.sin(x / 32.0 * 2 * np.pi) * .5 + .5)           # nervuras verticais de plástico
    a = a * (0.93 + .07 * rib[..., None]) * (1 + (fbm(w, h)[..., None] - .5) * .06)
    a = speckle(a, 2500)
    save(a, 'geladeira_interior.jpg')

def geladeira_prateleira():
    w = h = 512; a = solid(w, h, '#59616b')                    # fundo escuro = vão entre os arames
    d = ImageDraw.Draw(pil(a)); im = pil(a); d = ImageDraw.Draw(im)
    for y in range(0, h, 32): d.rectangle([0, y + 10, w, y + 16], fill=(205, 212, 220))
    for x in range(0, w, 128): d.rectangle([x + 4, 0, x + 14, h], fill=(225, 230, 236))
    a = arr(im); a = speckle(a, 1500); save(a, 'geladeira_prateleira.jpg')

def vitrine_vidro():
    w = h = 512
    rgb = np.ones((h, w, 3), np.float32) * hexrgb('#cfeaff')
    yy, xx = np.mgrid[0:h, 0:w]
    alpha = np.ones((h, w), np.float32) * 175
    for off, wd, strength in ((90, 38, 70), (230, 16, 55), (380, 52, 45)):      # reflexos em diagonal
        dist = ((xx + yy) - off * 2 * 1.0) % (w * 2)
        alpha += np.clip(1 - np.abs(dist - w / 2.0) / wd, 0, 1) * strength
    alpha += (fbm(w, h)[..., None][..., 0] - .5) * 30
    rgb = rgb + np.dstack([np.clip(alpha - 175, 0, 80)] * 3) * .5                # reflexo mais claro
    save_rgba(rgb, alpha, 'vitrine_vidro.png')

def vitrine_moldura():
    a = brushed(256, 256, '#c5ccd4', .25)
    a = speckle(a, 800); save(a, 'vitrine_moldura.jpg')

# =============== PRODUTOS ===============
def produto_iogurte():
    w = h = 256; im = Image.new('RGB', (w, h), '#fdfdfd'); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w, 86], fill='#fdf2f8')
    d.rectangle([0, 86, w, h], fill='#db2777'); d.rectangle([0, 80, w, 92], fill='#ffffff')
    cx, cy = 128, 44                                           # morango
    d.polygon([(cx - 28, cy - 10), (cx + 28, cy - 10), (cx, cy + 32)], fill='#e11d48'); d.ellipse([cx - 30, cy - 24, cx + 30, cy + 8], fill='#e11d48')
    for p in ((-12, 0), (8, 6), (-2, 16), (14, -6), (-16, 10)): d.ellipse([cx + p[0] - 2, cy + p[1] - 2, cx + p[0] + 2, cy + p[1] + 2], fill='#fde68a')
    d.polygon([(cx - 14, cy - 22), (cx, cy - 12), (cx + 14, cy - 22), (cx, cy - 32)], fill='#16a34a')
    center(d, 'IOGURTE', 128, 134, 40, '#ffffff'); center(d, 'MORANGO', 128, 176, 26, '#fce7f3')
    center(d, 'TETA TACARO', 128, 226, 20, '#ffffff')
    a = arr(im); a = speckle(a, 1200); save(a, 'produto_iogurte.jpg')

def produto_leite():
    w = h = 256; im = Image.new('RGB', (w, h), '#1d4ed8'); d = ImageDraw.Draw(im)
    d.rectangle([0, 96, w, 230], fill='#ffffff')
    d.polygon([(128, 18), (98, 62), (158, 62)], fill='#bfdbfe'); d.ellipse([98, 44, 158, 90], fill='#bfdbfe')       # gota
    center(d, 'LEITE', 128, 148, 54, '#1d4ed8'); center(d, 'INTEGRAL', 128, 196, 24, '#3b82f6')
    d.rectangle([0, 230, w, h], fill='#1e3a8a'); center(d, 'TETA TACARO', 128, 244, 16, '#dbeafe')
    for x, y in ((40, 120), (210, 170), (60, 200)): d.ellipse([x - 8, y - 6, x + 8, y + 6], fill='#e0ecff')
    a = arr(im); a = speckle(a, 1000); save(a, 'produto_leite.jpg')

def produto_queijo():
    w = h = 256; a = solid(w, h, '#facc15'); a = shade(a, fbm(w, h), .12)
    im = pil(a); d = ImageDraw.Draw(im)
    for _ in range(14):                                         # furinhos
        x, y, r = rng.integers(16, 240), rng.integers(10, 240), rng.integers(6, 16)
        d.ellipse([x - r, y - r, x + r, y + r], fill='#d9a60b'); d.ellipse([x - r + 3, y - r + 3, x + r - 1, y + r - 1], fill='#eab308')
    d.rectangle([0, 98, w, 160], fill='#b91c1c'); center(d, 'QUEIJO', 128, 129, 44, '#fef9c3')
    center(d, 'TETA TACARO', 128, 218, 20, '#854d0e')
    a = arr(im); a = speckle(a, 900); save(a, 'produto_queijo.jpg')

def produto_congelado():
    w = h = 256; im = Image.new('RGB', (w, h), '#e0f2fe'); d = ImageDraw.Draw(im)
    d.rectangle([0, 0, w, 70], fill='#0369a1'); center(d, 'CONGELADO', 128, 35, 34, '#ffffff')
    for i in range(6):                                          # ervilhas
        x = 40 + i * 34; d.ellipse([x - 13, 118, x + 13, 144], fill='#22c55e'); d.ellipse([x - 6, 122, x, 128], fill='#86efac')
    center(d, 'LEGUMES', 128, 186, 34, '#075985'); center(d, '-18 C', 128, 228, 22, '#0ea5e9')
    a = arr(im)
    a = a * .86 + fbm(w, h, (8, 16, 32))[..., None] * 38 + 8       # geada
    a = speckle(a, 3500, .85); save(a, 'produto_congelado.jpg')

# =============== FRUTAS (mapa equirretangular: polos em cima e embaixo) ===============
def polar(a, y_top, y_bot, col, strength=1.0):
    h = a.shape[0]
    for y in range(h):
        t = max(0, 1 - y / y_top) if y < y_top else (max(0, 1 - (h - 1 - y) / y_bot) if y > h - y_bot else 0)
        if t > 0: a[y] = a[y] * (1 - t * strength) + col * t * strength
    return a

def make_fruit(name, c1, c2, streak, pores, pore_rgb, top_rgb, bot_rgb, top_h=30, bot_h=18, patch=None):
    w, h = 512, 256
    g = np.linspace(0, 1, h)[:, None, None]
    a = np.ones((h, w, 3), np.float32) * (hexrgb(c1) * (1 - g) + hexrgb(c2) * g)
    xs = np.tile(vnoise(w, 1, 48), (h, 1))
    a = a * (1 + (xs[..., None] - .5) * streak * 2) * (1 + (fbm(w, h)[..., None] - .5) * .22)
    if patch is not None:
        m = (vnoise(w, h, 5) > .62)[..., None]; a = np.where(m, a * .75 + np.array(patch, np.float32) * .25, a)
    for _ in range(pores):
        x, y = rng.integers(0, w), rng.integers(12, h - 12); r = rng.integers(1, 3)
        a[y:y+r, x:x+r] = a[y:y+r, x:x+r] * .55 + np.array(pore_rgb, np.float32) * .45
    for y in range(top_h):  a[y] = a[y] * (y / top_h) + np.array(top_rgb, np.float32) * (1 - y / top_h)
    for k in range(bot_h):  y = h - 1 - k; a[y] = a[y] * (k / bot_h) + np.array(bot_rgb, np.float32) * (1 - k / bot_h)
    save(a, name)

def gerar_frutas():
    make_fruit('fruta_maca.jpg',    '#a31515', '#e8283a', .32, 700, (255, 220, 160), (60, 38, 20), (80, 50, 25), 40, 22, patch=(220, 180, 40))
    make_fruit('fruta_laranja.jpg', '#f08a10', '#fb9d25', .08, 5200, (190, 90, 0),   (70, 100, 30), (150, 90, 20), 26, 16, patch=(255, 190, 70))
    make_fruit('fruta_limao.jpg',   '#6fbf1c', '#c7dd2e', .10, 4200, (70, 130, 10),  (90, 110, 30), (120, 130, 40), 22, 22, patch=(230, 230, 80))
    make_fruit('fruta_tomate.jpg',  '#c81d1d', '#e53a2b', .14, 500, (255, 190, 170), (35, 115, 35), (110, 40, 25), 44, 14, patch=(240, 90, 40))

# =============== CÂMARAS FRIAS ===============
def seams(a, step, vertical=True, horizontal=False, dark=(40, 70, 100), light=(255, 255, 255), rivets=False):
    h, w, _ = a.shape
    for i in range(0, w, step):
        a[:, max(i - 1, 0):i + 1] = a[:, max(i - 1, 0):i + 1] * .55 + np.array(dark, np.float32) * .45
        a[:, i + 2:i + 4] = a[:, i + 2:i + 4] * .8 + np.array(light, np.float32) * .2
    if horizontal:
        for j in range(0, h, step):
            a[max(j - 1, 0):j + 1, :] = a[max(j - 1, 0):j + 1, :] * .55 + np.array(dark, np.float32) * .45
    if rivets:
        im = pil(a); d = ImageDraw.Draw(im)
        for i in range(0, w, step):
            for y in (14, h - 14):
                for dx in (-8, 8): d.ellipse([i + dx - 2, y - 2, i + dx + 2, y + 2], fill=(120, 135, 150))
        a = arr(im)
    return a

def camara_parede_resfriados():
    w = h = 480; a = solid(w, h, '#d8e7f2'); a = shade(a, fbm(w, h), .08)
    a = seams(a, 160, rivets=True)
    a[h - 70:] *= np.linspace(1, .86, 70)[:, None, None]                    # sujeira de rodapé
    a = speckle(a, 3000); save(a, 'camara_parede_resfriados.jpg')

def camara_parede_congelados():
    w = h = 480; a = solid(w, h, '#bcdaee'); a = shade(a, fbm(w, h), .10)
    a = seams(a, 160, rivets=True)
    fr = fbm(w, h, (6, 12, 24, 48))[..., None]
    grad = np.linspace(0, 1, h)[:, None, None]
    a = a * (1 - .45 * fr * grad) + 255 * .45 * fr * grad                    # geada mais forte embaixo
    a = speckle(a, 6000, .9); save(a, 'camara_parede_congelados.jpg')

def camara_piso_resfriados():
    w = h = 512; a = np.ones((h, w, 3), np.float32)
    for ty in range(2):
        for tx_ in range(2):
            tone = rng.uniform(.93, 1.05)
            a[ty*256:(ty+1)*256, tx_*256:(tx_+1)*256] = hexrgb('#aebcc8') * tone
    a = shade(a, fbm(w, h), .12)
    a[::256] *= .55; a[:, ::256] *= .55; a[1::256] *= .7; a[:, 1::256] *= .7                    # rejunte
    a = speckle(a, 4000); save(a, 'camara_piso_resfriados.jpg')

def camara_piso_congelados():
    w = h = 512; a = solid(w, h, '#d5eefb'); a = shade(a, fbm(w, h, (3, 6, 12, 24)), .18)
    im = pil(a); d = ImageDraw.Draw(im)
    for _ in range(14):                                                                    # rachaduras no gelo
        x, y = rng.integers(60, 450), rng.integers(60, 450)
        for _ in range(rng.integers(4, 9)):
            nx, ny = x + rng.integers(-60, 61), y + rng.integers(-60, 61)
            nx, ny = int(np.clip(nx, 30, 480)), int(np.clip(ny, 30, 480))
            d.line([x, y, nx, ny], fill=(150, 195, 225), width=1); x, y = nx, ny
    a = arr(im.filter(ImageFilter.GaussianBlur(.6)))
    a = a + fbm(w, h, (10, 20))[..., None] * 30
    a = speckle(a, 4500, .9); save(a, 'camara_piso_congelados.jpg')

def camara_teto():
    w = h = 480; a = solid(w, h, '#e4ecf2'); a = shade(a, fbm(w, h), .06)
    a = seams(a, 160, vertical=True, horizontal=True, dark=(100, 120, 140))
    a = speckle(a, 2000); save(a, 'camara_teto.jpg')

def camara_estante_inox():
    a = brushed(512, 512, '#9aa5b0', .3)
    a[::256] *= .6; a[:, ::256] *= .6
    a = speckle(a, 1500); save(a, 'camara_estante_inox.jpg')

def camara_caixa_laticinios():
    w = h = 256; im = Image.new('RGB', (w, h), '#f3f6f8'); d = ImageDraw.Draw(im)
    for y in range(24, 110, 22): d.rounded_rectangle([24, y, 232, y + 10], 4, fill='#c7d0d8')         # aberturas da caixa
    d.rectangle([0, 130, w, 214], fill='#2563eb'); center(d, 'LATICÍNIOS', 128, 172, 34, '#ffffff')
    center(d, 'MANTER A 4 C', 128, 236, 18, '#475569')
    a = arr(im); a = shade(a, fbm(w, h), .07); a = speckle(a, 900); save(a, 'camara_caixa_laticinios.jpg')

def camara_caixa_congelados():
    w = h = 256; a = solid(w, h, '#c9a56e'); a = shade(a, fbm(w, h), .14)
    im = pil(a); d = ImageDraw.Draw(im)
    d.rectangle([0, 100, w, 156], fill='#1d4ed8'); center(d, 'FROZEN -18 C', 128, 128, 30, '#ffffff')
    for ang in range(0, 180, 60):                                                                      # floco
        v = np.deg2rad(ang); d.line([128 - 26 * np.cos(v), 54 - 26 * np.sin(v), 128 + 26 * np.cos(v), 54 + 26 * np.sin(v)], fill='#dbeafe', width=4)
    a = arr(im); a = a * .78 + fbm(w, h, (8, 16, 32))[..., None] * 60 + 14
    a = speckle(a, 4000, .9); save(a, 'camara_caixa_congelados.jpg')

def camara_carne():
    w = h = 256; a = solid(w, h, '#a31820'); a = shade(a, fbm(w, h, (6, 12, 24)), .55)
    f = vnoise(w, h, 14)[..., None]; a = np.where(f > .66, a * .4 + np.array([245, 225, 220], np.float32) * .6, a)   # gordura marmorizada
    im = pil(a); d = ImageDraw.Draw(im)
    d.rectangle([w - 100, 12, w - 12, 52], fill='#f8fafc'); center(d, 'CARNE', w - 56, 32, 22, '#b91c1c')
    a = arr(im.filter(ImageFilter.GaussianBlur(.5)))
    yy, xx = np.mgrid[0:h, 0:w]; a += np.clip(1 - np.abs((xx + yy) % 180 - 90) / 14, 0, 1)[..., None] * 24           # brilho do plástico a vácuo
    save(a, 'camara_carne.jpg')

def camara_carcaca():
    w = h = 256; a = solid(w, h, '#c4535a'); a = shade(a, fbm(w, h, (4, 8, 16)), .35)
    im = pil(a); d = ImageDraw.Draw(im)
    for y in range(10, h, 22): d.arc([20, y, w - 20, y + 40], 0, 180, fill=(245, 225, 215), width=3)         # costelas / gordura
    d.line([w // 2, 0, w // 2, h], fill=(240, 215, 205), width=6)
    a = arr(im.filter(ImageFilter.GaussianBlur(.8))); a = speckle(a, 1500); save(a, 'camara_carcaca.jpg')

def camara_gelo():
    w = h = 256; a = solid(w, h, '#bfe6fa'); a = shade(a, fbm(w, h, (3, 6, 12)), .35)
    im = pil(a); d = ImageDraw.Draw(im)
    for _ in range(9):
        x, y = rng.integers(20, 230), rng.integers(20, 230)
        for _ in range(rng.integers(3, 6)):
            nx, ny = int(np.clip(x + rng.integers(-45, 46), 8, 248)), int(np.clip(y + rng.integers(-45, 46), 8, 248))
            d.line([x, y, nx, ny], fill=(235, 250, 255), width=1); x, y = nx, ny
    for _ in range(40):
        x, y, r = rng.integers(8, 248), rng.integers(8, 248), rng.integers(1, 4)
        d.ellipse([x - r, y - r, x + r, y + r], outline=(240, 252, 255))
    a = arr(im.filter(ImageFilter.GaussianBlur(.7)))
    a = a * .85 + fbm(w, h, (6, 12))[..., None] * 45 + 10
    save(a, 'camara_gelo.jpg')

if __name__ == '__main__':
    geladeira_interior(); geladeira_prateleira(); vitrine_vidro(); vitrine_moldura()
    produto_iogurte(); produto_leite(); produto_queijo(); produto_congelado()
    gerar_frutas()
    camara_parede_resfriados(); camara_parede_congelados(); camara_piso_resfriados(); camara_piso_congelados()
    camara_teto(); camara_estante_inox(); camara_caixa_laticinios(); camara_caixa_congelados()
    camara_carne(); camara_carcaca(); camara_gelo()
