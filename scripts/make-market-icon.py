"""生成 dsh-market 用的位图图标（180x180 PNG）。

市场卡片约 96px 显示，所以图形必须是大色块、少细节。主题是「加密的 SSH 通道」：
深色圆角底 + 终端提示符 + 一把锁，用几何图形画，不依赖任何字体文件。
"""
from PIL import Image, ImageDraw

SIZE = 180
SCALE = 2  # 先画 2 倍再缩小，边缘更干净
S = SIZE * SCALE


def rounded_rect(draw, box, radius, fill):
    draw.rounded_rectangle(box, radius=radius, fill=fill)


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# —— 底板：深色圆角方块 ——
rounded_rect(d, [0, 0, S - 1, S - 1], radius=40 * SCALE, fill=(22, 24, 30, 255))

# —— 终端窗口：比底板略小的圆角矩形，稍亮一档 ——
pad = 26 * SCALE
win = [pad, pad + 6 * SCALE, S - pad, S - pad]
rounded_rect(d, win, radius=14 * SCALE, fill=(32, 36, 46, 255))

# 窗口标题栏三个点
dot_r = 4 * SCALE
dot_y = win[1] + 12 * SCALE
for i, color in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
    cx = win[0] + (14 + i * 14) * SCALE
    d.ellipse([cx - dot_r, dot_y - dot_r, cx + dot_r, dot_y + dot_r], fill=color)

# —— 提示符 ">" ——
accent = (86, 182, 255)
cx, cy = win[0] + 26 * SCALE, win[1] + 44 * SCALE
d.line([cx, cy, cx + 13 * SCALE, cy + 13 * SCALE], fill=accent, width=6 * SCALE)
d.line([cx + 13 * SCALE, cy + 13 * SCALE, cx, cy + 26 * SCALE], fill=accent, width=6 * SCALE)
# 光标下划线
d.line([cx + 19 * SCALE, cy + 26 * SCALE, cx + 38 * SCALE, cy + 26 * SCALE],
       fill=accent, width=6 * SCALE)

# —— 锁：压在终端右下角，表示"加密" ——
lw, lh = 40 * SCALE, 34 * SCALE
lx, ly = S - pad - lw + 14 * SCALE, win[3] - lh + 10 * SCALE
shackle_w = 22 * SCALE
shackle_top = ly - 16 * SCALE
shackle_x = lx + (lw - shackle_w) // 2
d.arc([shackle_x, shackle_top, shackle_x + shackle_w, ly + 8 * SCALE],
      start=180, end=360, fill=(255, 199, 89), width=6 * SCALE)

lock_fill = (255, 199, 89)
rounded_rect(d, [lx, ly, lx + lw, ly + lh], radius=6 * SCALE, fill=lock_fill)
# 锁孔：圆 + 竖槽
k_cx, k_cy = lx + lw // 2, ly + lh // 2 - 2 * SCALE
d.ellipse([k_cx - 4 * SCALE, k_cy - 4 * SCALE, k_cx + 4 * SCALE, k_cy + 4 * SCALE],
          fill=(32, 36, 46, 255))
d.line([k_cx, k_cy, k_cx, k_cy + 9 * SCALE], fill=(32, 36, 46, 255), width=4 * SCALE)

img = img.resize((SIZE, SIZE), Image.LANCZOS)
img.save("assets/icon-180.png", "PNG")
print("wrote assets/icon-180.png", img.size)
