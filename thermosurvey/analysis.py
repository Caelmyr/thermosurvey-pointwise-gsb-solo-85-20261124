"""Reduce sensor temperatures without using palette pixels or missing samples."""

from math import ceil, hypot

import numpy as np
from scipy import ndimage

from .model import MODES


def box_data(temperatures, box):
    x0, y0, x1, y1 = box
    return temperatures[y0:y1, x0:x1]


def focus(box):
    x0, y0, x1, y1 = box
    return [(x0 + x1 - 1) // 2, (y0 + y1 - 1) // 2]


def clean_number(value, digits=3):
    return round(float(value), digits) if np.isfinite(value) else None


def box_summary(temperatures, box):
    view = box_data(temperatures, box)
    samples = view[np.isfinite(view)]
    row = {"box": box, "point": focus(box), "valid": int(samples.size),
           "coverage": round(samples.size / view.size * 100, 2),
           "min": None, "mid": None, "max": None, "spread": None}
    if samples.size:
        lo, q25, mid, q75, hi = np.percentile(samples, [0, 25, 50, 75, 100])
        row.update(min=clean_number(lo), mid=clean_number(mid), max=clean_number(hi),
                   spread=clean_number(q75 - q25))
    return row


def region(temperatures, settings):
    row = box_summary(temperatures, settings["inspect"])
    row.update(name="检查区", area=clean_number(row["valid"] * settings["mm_per_pixel"] ** 2, 2))
    return [row], {}


def reference(temperatures, settings):
    row = box_summary(temperatures, settings["reference"])
    row["name"] = "当前参考区"
    return [row], {"reference_box": settings["reference"]}


def cold(temperatures, settings):
    reference_box = settings["reference"]
    area = settings["inspect"]
    reference_data = box_data(temperatures, reference_box)
    measured = reference_data[np.isfinite(reference_data)]
    meta = {"reference_box": reference_box, "reference": None, "threshold": None,
            "reference_valid": int(measured.size),
            "reference_coverage": round(measured.size / reference_data.size * 100, 2)}
    if not measured.size:
        return [], meta
    middle = np.median(measured)
    threshold = middle - settings["delta"]
    meta.update(reference=clean_number(middle), threshold=clean_number(threshold))
    view = box_data(temperatures, area)
    cold_mask = np.isfinite(view) & (view <= threshold)
    labels, count = ndimage.label(cold_mask)
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    rows = []
    x0, y0 = area[:2]
    boxes = ndimage.find_objects(labels)
    for component in sorted(np.flatnonzero(sizes[1:] >= settings["min_area"]) + 1,
                            key=lambda item: (-sizes[item], item))[:80]:
        ys, xs = boxes[component - 1]
        local = (labels[ys, xs] == component)
        shaded = np.where(local, view[ys, xs], np.inf)
        py, px = np.unravel_index(shaded.argmin(), shaded.shape)
        low = shaded[py, px]
        box = [x0 + xs.start, y0 + ys.start, x0 + xs.stop, y0 + ys.stop]
        rows.append({
            "name": f"低温区 {len(rows) + 1}", "box": box, "point": [box[0] + int(px), box[1] + int(py)],
            "pixels": int(sizes[component]), "area": clean_number(sizes[component] * settings["mm_per_pixel"] ** 2, 2),
            "min": clean_number(low), "drop": clean_number(middle - low),
        })
    meta["omitted"] = max(0, int(np.count_nonzero(sizes[1:] >= settings["min_area"])) - len(rows))
    return rows, meta


def warm(after, before, settings):
    """Find rewarmed regions inside the inspection box, comparing only pixels measured in both frames."""
    area = settings["inspect"]
    view_after = box_data(after, area)
    view_before = box_data(before, area)
    both = np.isfinite(view_after) & np.isfinite(view_before)
    comparable = int(np.count_nonzero(both))
    meta = {"threshold": settings["warm_delta"], "comparable": comparable,
            "coverage": round(comparable / view_after.size * 100, 2),
            "omitted": 0, "recommendation": None}
    lift = np.where(both, view_after - view_before, -np.inf)
    labels, count = ndimage.label(lift >= settings["warm_delta"])
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    rows = []
    x0, y0 = area[:2]
    boxes = ndimage.find_objects(labels)
    for component in sorted(np.flatnonzero(sizes[1:] >= settings["min_area"]) + 1,
                            key=lambda item: (-sizes[item], item))[:80]:
        ys, xs = boxes[component - 1]
        local = (labels[ys, xs] == component)
        shaded = np.where(local, lift[ys, xs], -np.inf)
        py, px = np.unravel_index(shaded.argmax(), shaded.shape)
        box = [x0 + xs.start, y0 + ys.start, x0 + xs.stop, y0 + ys.stop]
        rows.append({
            "name": f"回暖区 {len(rows) + 1}", "box": box, "point": [box[0] + int(px), box[1] + int(py)],
            "pixels": int(sizes[component]), "area": clean_number(sizes[component] * settings["mm_per_pixel"] ** 2, 2),
            "mid": clean_number(np.median(shaded[local])), "peak": clean_number(shaded[py, px]),
        })
    meta["omitted"] = max(0, int(np.count_nonzero(sizes[1:] >= settings["min_area"])) - len(rows))
    if rows:
        recommend(rows, meta)
    return rows, meta


def recommend(rows, meta):
    """Recommend one rewarmed region, preferring the aspect that dominates more clearly."""
    magnitude = max(rows, key=lambda row: row["mid"])
    coverage = max(rows, key=lambda row: row["pixels"])
    if magnitude is coverage:
        chosen, reason = magnitude, "both"
    elif magnitude["mid"] / coverage["mid"] >= coverage["pixels"] / magnitude["pixels"]:
        chosen, reason = magnitude, "magnitude"
    else:
        chosen, reason = coverage, "coverage"
    chosen["recommended"] = True
    meta["recommendation"] = {"name": chosen["name"], "point": chosen["point"], "box": chosen["box"],
                              "reason": reason, "mid": chosen["mid"], "pixels": chosen["pixels"]}


def probes(after, before, settings, points):
    """Read the same pixel in both frames; positions outside the compared box stay blank."""
    x0, y0, x1, y1 = settings["inspect"]
    rows = []
    for x, y in points:
        inside = x0 <= x < x1 and y0 <= y < y1
        later = clean_number(after[y, x]) if inside else None
        earlier = clean_number(before[y, x]) if inside else None
        rows.append({"point": [int(x), int(y)], "before": earlier, "after": later,
                     "lift": clean_number(after[y, x] - before[y, x])
                     if earlier is not None and later is not None else None})
    return rows


def profile(temperatures, settings):
    x0, y0, x1, y1 = settings["trace"]
    length = hypot(x1 - x0, y1 - y0)
    steps = ceil(length)
    samples = np.linspace(0, 1, steps + 1)
    xx = np.rint(x0 + samples * (x1 - x0)).astype(int)
    yy = np.rint(y0 + samples * (y1 - y0)).astype(int)
    scale = settings["mm_per_pixel"]
    rows = [{"point": [int(x), int(y)], "distance": clean_number(fraction * length * scale),
             "temperature": clean_number(temperatures[y, x])}
            for x, y, fraction in zip(xx, yy, samples)]
    return rows, {"length": clean_number(length * scale), "valid": sum(row["temperature"] is not None for row in rows)}


def distribution(temperatures, settings):
    area = settings["inspect"]
    view = box_data(temperatures, area)
    valid = np.isfinite(view)
    lo, hi = settings["show_lo"], settings["show_hi"]
    edges = np.linspace(lo, hi, settings["bins"] + 1)
    inner, _ = np.histogram(view[valid], bins=edges)
    counts = [np.count_nonzero(valid & (view < lo)), *inner, np.count_nonzero(valid & (view > hi))]
    boundaries = [None, *edges, None]
    rows = []
    for i, count in enumerate(counts):
        low, high = boundaries[i:i + 2]
        name = f"低于 {lo:g}" if low is None else f"高于 {hi:g}" if high is None else f"{low:.2f} – {high:.2f}"
        rows.append({"name": name, "pixels": int(count), "point": None})
    return rows, {"valid": int(np.count_nonzero(valid)), "missing": int(np.count_nonzero(~valid))}


OPERATIONS = {"region": region, "reference": reference, "cold": cold, "profile": profile, "distribution": distribution}
COLUMNS = {
    "region": {"name": "区域", "valid": "有效像素", "coverage": "覆盖 %", "min": "最低 °C",
               "mid": "中位 °C", "max": "最高 °C", "area": "有效面积 mm²"},
    "reference": {"name": "区域", "valid": "有效像素", "coverage": "覆盖 %", "min": "最低 °C",
                  "mid": "中位 °C", "max": "最高 °C", "spread": "四分位距 °C"},
    "cold": {"name": "区域", "pixels": "低温像素", "area": "面积 mm²", "min": "最低 °C", "drop": "最大温差 °C"},
    "warm": {"name": "区域", "pixels": "回暖像素", "area": "面积 mm²", "mid": "回暖中位 °C", "peak": "最大回暖 °C"},
    "profile": {"distance": "距起点 mm", "temperature": "温度 °C"},
    "distribution": {"name": "温区 °C", "pixels": "有效像素"},
}


def report(temperatures, mode, settings, baseline=None):
    if mode == "warm":
        rows, meta = warm(temperatures, baseline, settings)
    else:
        rows, meta = OPERATIONS[mode](temperatures, settings)
    return {"mode": mode, "heading": MODES[mode], "settings": settings,
            "columns": COLUMNS[mode], "rows": rows, "meta": meta}
