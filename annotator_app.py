#!/usr/bin/env python3
"""
annotator_app.py - Swish Annotator: a local web app to build a detection dataset with Claude + manual review.

    C:\\Users\\pc\\.conda\\envs\\myenv\\python.exe annotator/annotator_app.py          (opens http://127.0.0.1:8765)
    ... --root D:/datasets/swish --port 8765 --no-browser

Workflow:
  1. Project: a folder under --root (default annotator/projects/<name>) with images/, labels/ (YOLO), raw/
     (Claude's answers), thumbs/, videos/ and project.json (classes, settings, per-image status).
  2. Import: upload videos (split into frames every N seconds of video time), upload images, or point at a folder /
     video on this PC. YOLO labels next to imported images are picked up (status "imported").
  3. Auto-label: Claude (claude_autolabel.label_image) boxes the images; they get status "auto" (= needs review).
     Backend "claude_code" (default) uses your Claude subscription through the Claude Code CLI (`claude -p`, no API
     key or credits, counts against the plan's usage limits; a run stops cleanly at the limit and "Images still to
     do" resumes it); backend "api" uses ANTHROPIC_API_KEY and API credits.
  4. Review: draw / move / resize / delete / re-class boxes in the browser, Enter marks an image "reviewed".
  5. Export: train / valid / test split (frames close in time from the same video stay in one split), written as
       <out>/data.yaml                          Ultralytics YOLO (yolo26 / yolo11): yolo detect train data=<out>/data.yaml
       <out>/{train,valid,test}/images|labels   YOLO labels
       <out>/{train,valid,test}/_annotations.coco.json   RF-DETR (Roboflow COCO layout): model.train(dataset_dir=<out>)
     COCO category 0 is a "basketball" supercategory and the classes are 1..N, like the Roboflow export the current
     RF-DETR checkpoint was trained on, so the pipeline's class_id_offset=-1 keeps working.

Image status: unlabeled (to do) -> auto (Claude, needs review) -> reviewed; imported = labels brought in with the image.
Credentials: the Claude Code login (subscription backend) or ANTHROPIC_API_KEY from the environment (api backend);
never printed or stored here.
"""

import argparse
import json
import os
import random
import re
import shutil
import threading
import time
import uuid
import webbrowser
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import List, Optional

import cv2
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel

import claude_autolabel as cal

HERE = Path(__file__).resolve().parent
STATIC = HERE / "static"
VIDEO_EXTS = {".mp4", ".avi", ".mov", ".mkv", ".m4v", ".webm"}
STATUSES = ("unlabeled", "auto", "reviewed", "imported")
THUMB_SIZE = (220, 160)
JPEG_QUALITY = 95
EXPORT_MARKER = ".swish_export"           # only folders carrying this marker are cleared on re-export
FRAME_RE = re.compile(r"^(?P<src>.+)_t(?P<ms>\d{8})$")   # video frames: <source>_t<ms since video start>

ROOT = HERE / "projects"
app = FastAPI(title="Swish Annotator")


# ----------------------------------------------------------------------------------------------------------- helpers
def safe_name(name):
    """A plain file / folder name (no path parts) or 400."""
    if not name or Path(name).name != name or name in (".", ".."):
        raise HTTPException(400, f"bad name: {name!r}")
    return name


def slug(text):
    return re.sub(r"[^A-Za-z0-9._-]+", "_", text).strip("._") or "item"


