"""Reduce sensor temperatures without using palette pixels or missing samples."""

from math import ceil, hypot

import numpy as np
from scipy import ndimage

from image_lab.validation import Invalid

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


def cold_segments(rows, threshold):
    """Below-threshold runs; a single missing sample may be bridged, longer gaps may not."""
    temps = [row["temperature"] for row in rows]
    runs = []
    start = prev = None
    for index, temp in enumerate(temps):
        if temp is None or temp > threshold:
            continue
        if start is None:
            start = index
        elif index - prev > 2 or (index - prev == 2 and temps[prev + 1] is not None):
            runs.append((start, prev))
            start = index
        prev = index
    if start is not None:
        runs.append((start, prev))
    segments = []
    last = len(rows) - 1
    for low, high in runs:
        inside = temps[low:high + 1]
        measured = [temp for temp in inside if temp is not None]
        left_warm = low > 0 and temps[low - 1] is not None
        right_warm = high < last and temps[high + 1] is not None
        eligible = left_warm and right_warm
        if low == 0 or high == last:
            note = "剖线端头截断，不报宽度"
        elif not eligible:
            note = "边界缺测，不报宽度"
        else:
            note = None
        segments.append({
            "name": f"第 {len(segments) + 1} 段", "start": low, "end": high,
            "from": low - 1 if left_warm else low, "to": high + 1 if right_warm else high,
            "start_distance": rows[low]["distance"], "end_distance": rows[high]["distance"],
            "width": clean_number(rows[high]["distance"] - rows[low]["distance"]) if eligible else None,
            "min": clean_number(min(measured)), "samples": len(measured),
            "gaps": len(inside) - len(measured),
            "points": [rows[low]["point"], rows[high]["point"]],
            "eligible": eligible, "note": note,
        })
    return segments


def rank_segment(segment):
    return (segment["width"], -segment["min"], -segment["gaps"])


def segment_reason(segments, best):
    if not segments:
        return "剖线上没有低于门槛的读数。"
    eligible = [segment for segment in segments if segment["eligible"]]
    if not eligible:
        return "低于门槛的冷段未在两侧取得较暖边界（端头截断或边界缺测），不报宽度。"
    parts = [f"推荐量{best['name']}（{best['start_distance']}–{best['end_distance']} mm），"
             f"宽 {best['width']} mm，最低 {best['min']} °C"]
    if best["gaps"]:
        parts.append(f"段内 {best['gaps']} 处单点缺测，缺测两侧均为实测低温读数，未跨越多点缺测")
    else:
        parts.append("段内读数连续")
    others = [segment for segment in eligible if segment is not best]
    if others:
        alt = max(others, key=rank_segment)
        detail = "连续无缺测" if not alt["gaps"] else f"含 {alt['gaps']} 处单点缺测"
        if alt["width"] < best["width"]:
            parts.append(f"{alt['name']}宽 {alt['width']} mm、{detail}、最低 {alt['min']} °C，"
                         "冷读数也可信但覆盖冷带较窄，量宽取最宽一段")
        else:
            parts.append(f"{alt['name']}同宽、{detail}，但最低 {alt['min']} °C 更接近门槛，量宽取更冷一段")
    return "；".join(parts) + "。"


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
    threshold = settings["band_threshold"]
    segments = cold_segments(rows, threshold)
    best = max((segment for segment in segments if segment["eligible"]), key=rank_segment, default=None)
    return rows, {"length": clean_number(length * scale),
                  "valid": sum(row["temperature"] is not None for row in rows),
                  "threshold": clean_number(threshold), "segments": segments,
                  "recommend": segments.index(best) if best is not None else None,
                  "reason": segment_reason(segments, best)}


def adopt(report, measure):
    if not isinstance(measure, dict):
        raise Invalid("量宽冷段选择无效。")
    start, end = measure.get("start"), measure.get("end")
    if isinstance(start, bool) or isinstance(end, bool) or not isinstance(start, int) or not isinstance(end, int):
        raise Invalid("量宽冷段选择无效。")
    for segment in report["meta"].get("segments", []):
        if segment["eligible"] and segment["start"] == start and segment["end"] == end:
            report["meta"]["measurement"] = segment
            return report
    raise Invalid("所选冷段与当前剖线不符，请重新量宽。")


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
    "profile": {"distance": "距起点 mm", "temperature": "温度 °C"},
    "distribution": {"name": "温区 °C", "pixels": "有效像素"},
}


def report(temperatures, mode, settings):
    rows, meta = OPERATIONS[mode](temperatures, settings)
    return {"mode": mode, "heading": MODES[mode], "settings": settings,
            "columns": COLUMNS[mode], "rows": rows, "meta": meta}
