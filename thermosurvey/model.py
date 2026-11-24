"""Validation for raw thermal frames and sensor-coordinate inspection settings."""

from copy import deepcopy
from math import isfinite

from image_lab.validation import Invalid

MAX_UPLOAD = 16 * 1024 * 1024
MAX_PIXELS = 2_000_000
PALETTES = ("iron", "gray", "cool")
MODES = {
    "region": "区域温度",
    "cold": "低温区",
    "profile": "温度剖线",
    "distribution": "温度分布",
    "reference": "参考区读数",
}


def document(value):
    if not isinstance(value, dict):
        raise Invalid("检查设置应为对象。")
    return value


def label(value, field="名称"):
    if not isinstance(value, str) or not 0 < len(value.strip()) <= 160:
        raise Invalid(f"请输入 1 至 160 字的{field}。")
    return value.strip()


def number(value, label_text, lo, hi):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value) or not lo <= value <= hi:
        raise Invalid(f"{label_text}应在 {lo} 至 {hi} 之间。")
    return value


def integer(value, label_text, lo, hi):
    if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
        raise Invalid(f"{label_text}应为 {lo} 至 {hi} 的整数。")
    return value


def coordinates(value, bounds, label_text):
    if not isinstance(value, list) or len(value) != len(bounds):
        raise Invalid(f"请在热图上设置{label_text}。")
    return [integer(item, label_text, 0, hi) for item, hi in zip(value, bounds)]


def rectangle(value, width, height, label_text):
    x0, y0, x1, y1 = coordinates(value, (width - 1, height - 1, width, height), label_text)
    if x0 >= x1 or y0 >= y1:
        raise Invalid(f"{label_text}需要正的宽度和高度。")
    return [x0, y0, x1, y1]


def defaults(width, height):
    return {
        "gain": 0.01, "offset": -273.15, "mm_per_pixel": 5.0,
        "palette": "iron", "show_lo": 12.0, "show_hi": 24.0,
        "inspect": [width // 10, height // 5, width * 13 // 20, height * 17 // 20],
        "reference": [width * 7 // 10, height // 5, width * 19 // 20, height * 3 // 4],
        "trace": [width // 6, height // 2, width * 3 // 5, height // 2],
        "delta": 3.0, "min_area": 8, "bins": 10, "reference_window": None,
    }


WINDOW_CHOICES = ("near", "uniform")


def reference_window(value, width, height, reference):
    if value is None:
        return None
    value = document(value)
    unknown = set(value).difference({"box", "side_mm", "choice", "median"})
    if unknown:
        raise Invalid("参考方窗存在未识别的设置。")
    box = rectangle(value.get("box"), width, height, "参考方窗")
    x0, y0, x1, y1 = box
    if x1 - x0 != y1 - y0:
        raise Invalid("参考方窗的宽与高应相等。")
    rx0, ry0, rx1, ry1 = reference
    if not (rx0 <= x0 and ry0 <= y0 and x1 <= rx1 and y1 <= ry1):
        raise Invalid("参考方窗须整块落在参考区内。")
    side_mm = number(value.get("side_mm"), "方窗实际边长", 0.01, 1_000_000)
    choice = value.get("choice", "near")
    if choice not in WINDOW_CHOICES:
        raise Invalid("参考方窗推荐类型无效。")
    median = number(value.get("median"), "方窗有效温度中位数", -1000, 1000)
    return {"box": box, "side_mm": side_mm, "choice": choice, "median": median}


def settings(value, panel):
    chosen = deepcopy(panel["settings"])
    requested = document(value)
    missing = set(requested).difference(chosen)
    if missing:
        raise Invalid("存在未识别的检查设置。")
    chosen.update(requested)
    ranges = {
        "gain": ("每码温差", 0.00001, 2), "offset": ("零码温度", -1000, 1000),
        "mm_per_pixel": ("每像素毫米数", 0.001, 10000),
        "show_lo": ("显色下限", -1000, 1000), "show_hi": ("显色上限", -1000, 1000),
        "delta": ("温差门槛", 0.01, 100),
    }
    for key, (name, lo, hi) in ranges.items():
        chosen[key] = number(chosen[key], name, lo, hi)
    if chosen["show_hi"] <= chosen["show_lo"]:
        raise Invalid("显色上限须大于下限。")
    if chosen["palette"] not in PALETTES:
        raise Invalid("请选择一种调色板。")
    width, height = panel["width"], panel["height"]
    chosen["inspect"] = rectangle(chosen["inspect"], width, height, "检查区")
    chosen["reference"] = rectangle(chosen["reference"], width, height, "参考区")
    trace = coordinates(chosen["trace"], (width - 1, height - 1, width - 1, height - 1), "温度剖线")
    if trace[:2] == trace[2:]:
        raise Invalid("剖线起点与终点应分开。")
    chosen["trace"] = trace
    chosen["min_area"] = integer(chosen["min_area"], "最小面积像素数", 1, width * height)
    chosen["bins"] = integer(chosen["bins"], "温度分组数", 2, 40)
    chosen.setdefault("reference_window", None)
    chosen["reference_window"] = reference_window(chosen["reference_window"], width, height, chosen["reference"])
    return chosen


def mode(value):
    if not isinstance(value, str) or value not in MODES:
        raise Invalid("请选一项检查。")
    return value