class Project:
    """One dataset folder. project.json is held in memory and written atomically under a lock."""

    _open = {}
    _open_lock = threading.Lock()

    def __init__(self, path):
        self.path = path
        self.lock = threading.RLock()
        for sub in ("images", "labels", "raw", "thumbs", "videos"):
            (path / sub).mkdir(parents=True, exist_ok=True)
        meta = path / "project.json"
        self.data = json.loads(meta.read_text()) if meta.exists() else {}
        self.data.setdefault("name", path.name)
        self.data.setdefault("created", time.strftime("%Y-%m-%d %H:%M:%S"))
        self.data.setdefault("classes", cal.class_specs(cal.DEFAULT_CLASSES))
        settings = self.data.setdefault("settings", {})
        if "backend" not in settings:                         # projects from before the backend switch
            settings.update(backend=cal.DEFAULT_BACKEND, tier="", workers=2)
        for k, v in {"backend": cal.DEFAULT_BACKEND, "model": cal.DEFAULT_MODEL, "effort": cal.DEFAULT_EFFORT,
                     "tier": "", "workers": 2, "scene": cal.SCENE_NOTE, "hint": ""}.items():
            settings.setdefault(k, v)                         # tier "" = the backend's default resolution
        status = self.data.setdefault("status", {})
        for f in sorted((path / "images").iterdir()):        # images copied in by hand count too
            if f.suffix.lower() in cal.IMG_EXTS and f.name not in status:
                status[f.name] = "auto" if (path / "labels" / f"{f.stem}.txt").exists() else "unlabeled"
        for name in [n for n in status if not (path / "images" / n).exists()]:
            del status[name]
        self.save()

    @classmethod
    def get(cls, name, create=False):
        safe_name(name)
        with cls._open_lock:
            if name not in cls._open:
                path = ROOT / name
                if not path.exists() and not create:
                    raise HTTPException(404, f"no project {name}")
                cls._open[name] = Project(path)
            return cls._open[name]

    def save(self):
        with self.lock:
            tmp = self.path / "project.json.tmp"
            self.data["updated"] = time.time()
            tmp.write_text(json.dumps(self.data, indent=1))
            os.replace(tmp, self.path / "project.json")

    @property
    def names(self):
        return [c["name"] for c in self.data["classes"]]

    def image(self, name):
        p = self.path / "images" / safe_name(name)
        if not p.exists():
            raise HTTPException(404, f"no image {name}")
        return p

    def label_path(self, name):
        return self.path / "labels" / f"{Path(name).stem}.txt"

    def set_status(self, name, status, save=True):
        with self.lock:
            self.data["status"][name] = status
            if save:
                self.save()

    def remove_image(self, name):
        """The image and everything derived from it (label, thumbnail, Claude's answer); caller saves."""
        stem = Path(name).stem
        for p in (self.path / "images" / name, self.label_path(name), self.path / "thumbs" / f"{stem}.jpg",
                  self.path / "raw" / f"{stem}.txt"):
            p.unlink(missing_ok=True)
        with self.lock:
            self.data["status"].pop(name, None)

    def write_boxes(self, name, boxes):
        lines = cal.yolo_lines(boxes)
        self.label_path(name).write_text("\n".join(lines) + ("\n" if lines else ""))

    def add_image(self, src_path=None, data=None, name=None, status="unlabeled", label_src=None):
        """Copy an image in (from a path, or encoded bytes); keeps stems unique. Returns the stored name, or None
        when that exact frame is already there."""
        name = slug(Path(name or src_path.name).stem) + Path(name or src_path.name).suffix.lower()
        stem, ext = Path(name).stem, Path(name).suffix
        with self.lock:
            taken = {Path(n).stem for n in self.data["status"]}
            if stem in taken and FRAME_RE.match(stem):
                return None                                   # re-importing the same video frame
            i = 2
            while stem in taken:
                stem = f"{Path(name).stem}_{i}"
                i += 1
            name = stem + ext
            dst = self.path / "images" / name
            if data is not None:
                dst.write_bytes(data)
            else:
                shutil.copy2(src_path, dst)
            if label_src is not None:
                shutil.copy2(label_src, self.label_path(name))
                status = "imported"
            self.data["status"][name] = status
        return name


# -------------------------------------------------------------------------------------------------------------- jobs
JOBS = {}


class Job:
    def __init__(self, kind, project, total=0):
        self.id = uuid.uuid4().hex[:10]
        self.kind, self.project = kind, project
        self.total, self.done, self.failed = total, 0, 0
        self.state, self.message, self.errors, self.result = "running", "", [], None
        self.cancel = False
        self.started = time.time()
        JOBS[self.id] = self

    def info(self):
        return {"id": self.id, "kind": self.kind, "project": self.project, "total": self.total, "done": self.done,
                "failed": self.failed, "state": self.state, "message": self.message, "errors": self.errors[-8:],
                "result": self.result, "elapsed": round(time.time() - self.started, 1)}

    def run(self, fn, *args):
        def target():
            try:
                fn(self, *args)
                if self.state == "running":
                    self.state = "cancelled" if self.cancel else "done"
            except Exception as e:                            # surfaced in the UI
                self.state, self.message = "error", f"{type(e).__name__}: {e}"
        threading.Thread(target=target, daemon=True).start()
        return self.info()


