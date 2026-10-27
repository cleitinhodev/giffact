# Gera quadros de referência (RGBA compostos pelo Pillow) para comparar com o decodificador do app
import sys, json
from PIL import Image
out = {}
for fn in sys.argv[1:]:
    im = Image.open(fn)
    frames = []
    durs = []
    for i in range(im.n_frames):
        im.seek(i)
        durs.append(im.info.get('duration', 100))
        fr = im.convert('RGBA')
        # amostra uma grade de pixels
        w, h = fr.size
        px = []
        for y in range(0, h, max(1, h // 12)):
            for x in range(0, w, max(1, w // 12)):
                px.append([x, y] + list(fr.getpixel((x, y))))
        frames.append(px)
    out[fn] = {'n': im.n_frames, 'size': im.size, 'frames': frames, 'durs': durs}
print(json.dumps(out))
