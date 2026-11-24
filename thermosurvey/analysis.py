"""Reduce sensor temperatures without using palette pixels or missing samples."""

from math import ceil, hypot

import numpy as np
from scipy import ndimage

from .model import MODES

WINDOW_COVERAGE = 90.0


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
    rows = [row]
    meta = {"reference_box": settings["reference"], "reference_window": None}
    window = settings.get("reference_window")
    if window is not None and window_usable(temperatures, window):
        note = box_summary(temperatures, window["box"])
        note["name"] = "参考方窗"
        note["side_mm"] = window["side_mm"]
        rows.append(note)
        meta["reference_window"] = window
    return rows, meta


def _integral(mask):
    return np.pad(mask.astype(np.float64), ((1, 0), (1, 0))).cumsum(0).cumsum(1)


def _rect_sum(integral, x0, y0, x1, y1):
    return integral[y1, x1] - integral[y0, x1] - integral[y1, x0] + integral[y0, x0]


def window_record(view, valid_integral, sum_integral, sq_integral, x, y, side,
                  inspect, mm_per_pixel, origin=(0, 0)):
    x0, y0, x1, y1 = x, y, x + side, y + side
    count = int(_rect_sum(valid_integral, x0, y0, x1, y1))
    total = side * side
    samples = view[y0:y1, x0:x1]
    samples = samples[np.isfinite(samples)]
    temperature_sum = _rect_sum(sum_integral, x0, y0, x1, y1)
    square_sum = _rect_sum(sq_integral, x0, y0, x1, y1)
    variance = max(0.0, square_sum / count - (temperature_sum / count) ** 2)
    ix0, iy0, ix1, iy1 = inspect
    ox, oy = origin
    gx0, gy0, gx1, gy1 = x0 + ox, y0 + oy, x1 + ox, y1 + oy
    gap_x = max(0, max(ix0, gx0) - min(ix1, gx1))
    gap_y = max(0, max(iy0, gy0) - min(iy1, gy1))
    gap = hypot(gap_x, gap_y) * mm_per_pixel
    return {
        "box": [x0, y0, x1, y1], "point": [(x0 + x1 - 1) // 2, (y0 + y1 - 1) // 2],
        "valid": count, "coverage": round(count / total * 100, 2),
        "median": clean_number(np.median(samples)), "min": clean_number(np.min(samples)),
        "max": clean_number(np.max(samples)), "std": clean_number(np.sqrt(variance)),
        "gap_mm": clean_number(gap),
    }


def window_options(temperatures, settings, side_mm):
    """Scan square windows fully inside the reference area and rank candidates."""
    rx0, ry0, rx1, ry1 = settings["reference"]
    view = box_data(temperatures, settings["reference"])
    ref_h, ref_w = view.shape
    scale = settings["mm_per_pixel"]
    side = max(1, int(round(side_mm / scale)))
    meta = {"side_mm": clean_number(side_mm), "side_px": side,
            "actual_side_mm": clean_number(side * scale),
            "coverage_required": WINDOW_COVERAGE, "candidates": [],
            "recommended": None, "message": ""}
    if side > min(ref_w, ref_h):
        meta["message"] = "方窗边长超过参考区的短边，放不下整块方窗；继续使用整块参考区的判读。"
        return meta
    valid = np.isfinite(view)
    filled = np.where(valid, view, 0.0)
    valid_integral = _integral(valid)
    sum_integral = _integral(filled)
    sq_integral = _integral(filled * filled)
    nx, ny = ref_w - side + 1, ref_h - side + 1
    xx, yy = np.meshgrid(np.arange(nx), np.arange(ny))
    x1, y1 = xx + side, yy + side
    counts = (_rect_sum(valid_integral, xx, yy, x1, y1)).astype(int)
    eligible = counts * 100 >= WINDOW_COVERAGE * side * side
    if not np.any(eligible):
        meta["message"] = "参考区内没有覆盖达到九成的方窗位置；继续使用整块参考区的判读。"
        return meta
    ix0, iy0, ix1, iy1 = settings["inspect"]
    gx = np.maximum(0, np.maximum(ix0 - rx0 - x1, xx - (ix1 - rx0)))
    gy = np.maximum(0, np.maximum(iy0 - ry0 - y1, yy - (iy1 - ry0)))
    gaps = np.hypot(gx, gy)
    sums = _rect_sum(sum_integral, xx, yy, x1, y1)
    squares = _rect_sum(sq_integral, xx, yy, x1, y1)
    with np.errstate(divide="ignore", invalid="ignore"):
        means = np.divide(sums, counts, out=np.zeros_like(sums), where=counts > 0)
        variance = np.divide(squares, counts, out=np.zeros_like(squares), where=counts > 0) - means ** 2
    stds = np.sqrt(np.maximum(0.0, np.where(eligible, variance, 0.0)))
    flat = np.flatnonzero(eligible.ravel())
    near_order = flat[np.lexsort((flat % nx, gaps.ravel()[flat]))]
    uniform_order = flat[np.lexsort((gaps.ravel()[flat], flat % nx, stds.ravel()[flat]))]
    near_pos, uniform_pos = int(near_order[0]), int(uniform_order[0])

    def describe(position, tag):
        y, x = np.unravel_index(position, (ny, nx))
        record = window_record(view, valid_integral, sum_integral, sq_integral,
                               int(x), int(y), side, settings["inspect"], scale,
                               origin=(rx0, ry0))
        record["box"] = [rx0 + record["box"][0], ry0 + record["box"][1],
                         rx0 + record["box"][2], ry0 + record["box"][3]]
        record["point"] = [rx0 + record["point"][0], ry0 + record["point"][1]]
        record["choice"] = tag
        return record

    near = describe(near_pos, "near")
    candidates = [near]
    if uniform_pos != near_pos:
        uniform = describe(uniform_pos, "uniform")
        candidates.append(uniform)
        near_std, uniform_std = float(near["std"]), float(uniform["std"])
        if near_std <= uniform_std * 1.5:
            recommended, message = near, (
                "先推荐贴近检查区的方窗：局部墙体条件更接近检查区；"
                f"它的温度标准差 {near_std:.3f} °C 与更均匀方窗的 {uniform_std:.3f} °C 相差不大。"
                "若复查时希望读数更稳，可改选更均匀的方窗。")
        else:
            recommended, message = uniform, (
                f"贴近检查区方窗的温度标准差 {near_std:.3f} °C，"
                f"明显大于更均匀方窗的 {uniform_std:.3f} °C（约 {near_std / uniform_std:.1f} 倍）；"
                "先推荐更均匀的方窗以稳定参考读数，代价是离检查区更远、局部代表性弱一些。")
    else:
        recommended = near
        message = "参考区内只有一个覆盖达标的方窗位置，就近与均匀推荐相同。"
    meta.update(candidates=candidates, recommended=recommended["choice"], message=message)
    return meta


def window_usable(temperatures, window):
    """Re-check a saved window against the source pixels before reusing it."""
    box = window.get("box")
    if not (isinstance(box, list) and len(box) == 4):
        return False
    x0, y0, x1, y1 = box
    if not (isinstance(x0, int) and isinstance(y0, int) and isinstance(x1, int)
            and isinstance(y1, int) and x1 > x0 and y1 > y0 and x1 - x0 == y1 - y0):
        return False
    if x0 < 0 or y0 < 0 or x1 > temperatures.shape[1] or y1 > temperatures.shape[0]:
        return False
    view = temperatures[y0:y1, x0:x1]
    return view.size > 0 and np.isfinite(view).sum() * 100 >= WINDOW_COVERAGE * view.size


def cold(temperatures, settings):
    reference_box = settings["reference"]
    area = settings["inspect"]
    window = settings.get("reference_window")
    window_active = window is not None and window_usable(temperatures, window)
    meta = {"reference_box": reference_box, "reference": None, "threshold": None,
            "reference_valid": 0, "reference_coverage": None,
            "reference_window": window if window_active else None,
            "window_fallback": bool(window is not None and not window_active),
            "reserved_pixels": 0, "reserved_valid": 0}
    if window_active:
        window_view = box_data(temperatures, window["box"])
        measured = window_view[np.isfinite(window_view)]
        meta["reference_valid"] = int(measured.size)
        meta["reference_coverage"] = round(measured.size / window_view.size * 100, 2)
        middle = float(np.median(measured))
        wx0, wy0, wx1, wy1 = window["box"]
        ix0, iy0, ix1, iy1 = area
        ox0, oy0 = max(wx0, ix0), max(wy0, iy0)
        ox1, oy1 = min(wx1, ix1), min(wy1, iy1)
        if ox0 < ox1 and oy0 < oy1:
            overlap = temperatures[oy0:oy1, ox0:ox1]
            meta["reserved_pixels"] = int(overlap.size)
            meta["reserved_valid"] = int(np.count_nonzero(np.isfinite(overlap)))
    else:
        reference_data = box_data(temperatures, reference_box)
        measured = reference_data[np.isfinite(reference_data)]
        meta["reference_valid"] = int(measured.size)
        meta["reference_coverage"] = round(measured.size / reference_data.size * 100, 2)
        if not measured.size:
            return [], meta
        middle = float(np.median(measured))
    if not measured.size:
        return [], meta
    threshold = middle - settings["delta"]
    meta.update(reference=clean_number(middle), threshold=clean_number(threshold))
    view = box_data(temperatures, area)
    cold_mask = np.isfinite(view) & (view <= threshold)
    if window_active and meta["reserved_pixels"]:
        x0, y0 = area[:2]
        reserve = np.zeros_like(cold_mask)
        reserve[max(0, oy0 - y0):max(0, oy1 - y0), max(0, ox0 - x0):max(0, ox1 - x0)] = True
        cold_mask &= ~reserve
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
    "profile": {"distance": "距起点 mm", "temperature": "温度 °C"},
    "distribution": {"name": "温区 °C", "pixels": "有效像素"},
}


def report(temperatures, mode, settings):
    rows, meta = OPERATIONS[mode](temperatures, settings)
    return {"mode": mode, "heading": MODES[mode], "settings": settings,
            "columns": COLUMNS[mode], "rows": rows, "meta": meta}
