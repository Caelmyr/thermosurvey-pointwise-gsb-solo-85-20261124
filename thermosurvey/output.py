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
        out.writerow(["参考中位 °C", meta["reference"], "低温门槛 °C", meta["threshold"],
                      "参考覆盖 %", meta["reference_coverage"]])
    if report["mode"] == "warm":
        meta = report["meta"]
        out.writerow([])
        out.writerow(["最小回暖温差 °C", meta["threshold"], "可比较像素", meta["comparable"],
                      "占检查框 %", meta["coverage"]])
        recommendation = meta.get("recommendation")
        if recommendation:
            reasons = {"magnitude": "回暖幅度", "coverage": "覆盖", "both": "回暖幅度与覆盖"}
            out.writerow(["推荐回看", recommendation["name"], "本次看重", reasons[recommendation["reason"]]])
    return buffer.getvalue()


def overlay(temperatures, report):
    settings = report["settings"]
    image = paint(temperatures, settings)
    draw = ImageDraw.Draw(image)
    width = max(1, min(image.size) // 180)
    for box, color in [(settings["inspect"], "#f2dac2"), (settings["reference"], "#5addca")]:
        draw.rectangle((box[0], box[1], box[2] - 1, box[3] - 1), outline=color, width=width)
    if report["mode"] == "profile":
        draw.line(settings["trace"], fill="#fcf176", width=width)
    if report["mode"] in ("cold", "warm"):
        for index, row in enumerate(report["rows"], 1):
            x0, y0, x1, y1 = row["box"]
            color = "#f7c873" if row.get("recommended") else "#fbf7ed"
            draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline=color, width=width)
            draw.text((x0 + width, y0 + width), str(index), fill=color,
                      stroke_width=1, stroke_fill="#221926")
    return image
