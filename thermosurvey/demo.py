"""Generate repeatable synthetic wall surveys before and after insulation repair."""

import numpy as np
from PIL import Image, ImageDraw

from .frame import png
from .model import defaults


def wall(seed):
    """Float surface-temperature field of the practice wall; the seed only changes sensor noise."""
    width, height = 480, 310
    y, x = np.indices((height, width))
    rng = np.random.default_rng(seed)
    pin = rng.normal(0, 0.08, size=(height, width))
    wall = 20.7 + 0.8 * np.sin(y / 76) + 0.29 * np.cos(x / 62) + pin
    wall += 1.1 * np.exp(-((x - 387) / 57) ** 2 - ((y - 233) / 44) ** 2)
    xx = 164 + 0.075 * (y - 154)
    shades = np.exp(-((x - xx) / 18) ** 2) * np.exp(-((y - 147) / 101) ** 8)
    wall -= shades * (6.3 - 0.6 * np.cos(y / 12))
    wall -= 5.6 * np.exp(-((x - 271) / 19) ** 2 - ((y - 202) / 38) ** 2)
    wall -= 2.8 * np.exp(-((x - 72) / 12) ** 2 - ((y - 178) / 60) ** 2)
    wall -= 2.7 * np.exp(-((x - 345) / 14) ** 2) * np.exp(-((y - 139) / 113) ** 6)
    solid_reference = (x >= 412) & (x < 458) & (y > 75) & (y < 189)
    wall[solid_reference] = 21.8 + pin[solid_reference] / 3
    wall -= 1.25 * np.exp(-((y - 271) / 43) ** 2)
    return wall


def encode(field):
    return np.rint((field + 273.15) * 100).astype(np.uint16)


def material():
    """Pre-repair survey: insulation defects at their original low temperatures."""
    y, x = np.indices((310, 480))
    raw = encode(wall(8704))
    raw[(x > 152) & (x < 174) & (y > 149) & (y < 156)] = 0
    raw[(x > 374) & (x < 386) & (y > 112) & (y < 178)] = 65535
    raw[(x > 254) & (x < 322) & (y < 46)] = 0
    return Image.fromarray(raw)


def repaired():
    """Post-repair survey: one small defect fixed thoroughly, a wide area only slightly."""
    y, x = np.indices((310, 480))
    field = wall(4170)
    field += 5.2 * np.exp(-((x - 271) / 14) ** 2 - ((y - 202) / 26) ** 2)
    field += 1.7 * np.exp(-((x - 150) / 95) ** 8 - ((y - 165) / 90) ** 8)
    raw = encode(field)
    raw[70:258, 148:150] = 0
    raw[0:46, 254:322] = 0
    return Image.fromarray(raw)


def visible(size):
    """Draw a matching field-elevation sketch for the synthetic exercise."""
    image = Image.new("RGB", size, "#e0d1b6")
    draw = ImageDraw.Draw(image)
    for y in range(0, size[1], 28):
        draw.line((0, y, size[0], y), fill="#c6b18c", width=1)
        for x in range(-50 if y % 56 else 0, size[0], 100):
            draw.line((x, y, x, y + 28), fill="#ccbb9b", width=1)
    draw.rectangle((147, 32, 178, 267), fill="#b2a787", outline="#9a8c66", width=2)
    draw.rectangle((247, 142, 297, 238), fill="#938a76", outline="#6f695c", width=4)
    draw.line((345, 0, 345, size[1]), fill="#a79879", width=4)
    draw.rectangle((0, 270, size[0], size[1]), fill="#b4a38a")
    return image


def create(library):
    before = material()
    earlier = library.create("保温墙 · 修前练习", "insulation-before.png",
                             png(before), before.size, defaults(*before.size),
                             {"kind": "synthetic"})
    library.attach_context(earlier["id"], earlier["revision"], png(visible(before.size)),
                           before.size, "保温墙 · 合成现场底图", {"kind": "synthetic"})
    after = repaired()
    project = library.create("保温墙 · 修后练习", "insulation-after.png",
                             png(after), after.size, defaults(*after.size),
                             {"kind": "synthetic"})
    return library.attach_context(project["id"], project["revision"], png(visible(after.size)),
                                  after.size, "保温墙 · 合成现场底图", {"kind": "synthetic"})