# ------------------------------------------------------------------------------------------------------------ import
def video_frames(path, every_s, start_s=0.0, end_s=0.0, max_frames=0):
    """(time_s, frame) every `every_s` seconds of video time (0 = every frame), from the container timestamps."""
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video {path}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    idx, next_t, kept = -1, start_s, 0
    try:
        while True:
            if not cap.grab():
                break
            idx += 1
            t = cap.get(cv2.CAP_PROP_POS_MSEC) / 1000.0
            if t <= 0 and idx > 0:
                t = idx / fps
            if t + 1e-6 < start_s:
                continue
            if end_s and t > end_s:
                break
            if every_s and t + 1e-6 < next_t:
                continue
            ok, frame = cap.retrieve()
            if not ok:
                continue
            yield t, frame
            kept += 1
            if max_frames and kept >= max_frames:
                break
            if every_s:
                while next_t <= t + 1e-6:
                    next_t += every_s
    finally:
        cap.release()


def video_estimate(path, every_s, start_s, end_s, max_frames):
    cap = cv2.VideoCapture(str(path))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    n = cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0
    cap.release()
    dur = n / fps if fps else 0
    span = max(0.0, (min(end_s, dur) if end_s else dur) - start_s)
    est = int(span / every_s) + 1 if every_s else int(span * fps)
    return min(est, max_frames) if max_frames else est


def import_videos(job, proj, videos, opts):
    for path, source in videos:
        job.message = f"splitting {path.name}"
        for t, frame in video_frames(path, opts["every_s"], opts["start_s"], opts["end_s"], opts["max_frames"]):
            if job.cancel:
                return
            ok, buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ok and proj.add_image(data=buf.tobytes(), name=f"{source}_t{int(round(t * 1000)):08d}.jpg"):
                job.done += 1                                 # (a frame already imported is skipped silently)
            if job.done % 25 == 0:
                proj.save()
    proj.save()


def find_label(img_path, folder):
    """A YOLO label for an imported image: <same folder>/<stem>.txt or the dataset's sibling labels/ tree."""
    rel = img_path.relative_to(folder)
    candidates = [img_path.with_suffix(".txt")]
    for base in (folder, *folder.parents[:2]):
        if base.name == "images":
            candidates.append(base.parent / "labels" / rel.with_suffix(".txt"))
    candidates.append(folder / "labels" / rel.with_suffix(".txt"))
    for part_i, part in enumerate(img_path.parts):           # .../images/train/x.jpg -> .../labels/train/x.txt
        if part == "images":
            candidates.append(Path(*img_path.parts[:part_i], "labels", *img_path.parts[part_i + 1:]).with_suffix(".txt"))
    return next((c for c in candidates if c.exists()), None)


def import_path_job(job, proj, path, opts):
    if path.is_file() and path.suffix.lower() in VIDEO_EXTS:
        job.total = video_estimate(path, opts["every_s"], opts["start_s"], opts["end_s"], opts["max_frames"])
        return import_videos(job, proj, [(path, slug(f"{path.parent.name}_{path.stem}"))], opts)
    files = [path] if path.is_file() else sorted((path.rglob("*") if opts["recursive"] else path.glob("*")))
    images = [f for f in files if f.suffix.lower() in cal.IMG_EXTS and "thumbs" not in f.parts]
    videos = [f for f in files if f.suffix.lower() in VIDEO_EXTS] if opts["videos"] else []
    job.total = len(images) + sum(video_estimate(v, opts["every_s"], opts["start_s"], opts["end_s"],
                                                 opts["max_frames"]) for v in videos)
    folder = path if path.is_dir() else path.parent
    for f in images:
        if job.cancel:
            return
        label = find_label(f, folder) if opts["labels"] else None
        proj.add_image(src_path=f, label_src=label)
        job.done += 1
        if job.done % 50 == 0:
            proj.save()
    proj.save()
    if videos:
        import_videos(job, proj, [(v, slug(f"{v.parent.name}_{v.stem}")) for v in videos], opts)


