"""Export archived readings and locate their geometry in the saved thermogram."""

from csv import writer
from io import StringIO

from PIL import ImageDraw

from .frame import paint


def csv_text(report):
    buffer = StringIO()
    out = writer(buffer)
    out.writerow(report["columns"].values())
    for row in report["rows"]:
        out.writerow(row.get(key) for key in report["columns"])
    if report["mode"] == "cold":
        meta = report["meta"]
        out.writerow([])
        window = meta.get("reference_window")
        if window:
            out.writerow(["方窗边长 mm", window["side_mm"], "方窗范围", " ".join(map(str, window["box"])),
                          "方窗覆盖 %", meta["reference_coverage"], "留给参照像素", meta["reserved_pixels"]])
        out.writerow(["参考中位 °C", meta["reference"], "低温门槛 °C", meta["threshold"],
                      "参考覆盖 %", meta["reference_coverage"]])
    return buffer.getvalue()


def overlay(temperatures, report):
    settings = report["settings"]
    image = paint(temperatures, settings)
    draw = ImageDraw.Draw(image)
    width = max(1, min(image.size) // 180)
    for box, color in [(settings["inspect"], "#f2dac2"), (settings["reference"], "#5addca")]:
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), outline=color, width=width)
    window = settings.get("reference_window")
    if window:
        wx0, wy0, wx1, wy1 = window["box"]
        draw.rectangle((wx0, wy0, wx1 - 1, wy1 - 1), outline="#ffd166", width=max(1, width + 1))
    if report["mode"] == "profile":
        draw.line(settings["trace"], fill="#fcf176", width=width)
    if report["mode"] == "cold":
        for index, row in enumerate(report["rows"], 1):
            x0, y0, x1, y1 = row["box"]
            draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline="#fbf7ed", width=width)
            draw.text((x0 + width, y0 + width), str(index), fill="#fbf7ed",
                      stroke_width=1, stroke_fill="#221926")
    return image
