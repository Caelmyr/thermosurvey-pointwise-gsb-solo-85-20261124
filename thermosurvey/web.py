"""Thermogram intake, normal checks, exports and visible-light preparation transfer."""

from io import BytesIO
from pathlib import Path

from flask import Blueprint, Response, jsonify, render_template, request, send_file
from werkzeug.exceptions import NotFound

from image_lab.validation import Invalid

from . import analysis, demo, frame, model, output
from .store import Library


def payload():
    return model.document(request.get_json(silent=True))


def prepare_report(library, panel, chosen, mode):
    return analysis.report(frame.temperature(library.source(panel), chosen), mode, chosen)


def png_response(image, name=None):
    return send_file(BytesIO(frame.png(image)), mimetype="image/png", as_attachment=name is not None,
                     download_name=name, max_age=0)


def install(app, path):
    library = Library(path)
    api = Blueprint("thermosurvey", __name__, url_prefix="/thermal")

    @app.get("/")
    def desk():
        return render_template("thermosurvey.html")

    @api.get("/health")
    def health():
        return jsonify(status="ready", service="thermosurvey")

    @api.get("/config")
    def config():
        return jsonify(modes=model.MODES, palettes=list(model.PALETTES))

    @api.get("/panels")
    def panels():
        return jsonify(library.list())

    @api.post("/demo")
    def sample():
        return jsonify(demo.create(library)), 201

    @api.post("/panels")
    def upload():
        file = request.files.get("file")
        if file is None:
            raise Invalid("请先选择热图。")
        filename = model.label(Path(file.filename).name, "原文件名")
        title = model.label(request.form.get("title") or Path(filename).stem)
        image = frame.radiometric(file.stream.read(model.MAX_UPLOAD + 1))
        return jsonify(library.create(title, filename, frame.png(image), image.size,
                                      model.defaults(*image.size))), 201

    @api.get("/panels/<panel_id>")
    def panel(panel_id):
        return jsonify(library.panel(panel_id))

    @api.get("/panels/<panel_id>/raw.png")
    def raw(panel_id):
        return send_file(library.source(library.panel(panel_id)), mimetype="image/png",
                         as_attachment=True, download_name="radiometric.png")

    @api.get("/panels/<panel_id>/context.png")
    def context(panel_id):
        record = library.panel(panel_id)
        detail = library.check(panel_id, request.args["check"]) if request.args.get("check") else record
        if not detail["context"]:
            raise NotFound("这份检查没有现场底图。")
        return send_file(library.source(detail["context"]), mimetype="image/png", max_age=0)

    @api.post("/panels/<panel_id>/context")
    def upload_context(panel_id):
        file = request.files.get("file")
        if file is None:
            raise Invalid("请选择一张现场照片。")
        content, size = frame.visible_light(file.stream.read(model.MAX_UPLOAD + 1))
        try:
            revision = int(request.form.get("revision", ""))
        except ValueError:
            raise Invalid("请重新打开这张热图。") from None
        title = model.label(Path(file.filename).name, "现场照片文件名")
        return jsonify(library.attach_context(panel_id, revision, content, size, title, {"kind": "upload"}))

    @api.post("/panels/<panel_id>/prepared")
    def prepared(panel_id):
        value = payload()
        project_id = model.label(value.get("project"), "准备工程 ID")
        result_id = model.label(value.get("result"), "准备结果 ID")
        results = app.extensions["results"]
        meta = results.metadata(project_id, result_id)
        if meta["stale"]:
            raise Invalid("请更新准备结果后再导入。")
        content, size = frame.visible_light(results.image_path(project_id, "image", result_id))
        title = model.label(meta.get("name") or "准备区处理照片")
        tags = {"kind": "prepared", "project": project_id, "result": result_id}
        return jsonify(library.attach_context(panel_id, value.get("revision"), content, size, title, tags))

    @api.put("/panels/<panel_id>/settings")
    def revise(panel_id):
        value = payload()
        record = library.panel(panel_id)
        return jsonify(library.revise(panel_id, value.get("revision"), model.settings(value.get("settings"), record)))

    @api.post("/panels/<panel_id>/windows")
    def windows(panel_id):
        value = payload()
        record = library.panel(panel_id)
        chosen = model.settings(value.get("settings", {}), record)
        side_mm = model.number(value.get("side_mm"), "方窗实际边长", 0.01, 1_000_000)
        return jsonify(analysis.window_options(frame.temperature(library.source(record), chosen),
                                               chosen, side_mm))

    @api.post("/panels/<panel_id>/preview")
    def preview(panel_id):
        value = payload()
        record = library.panel(panel_id)
        chosen = model.settings(value.get("settings", {}), record)
        return jsonify(prepare_report(library, record, chosen, model.mode(value.get("mode"))))

    @api.post("/panels/<panel_id>/view.png")
    def view(panel_id):
        record = library.panel(panel_id)
        chosen = model.settings(payload().get("settings", {}), record)
        return png_response(frame.paint(frame.temperature(library.source(record), chosen), chosen))

    @api.post("/panels/<panel_id>/checks")
    def save(panel_id):
        value = payload()
        record = library.panel(panel_id)
        revision = value.get("revision")
        library.require_revision(record, revision)
        chosen = model.settings(value.get("settings"), record)
        report = prepare_report(library, record, chosen, model.mode(value.get("mode")))
        current, saved = library.retain(panel_id, revision, report)
        return jsonify(panel=current, check=saved), 201

    @api.get("/panels/<panel_id>/checks/<check_id>")
    def open_check(panel_id, check_id):
        return jsonify(library.check(panel_id, check_id))

    @api.get("/panels/<panel_id>/checks/<check_id>/report.csv")
    def csv_report(panel_id, check_id):
        report = library.check(panel_id, check_id)
        return Response(output.csv_text(report), mimetype="text/csv",
                        headers={"Content-Disposition": f'attachment; filename="thermal-{report["mode"]}.csv"'})

    @api.get("/panels/<panel_id>/checks/<check_id>/overlay.png")
    def png_report(panel_id, check_id):
        report = library.check(panel_id, check_id)
        temperatures = frame.temperature(library.source(report), report["settings"])
        return png_response(output.overlay(temperatures, report), "thermogram-annotated.png")

    app.register_blueprint(api)
