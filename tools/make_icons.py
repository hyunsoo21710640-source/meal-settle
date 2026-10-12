# 앱 아이콘(밥그릇) PNG를 icons/ 폴더에 생성하는 스크립트 — 실행: python tools/make_icons.py
from pathlib import Path

from PIL import Image, ImageDraw

ACCENT = "#c9450e"   # style.css의 --accent
BOWL = "#ffffff"
RICE = "#ffe8c8"
RIM = "#ffd3b0"
OUT = Path(__file__).resolve().parent.parent / "icons"
SS = 4  # 4배로 그린 뒤 줄여서 가장자리를 부드럽게


def draw_bowl(d, s):
    """512 기준 좌표를 s배로 그린다. 내용은 마스크 안전 영역(중앙 80%) 안에 들어간다."""
    k = lambda x0, y0, x1, y1: [x0 * s, (y0 - 36) * s, x1 * s, (y1 - 36) * s]   # 위로 36 올려 가운데 정렬
    for cx in (196, 256, 316):                       # 밥 봉우리
        d.ellipse(k(cx - 64, 186, cx + 64, 314), fill=RICE)
    d.pieslice(k(126, 170, 386, 390), 0, 180, fill=BOWL)   # 그릇 몸통 (아래쪽 반원)
    d.rectangle(k(126, 278, 386, 282), fill=BOWL)
    d.rectangle(k(146, 300, 366, 314), fill=RIM)          # 그릇 띠
    d.rounded_rectangle(k(212, 378, 300, 402), radius=8 * s, fill=BOWL)   # 굽


def make(size, maskable):
    s = SS * size / 512
    big = size * SS
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if maskable:
        d.rectangle([0, 0, big, big], fill=ACCENT)
    else:
        d.rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=ACCENT)
    draw_bowl(d, s)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(exist_ok=True)
    make(192, False).save(OUT / "icon-192.png")
    make(512, False).save(OUT / "icon-512.png")
    make(512, True).save(OUT / "icon-maskable-512.png")
    print("saved to", OUT)
