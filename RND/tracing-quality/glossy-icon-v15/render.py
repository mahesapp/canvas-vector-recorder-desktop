"""Independent CairoSVG rendering; requires pillow, cairosvg and numpy."""
from pathlib import Path
from PIL import Image, ImageDraw
import cairosvg
import json
import numpy as np

root = Path(__file__).resolve().parent
reference = Image.open(root / 'reference.png').convert('RGBA')
images = [reference]
metrics = {}
source = np.asarray(reference).astype(float)
for name in ['before', 'after']:
    cairosvg.svg2png(url=str(root / f'{name}.svg'), write_to=str(root / f'{name}.png'))
    image = Image.open(root / f'{name}.png').convert('RGBA')
    images.append(image)
    pixels = np.asarray(image).astype(float)
    metrics[name] = {'rgbaMSE': float(np.mean(((pixels - source) / 255) ** 2)),
                     'rgbMAE': float(np.mean(np.abs(pixels[:, :, :3] - source[:, :, :3])))}
labels = ['Sumber', 'Sebelum', 'Sesudah']
for filename, box, size in [
    ('comparison.png', None, (381, 384)),
    ('highlights-comparison.png', (310, 310, 465, 460), (465, 450)),
    ('tag-comparison.png', (750, 540, 870, 655), (480, 460)),
]:
    canvas = Image.new('RGB', (size[0] * 3, size[1] + 35), 'white')
    draw = ImageDraw.Draw(canvas)
    for i, (label, image) in enumerate(zip(labels, images)):
        draw.text((i * size[0] + 12, 10), label, fill='black')
        panel = image.crop(box) if box else image
        canvas.paste(panel.convert('RGB').resize(size, Image.Resampling.LANCZOS), (i * size[0], 35))
    canvas.save(root / filename)
(root / 'independent-metrics.json').write_text(json.dumps(metrics, indent=2) + '\n')
print(json.dumps(metrics))
