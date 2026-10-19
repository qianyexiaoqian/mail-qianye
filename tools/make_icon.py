"""生成程序圖標 assets/icon.ico（📧 郵件風格）。需要 Pillow：.venv\\Scripts\\python.exe tools\\make_icon.py"""
import os

from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024  # 大尺寸繪製，再縮小抗鋸齒


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def draw():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # 背景：藍色漸變圓角方塊
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    top, bottom = (92, 140, 255, 255), (52, 86, 230, 255)
    for y in range(S):
        gd.line([(0, y), (S, y)], fill=lerp(top, bottom, y / S))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=220, fill=255)
    img.paste(grad, (0, 0), mask)

    # 信封陰影
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    env = [212, 300, 892, 760]
    ImageDraw.Draw(shadow).rounded_rectangle([env[0] + 10, env[1] + 28, env[2] + 10, env[3] + 28], radius=70, fill=(15, 30, 90, 110))
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(26)))

    d = ImageDraw.Draw(img)
    # 信封主體
    d.rounded_rectangle(env, radius=70, fill=(255, 255, 255, 255))
    x0, y0, x1, y1 = env
    cx = (x0 + x1) // 2
    # 信封底部兩條斜邊
    blue = (70, 110, 245, 255)
    w = 34
    d.line([(x0 + 40, y1 - 40), (cx - 40, 560)], fill=(200, 212, 245, 255), width=w, joint="curve")
    d.line([(x1 - 40, y1 - 40), (cx + 40, 560)], fill=(200, 212, 245, 255), width=w, joint="curve")
    # 封口 V 形
    d.line([(x0 + 48, y0 + 52), (cx, 560), (x1 - 48, y0 + 52)], fill=blue, width=46, joint="curve")
    for p in [(x0 + 48, y0 + 52), (x1 - 48, y0 + 52), (cx, 560)]:
        d.ellipse([p[0] - 23, p[1] - 23, p[0] + 23, p[1] + 23], fill=blue)

    # 左邊的速度線（📧 的「發送中」感覺）
    for i, (y, length) in enumerate([(400, 100), (500, 130), (600, 90)]):
        d.rounded_rectangle([x0 - 40 - length, y - 18, x0 - 40, y + 18], radius=18, fill=(255, 255, 255, 230 - i * 20))
    return img


def main():
    img = draw()
    out_dir = os.path.join(ROOT, "assets")
    os.makedirs(out_dir, exist_ok=True)
    sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
    img.save(os.path.join(out_dir, "icon.ico"), sizes=[(s, s) for s in sizes])
    img.resize((256, 256), Image.LANCZOS).save(os.path.join(out_dir, "icon.png"))
    print("ok", out_dir)


if __name__ == "__main__":
    main()