# -------------------------------------------------------------------------------------------------------- auto-label
def autolabel_job(job, proj, names):
    s = proj.data["settings"]
    classes = proj.data["classes"]
    backend = s.get("backend", cal.DEFAULT_BACKEND)
    client = cal.make_client() if backend == "api" else None
    tmp = proj.path / "tmp"
    tmp.mkdir(exist_ok=True)
    job.message = f"{s['model']} · effort {s['effort']} · {'subscription' if backend == 'claude_code' else 'API'}"
    usage_rows = []                                           # tokens / cost per image, also in <project>/usage.csv

    def one(name):
        if job.cancel:
            return name, None
        img = proj.image(name)
        usage = {}
        boxes, answer = cal.label_image(client, img, classes, s["model"], s["effort"], s.get("tier") or None,
                                        s["scene"], s["hint"], backend, tmp, usage=usage)
        if usage.get("input_tokens") is not None:
            cal.append_usage(proj.path / "usage.csv", usage)
            usage_rows.append(usage)
        if not img.exists():                                  # deleted while Claude was looking at it
            return name, None
        (proj.path / "raw" / f"{img.stem}.txt").write_text(answer)
        proj.write_boxes(name, boxes)
        proj.set_status(name, "auto", save=False)
        return name, len(boxes)

    with ThreadPoolExecutor(max_workers=max(1, int(s.get("workers", 4)))) as pool:
        futures = {pool.submit(one, n): n for n in names}
        for fut in as_completed(futures):
            try:
                _, n = fut.result()
                if n is not None:
                    job.done += 1
            except cal.UsageLimitError as e:                  # the plan's limit: stop; "to do" resumes later
                job.cancel = True
                job.state = "error"
                job.message = f"Subscription usage limit reached after {job.done} images; run 'Images still to do' later to continue ({e})"
            except Exception as e:                            # keep going; the image stays as it was
                job.failed += 1
                job.errors.append(f"{futures[fut]}: {type(e).__name__}: {e}")
                fatal = None                                  # no point trying the other images
                if isinstance(e, (cal.anthropic.AuthenticationError, cal.anthropic.PermissionDeniedError)) or \
                        "authentication method" in str(e):
                    fatal = ("No working Anthropic credentials: set ANTHROPIC_API_KEY in the terminal before "
                             "starting the annotator, or switch the backend to your Claude subscription")
                elif "Claude Code CLI not found" in str(e) or "not logged in" in str(e):
                    fatal = str(e)
                if fatal and job.state == "running":
                    job.cancel = True
                    job.state = "error"
                    job.message = fatal
            if (job.done + job.failed) % 10 == 0:
                proj.save()
    proj.save()
    if usage_rows and job.state != "error":
        job.message += f" · {cal.usage_summary(usage_rows)}"


