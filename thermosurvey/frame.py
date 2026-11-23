"""Decode and render radiometric sensor data at its original precision."""

from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from image_lab.validation import Invalid

from .model import MAX_PIXELS, MAX_UPLOAD


PALETTE_STOPS = {
    "iron": ["#15162f", "#511a61", "#a02866", "#df5450", "#ffad64", "#fff2bc"],
    "gray": ["#15182a", "#f7f7ed"],
    "cool": ["#253e73", "#478ba6", "#71bcac", "#e4e7aa"],
}
NO_DATA = (73, 86, 95)


def radiometric(payload):
    if not payload or len(payload) > MAX_UPLOAD:
        raise Invalid("请选择 16 MB 以内的热图。")
    try:
        with Image.open(BytesIO(payload)) as opened:
            if opened.format not in {"PNG", "TIFF"} or opened.mode not in {"I", "I;16", "I;16L", "I;16B"}:
                raise Invalid("请选择未经调色的 16 位单通道 PNG 或 TIFF 热图。")
            if min(opened.size) < 32 or opened.width * opened.height > MAX_PIXELS:
                raise Invalid("热图每边至少 32 像素，总像素不超过 200 万。")
            values = np.asarray(ImageOps.exif_transpose(opened))
            if values.min() < 0 or values.max() > 65535:
                raise Invalid("热图样本应为无符号 16 位读数。")
            return Image.fromarray(values.astype(np.uint16))
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise Invalid("这份热图无法读取。") from None


def png(image):
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def visible_light(content):
    if isinstance(content, Path):
        with content.open("rb") as handle:
            return visible_light(handle.read(MAX_UPLOAD + 1))
    if len(content) > MAX_UPLOAD:
        raise Invalid("现场照片应在 16 MB 以内。")
    try:
        with Image.open(BytesIO(content)) as opened:
            if opened.format not in {"PNG", "JPEG", "TIFF"} or opened.width * opened.height > 8_000_000:
                raise Invalid("请选择不超过 800 万像素的 PNG、JPEG 或 TIFF 现场照片。")
            image = ImageOps.exif_transpose(opened).convert("RGB")
            image.thumbnail((1600, 1200))
            return png(image), image.size
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, ValueError):
        raise Invalid("现场照片无法读取。") from None


def temperature(path, settings):
    with Image.open(path) as image:
        raw = np.asarray(image, dtype=np.uint16)
    val = raw.astype(np.float64) * settings["gain"] + settings["offset"]
    val[(raw == 0) | (raw == 65535)] = np.nan
    return val


def colors(palette):
    return np.array([[int(stop[i:i + 2], 16) for i in (1, 3, 5)] for stop in PALETTE_STOPS[palette]])


def paint(values, settings):
    stops = colors(settings["palette"])
    lo, hi = settings["show_lo"], settings["show_hi"]
    known = np.isfinite(values)
    scaled = np.clip((np.where(known, values, lo) - lo) / (hi - lo), 0, 1)
    steps = np.linspace(0, 1, len(stops))
    rgb = np.stack([np.interp(scaled, steps, channel) for channel in stops.T], axis=-1)
    rgb[~known] = NO_DATA
    return Image.fromarray(rgb.astype(np.uint8))
