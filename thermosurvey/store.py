"""Revisioned thermal survey settings and immutable saved reports on local disk."""

from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
from pathlib import Path
from threading import RLock
from uuid import uuid4

from werkzeug.exceptions import Conflict, NotFound


def stamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def write_bytes(path, payload):
    temp = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        temp.write_bytes(payload)
        temp.replace(path)
    finally:
        temp.unlink(missing_ok=True)


def write_document(path, value):
    write_bytes(path, json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())


def read_document(path):
    if not path.is_file():
        raise NotFound("找不到热图或检查记录。")
    return json.loads(path.read_text())


def identifier(value):
    if not isinstance(value, str) or len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
        raise NotFound("找不到热图或检查记录。")
    return value


class Library:
    def __init__(self, path):
        self.root = Path(path)
        self.panels = self.root / "panels"
        self.blobs = self.root / "sources"
        self.checks = self.root / "checks"
        for directory in (self.panels, self.blobs, self.checks):
            directory.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()

    def panel_path(self, panel_id):
        return self.panels / f"{identifier(panel_id)}.json"

    def panel(self, panel_id):
        return read_document(self.panel_path(panel_id))

    def source(self, panel):
        return self.blobs / f"{panel['source']}.png"

    def blob(self, image_bytes):
        fingerprint = sha256(image_bytes).hexdigest()
        path = self.source({"source": fingerprint})
        if not path.exists():
            write_bytes(path, image_bytes)
        return fingerprint

    def attach_context(self, panel_id, revision, image_bytes, size, title, provenance):
        with self.lock:
            record = self.panel(panel_id)
            self.require_revision(record, revision)
            record["context"] = {"source": self.blob(image_bytes), "width": size[0], "height": size[1],
                                 "title": title, "provenance": provenance}
            record["revision"] += 1
            write_document(self.panel_path(panel_id), record)
        return record

    def list(self):
        entries = (read_document(path) for path in self.panels.glob("*.json"))
        return sorted(entries, key=lambda record: (record["created"], record["id"]), reverse=True)

    def create(self, title, filename, image_bytes, size, settings, provenance=None):
        value = {
            "id": uuid4().hex, "title": title, "filename": filename,
            "width": size[0], "height": size[1], "created": stamp(), "revision": 1,
            "settings": deepcopy(settings), "checks": [], "provenance": provenance or {"kind": "upload"}, "context": None,
        }
        with self.lock:
            value["source"] = self.blob(image_bytes)
            write_document(self.panel_path(value["id"]), value)
        return value

    @staticmethod
    def require_revision(record, expected):
        if isinstance(expected, bool) or not isinstance(expected, int) or record["revision"] != expected:
            raise Conflict("热图设置已有更新，请重新打开照片。")

    def revise(self, panel_id, revision, settings):
        with self.lock:
            record = self.panel(panel_id)
            self.require_revision(record, revision)
            record["settings"] = settings
            record["revision"] += 1
            write_document(self.panel_path(panel_id), record)
        return record

    def retain(self, panel_id, revision, result):
        with self.lock:
            record = self.panel(panel_id)
            self.require_revision(record, revision)
            saved = {**result, "id": uuid4().hex, "title": record["title"], "panel_id": panel_id,
                     "source": record["source"], "context": record["context"],
                     "created": stamp(), "source_revision": revision}
            write_document(self.checks / f"{saved['id']}.json", saved)
            record["checks"].insert(0, {key: saved[key] for key in ("id", "created", "mode", "heading")})
            record["revision"] += 1
            write_document(self.panel_path(panel_id), record)
            return record, saved

    def check(self, panel_id, check_id):
        record = self.panel(panel_id)
        check_id = identifier(check_id)
        if not any(row["id"] == check_id for row in record["checks"]):
            raise NotFound("找不到这份检查记录。")
        return read_document(self.checks / f"{check_id}.json")