# ------------------------------------------------------------------------------------------------------------ export
def split_groups(names, group_s):
    """Images grouped so near-identical frames never land in different splits: video frames by (source, group_s
    window of video time), other images one per group."""
    groups = {}
    for n in names:
        m = FRAME_RE.match(Path(n).stem)
        key = (m["src"], int(m["ms"]) // int(group_s * 1000)) if (m and group_s > 0) else ("img", n)
        groups.setdefault(key, []).append(n)
    return list(groups.values())


def assign_splits(groups, val_frac, test_frac, seed):
    rnd = random.Random(seed)
    groups = groups[:]
    rnd.shuffle(groups)
    total = sum(len(g) for g in groups)
    want = {"valid": val_frac * total, "test": test_frac * total}
    out = {"train": [], "valid": [], "test": []}
    for g in groups:
        split = next((k for k in ("valid", "test") if len(out[k]) < want[k] and len(out[k]) + len(g) / 2 <= want[k]),
                     "train")
        out[split].extend(g)
    if val_frac > 0 and not out["valid"] and len(out["train"]) > 1:   # tiny sets: still give valid one group
        g = next(g for g in groups if g[0] in out["train"])
        out["valid"] = g
        out["train"] = [n for n in out["train"] if n not in g]
    return out


def export_job(job, proj, opts):
    out = Path(opts["out"]).expanduser()
    if out.exists() and any(out.iterdir()):
        if not (out / EXPORT_MARKER).exists():
            raise RuntimeError(f"{out} is not empty and is not a previous export; pick an empty folder")
        for sub in ("train", "valid", "test"):
            shutil.rmtree(out / sub, ignore_errors=True)
    out.mkdir(parents=True, exist_ok=True)
    (out / EXPORT_MARKER).write_text(proj.data["name"])

    keep = {"reviewed", "imported"} | ({"auto"} if opts["include_auto"] else set())
    names = sorted(n for n, st in proj.data["status"].items() if st in keep)
    if not names:
        raise RuntimeError("nothing to export: no reviewed images yet (or tick 'include Claude labels not reviewed')")
    splits = assign_splits(split_groups(names, opts["group_s"]), opts["val"], opts["test"], opts["seed"])
    mirrored_test = not splits["test"]
    if mirrored_test:                                         # RF-DETR evaluates on test/: mirror valid when empty
        splits["test"] = list(splits["valid"])
    job.total = sum(len(v) for v in splits.values())
    classes = proj.names
    counts = {}
    for split, items in splits.items():
        (out / split / "images").mkdir(parents=True, exist_ok=True)
        (out / split / "labels").mkdir(parents=True, exist_ok=True)
        coco = {"info": {"description": f"Swish Annotator export of {proj.data['name']}"},
                "categories": [{"id": 0, "name": "basketball", "supercategory": "none"}] +
                              [{"id": i + 1, "name": c, "supercategory": "basketball"} for i, c in enumerate(classes)],
                "images": [], "annotations": []}
        per_class = [0] * len(classes)
        for i, name in enumerate(items):
            if job.cancel:
                return
            src = proj.image(name)
            shutil.copy2(src, out / split / "images" / name)
            boxes = [b for b in cal.read_yolo(proj.label_path(name)) if 0 <= b[0] < len(classes)]
            proj_lines = cal.yolo_lines(boxes)
            (out / split / "labels" / f"{src.stem}.txt").write_text("\n".join(proj_lines) + ("\n" if proj_lines else ""))
            with Image.open(src) as im:
                w, h = ImageOps.exif_transpose(im).size
            coco["images"].append({"id": i, "file_name": f"images/{name}", "width": w, "height": h})
            for cid, x1, y1, x2, y2 in boxes:
                bw, bh = (x2 - x1) * w, (y2 - y1) * h
                coco["annotations"].append({"id": len(coco["annotations"]), "image_id": i, "category_id": cid + 1,
                                            "bbox": [round(x1 * w, 2), round(y1 * h, 2), round(bw, 2), round(bh, 2)],
                                            "area": round(bw * bh, 2), "iscrowd": 0, "segmentation": []})
                per_class[cid] += 1
            job.done += 1
        (out / split / "_annotations.coco.json").write_text(json.dumps(coco))
        counts[split] = {"images": len(items), "boxes": dict(zip(classes, per_class))}

    yaml_names = "\n".join(f"  {i}: {c}" for i, c in enumerate(classes))
    (out / "data.yaml").write_text(
        f"# Swish Annotator export of {proj.data['name']} ({time.strftime('%Y-%m-%d %H:%M')})\n"
        f"path: {out.resolve().as_posix()}\ntrain: train/images\nval: valid/images\ntest: test/images"
        f"{'  # copy of valid (no test split asked)' if mirrored_test else ''}\n"
        f"nc: {len(classes)}\nnames:\n{yaml_names}\n")
    (out / "classes.txt").write_text("\n".join(classes) + "\n")
    job.result = {"out": str(out.resolve()), "counts": counts, "mirrored_test": mirrored_test,
                  "yolo": f'yolo detect train data="{(out / "data.yaml").resolve().as_posix()}" model=yolo26n.pt '
                          f'imgsz=640 epochs=100',
                  "rfdetr": f'from rfdetr import RFDETRNano; RFDETRNano().train(dataset_dir=r"{out.resolve()}", '
                            f'epochs=100, batch_size=8)'}


# ------------------------------------------------------------------------------------------------------------- API
class NewProject(BaseModel):
    name: str
    classes: Optional[List[str]] = None


class ClassItem(BaseModel):
    name: str
    description: str = ""
    src: Optional[int] = None         # its index before the edit (None = new class)


class ClassesIn(BaseModel):
    classes: List[ClassItem]


class Box(BaseModel):
    c: int
    x1: float
    y1: float
    x2: float
    y2: float


class LabelsIn(BaseModel):
    boxes: List[Box]
    status: Optional[str] = None


class PathImport(BaseModel):
    path: str
    every_s: float = 0.5
    start_s: float = 0.0
    end_s: float = 0.0
    max_frames: int = 0
    recursive: bool = True
    videos: bool = True
    labels: bool = True


class AutoLabelIn(BaseModel):
    scope: str = "unlabeled"          # unlabeled | not_reviewed | list
    names: List[str] = []
    settings: dict = {}


class BulkIn(BaseModel):
    names: List[str]
    action: str                       # delete | reset | reviewed


class ExportIn(BaseModel):
    out: str = ""
    val: float = 0.15
    test: float = 0.1
    include_auto: bool = False
    group_s: float = 10.0
    seed: int = 0


def summary(proj):
    st = proj.data["status"]
    counts = {k: 0 for k in STATUSES}
    for v in st.values():
        counts[v] = counts.get(v, 0) + 1
    return {"name": proj.data["name"], "images": len(st), "counts": counts}


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/projects")
def list_projects():
    ROOT.mkdir(parents=True, exist_ok=True)
    out = []
    for p in sorted(ROOT.iterdir()):
        if not (p / "project.json").exists():
            continue
        proj = Project.get(p.name)
        st = proj.data["status"]
        # cover: the first image that has boxes from a review / Claude, else the first image
        cover = next((n for n, s in sorted(st.items()) if s in ("reviewed", "imported", "auto")
                      and proj.label_path(n).exists() and proj.label_path(n).stat().st_size > 0),
                     next(iter(sorted(st)), None))
        job = running_job(p.name)
        out.append({**summary(proj), "classes": proj.names, "created": proj.data.get("created"),
                    "updated": proj.data.get("updated") or (p / "project.json").stat().st_mtime,
                    "cover": cover, "job": job.info() if job else None})
    return out


class RenameIn(BaseModel):
    new_name: str


@app.post("/api/projects/{name}/rename")
def rename_project(name: str, body: RenameIn):
    proj = Project.get(name)
    new = slug(body.new_name)
    if new == name:
        return summary(proj)
    if (ROOT / new).exists():
        raise HTTPException(409, f"a project called {new} already exists")
    job = running_job(name)
    if job:
        raise HTTPException(409, f"a {job.kind} run is going for this project; wait for it or cancel it first")
    with Project._open_lock:
        Project._open.pop(name, None)
        os.replace(proj.path, ROOT / new)
    renamed = Project.get(new)
    with renamed.lock:
        renamed.data["name"] = new
        renamed.save()
    return summary(renamed)


@app.post("/api/projects")
def create_project(body: NewProject):
    name = slug(body.name)
    if (ROOT / name / "project.json").exists():
        raise HTTPException(409, f"project {name} exists")
    proj = Project.get(name, create=True)
    if body.classes:
        proj.data["classes"] = cal.class_specs([c.strip() for c in body.classes if c.strip()])
        proj.save()
    return summary(proj)


@app.get("/api/projects/{name}")
def get_project(name: str):
    proj = Project.get(name)
    counts = {}
    for f in (proj.path / "labels").glob("*.txt"):
        counts[f.stem] = sum(1 for line in f.read_text().splitlines() if line.strip())
    images = [{"name": n, "status": st, "n": counts.get(Path(n).stem, 0)} for n, st in sorted(proj.data["status"].items())]
    return {**summary(proj), "path": str(proj.path), "classes": proj.data["classes"],
            "settings": proj.data["settings"], "image_list": images,
            "default_export": str(proj.path / "export")}


@app.put("/api/projects/{name}/settings")
def put_settings(name: str, settings: dict):
    proj = Project.get(name)
    allowed = {"backend", "model", "effort", "tier", "workers", "scene", "hint"}
    with proj.lock:
        proj.data["settings"].update({k: v for k, v in settings.items() if k in allowed})
        proj.save()
    return proj.data["settings"]


@app.put("/api/projects/{name}/classes")
def put_classes(name: str, body: ClassesIn):
    """New class list; existing boxes follow their class to its new index, boxes of deleted classes are removed."""
    proj = Project.get(name)
    if not body.classes or len({c.name.strip().lower() for c in body.classes}) != len(body.classes):
        raise HTTPException(400, "class names must be unique and non-empty")
    remap = {c.src: i for i, c in enumerate(body.classes) if c.src is not None}
    with proj.lock:
        if remap != {i: i for i in range(len(proj.names))}:
            for f in (proj.path / "labels").glob("*.txt"):
                boxes = [(remap[b[0]], *b[1:]) for b in cal.read_yolo(f) if b[0] in remap]
                lines = cal.yolo_lines(boxes)
                f.write_text("\n".join(lines) + ("\n" if lines else ""))
        proj.data["classes"] = [{"name": c.name.strip(), "description": c.description.strip()} for c in body.classes]
        proj.save()
    return proj.data["classes"]


@app.get("/api/projects/{name}/images/{img}")
def get_image(name: str, img: str):
    return FileResponse(Project.get(name).image(img), headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{name}/thumbs/{img}")
def get_thumb(name: str, img: str):
    proj = Project.get(name)
    src = proj.image(img)
    thumb = proj.path / "thumbs" / f"{src.stem}.jpg"
    if not thumb.exists() or thumb.stat().st_mtime < src.stat().st_mtime:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail(THUMB_SIZE)
            im.save(thumb, quality=80)
    return FileResponse(thumb, headers={"Cache-Control": "max-age=3600"})


@app.get("/api/projects/{name}/labels/{img}")
def get_labels(name: str, img: str):
    proj = Project.get(name)
    proj.image(img)
    boxes = [{"c": c, "x1": x1, "y1": y1, "x2": x2, "y2": y2} for c, x1, y1, x2, y2 in cal.read_yolo(proj.label_path(img))]
    raw = proj.path / "raw" / f"{Path(img).stem}.txt"
    return {"boxes": boxes, "status": proj.data["status"].get(img, "unlabeled"), "has_raw": raw.exists()}


@app.put("/api/projects/{name}/labels/{img}")
def put_labels(name: str, img: str, body: LabelsIn):
    proj = Project.get(name)
    proj.image(img)
    nc = len(proj.names)
    boxes = []
    for b in body.boxes:
        x1, x2 = sorted((min(max(b.x1, 0.0), 1.0), min(max(b.x2, 0.0), 1.0)))
        y1, y2 = sorted((min(max(b.y1, 0.0), 1.0), min(max(b.y2, 0.0), 1.0)))
        if 0 <= b.c < nc and x2 > x1 and y2 > y1:
            boxes.append((b.c, x1, y1, x2, y2))
    proj.write_boxes(img, boxes)
    if body.status in STATUSES:
        proj.set_status(img, body.status)
    return {"n": len(boxes), "status": proj.data["status"][img]}


def running_job(name):
    return next((j for j in JOBS.values() if j.project == name and j.state == "running"), None)


@app.delete("/api/projects/{name}")
def delete_project(name: str):
    """Deletes the whole project folder: images, labels, Claude's answers, uploaded videos and the default export
    (an export written to another folder is left alone)."""
    proj = Project.get(name)
    job = running_job(name)
    if job:
        raise HTTPException(409, f"a {job.kind} run is going for this project; cancel it first")
    path = proj.path.resolve()
    if path.parent != ROOT.resolve() or not (path / "project.json").exists():
        raise HTTPException(400, f"{path} does not look like a project folder")
    with Project._open_lock:
        Project._open.pop(name, None)
    shutil.rmtree(path)
    return {"ok": True}


@app.delete("/api/projects/{name}/images/{img}")
def delete_image(name: str, img: str):
    proj = Project.get(name)
    proj.image(img)
    proj.remove_image(img)
    proj.save()
    return {"ok": True}


@app.post("/api/projects/{name}/images/bulk")
def bulk_images(name: str, body: BulkIn):
    """delete: images + labels gone; reset: boxes removed, back to "to do"; reviewed: mark reviewed."""
    proj = Project.get(name)
    names = [safe_name(n) for n in body.names if n in proj.data["status"]]
    with proj.lock:
        for n in names:
            if body.action == "delete":
                proj.remove_image(n)
            elif body.action == "reset":
                proj.label_path(n).unlink(missing_ok=True)
                (proj.path / "raw" / f"{Path(n).stem}.txt").unlink(missing_ok=True)
                proj.data["status"][n] = "unlabeled"
            elif body.action == "reviewed":
                if not proj.label_path(n).exists():
                    proj.write_boxes(n, [])                   # reviewed with no boxes = a negative example
                proj.data["status"][n] = "reviewed"
            else:
                raise HTTPException(400, f"unknown action {body.action}")
        proj.save()
    return {"n": len(names)}


@app.post("/api/projects/{name}/import/upload")
async def import_upload(name: str, files: List[UploadFile] = File(...), every_s: float = Form(0.5),
                        start_s: float = Form(0.0), end_s: float = Form(0.0), max_frames: int = Form(0)):
    proj = Project.get(name)
    videos, added = [], 0
    for f in files:
        fname = Path(f.filename or "upload").name
        ext = Path(fname).suffix.lower()
        if ext in VIDEO_EXTS:
            dst = proj.path / "videos" / (slug(Path(fname).stem) + ext)
            with dst.open("wb") as out:
                shutil.copyfileobj(f.file, out, 4 << 20)
            videos.append((dst, slug(Path(fname).stem)))
        elif ext in cal.IMG_EXTS:
            proj.add_image(data=await f.read(), name=fname)
            added += 1
    proj.save()
    opts = {"every_s": every_s, "start_s": start_s, "end_s": end_s, "max_frames": max_frames}
    if not videos:
        return {"added": added, "job": None}
    job = Job("import", name, sum(video_estimate(v, every_s, start_s, end_s, max_frames) for v, _ in videos))
    return {"added": added, "job": job.run(import_videos, proj, videos, opts)}


@app.post("/api/projects/{name}/import/path")
def import_path(name: str, body: PathImport):
    proj = Project.get(name)
    path = Path(body.path.strip().strip('"')).expanduser()
    if not path.exists():
        raise HTTPException(404, f"not found on this PC: {path}")
    job = Job("import", name)
    return {"job": job.run(import_path_job, proj, path, body.model_dump())}


@app.post("/api/projects/{name}/autolabel")
def autolabel(name: str, body: AutoLabelIn):
    proj = Project.get(name)
    if body.settings:
        put_settings(name, body.settings)
    st = proj.data["status"]
    if body.scope == "unlabeled":
        names = [n for n, s in sorted(st.items()) if s == "unlabeled"]
    elif body.scope == "not_reviewed":
        names = [n for n, s in sorted(st.items()) if s in ("unlabeled", "auto")]
    else:
        names = [safe_name(n) for n in body.names if n in st]
    if not names:
        raise HTTPException(400, "no images in that selection")
    if any(j.kind == "autolabel" and j.project == name and j.state == "running" for j in JOBS.values()):
        raise HTTPException(409, "an auto-label run is already going for this project")
    job = Job("autolabel", name, len(names))
    return {"job": job.run(autolabel_job, proj, names)}


@app.post("/api/projects/{name}/export")
def export(name: str, body: ExportIn):
    proj = Project.get(name)
    opts = body.model_dump()
    opts["out"] = opts["out"].strip().strip('"') or str(proj.path / "export")
    if not (0 <= opts["val"] < 1 and 0 <= opts["test"] < 1 and opts["val"] + opts["test"] < 1):
        raise HTTPException(400, "valid + test must be below 100%")
    job = Job("export", name)
    return {"job": job.run(export_job, proj, opts)}


@app.get("/api/jobs")
def list_jobs():
    return [j.info() for j in JOBS.values() if j.state == "running" or time.time() - j.started < 600]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "no such job")
    return JOBS[job_id].info()


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str):
    if job_id not in JOBS:
        raise HTTPException(404, "no such job")
    JOBS[job_id].cancel = True
    return JOBS[job_id].info()


@app.exception_handler(Exception)
def on_error(_, exc):
    return JSONResponse(status_code=500, content={"detail": f"{type(exc).__name__}: {exc}"})


app.mount("/static", StaticFiles(directory=STATIC), name="static")


def main():
    global ROOT
    p = argparse.ArgumentParser(description="Swish Annotator: Claude pre-labels + manual review -> YOLO / COCO dataset")
    p.add_argument("--root", default=str(HERE / "projects"), help="Folder holding the projects")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8765)
    p.add_argument("--no-browser", action="store_true")
    args = p.parse_args()
    ROOT = Path(args.root).resolve()
    ROOT.mkdir(parents=True, exist_ok=True)
    url = f"http://{args.host}:{args.port}"
    print(f"Swish Annotator on {url}  (projects in {ROOT})")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
