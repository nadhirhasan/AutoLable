#!/usr/bin/env python3
"""
claude_autolabel.py - Pre-label basketball frames for object detection with Claude.

The labeling engine behind the annotator UI (annotator_app.py), also usable on its own from the command line.
Sends each image to Claude, gets bounding boxes back, and writes YOLO-format labels.

Classes: by default the SwishStation detector's own classes, in the pipeline's id order, so the labels are a
drop-in for retraining the RF-DETR / YOLO model:
    0 ball   1 made   2 person   3 rim   4 shoot
(the backboard pipeline itself only uses ball and person; the other three are kept so the class ids stay the same).
Each class goes to Claude with a short definition (CLASS_GUIDE), plus a note on the two camera views (SCENE_NOTE).

The request setup mirrors Roboflow's vlm-exam benchmark for Claude Opus 5.5
(github.com/roboflow/vlm-exam, the run behind its ~75% mAP@50 detection score):
  - images pre-resized with Anthropic's reference resize function
    (docs: platform.claude.com/docs/en/build-with-claude/vision-coordinates),
    high-resolution tier = 2576 px long edge / 4784 visual tokens,
    so the pixel coordinates Claude returns map 1:1 onto the uploaded image
  - the same prompt: a JSON list of {"box_2d": [x_min, y_min, x_max, y_max], "label": ...}
    in absolute pixels of the stated WxH image
  - PNG upload, effort low/high, max_tokens 16384, plain-text JSON answer
Differences: every class is listed (the benchmark listed only the classes present in each image), and the class
definitions + scene note are appended, so expect accuracy somewhat different from the leaderboard number.
Two backends:
  claude_code (default)  your Claude subscription: each image goes to the Claude Code CLI in print mode
                         (`claude -p`, only its Read tool, logged in with your plan). No API key, no API credits;
                         it counts against the plan's usage limits. ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are
                         removed from the CLI's environment so it can never bill the API by accident. The image is
                         pre-resized to the "standard" tier (fits every model's limit, so neither Claude Code nor
                         the API resizes it again and the pixel coordinates stay 1:1). For your own labeling only.
  api                    Anthropic API with an API key (pay-as-you-go credits). Server-side fallback is on (beta
                         server-side-fallback-2026-07-01, fallbacks="default"): if the model declines a request,
                         the API re-runs it on a fallback model inside the same call.

Setup (conda env myenv):
    C:\\Users\\pc\\.conda\\envs\\myenv\\python.exe -m pip install anthropic pillow
    claude_code backend: Claude Code installed and logged in with your subscription (run `claude` once, /login)
    api backend:         set ANTHROPIC_API_KEY=sk-ant-...

Usage:
    python annotator/claude_autolabel.py --images frames/ --out labeled/ --limit 20
    python annotator/claude_autolabel.py --images frames/ --out labeled/ --classes "ball,person" --effort high
    python annotator/claude_autolabel.py --images frames/ --out labeled/ --backend api

Output (--out):
    images/      copies of your images
    labels/      one YOLO .txt per image:  <class_id> <x_center> <y_center> <width> <height>  (0-1)
    previews/    images with boxes drawn, for a quick visual check
    raw/         Claude's raw answer per image (for debugging)
    classes.txt  class names, one per line
    data.yaml    for a quick Ultralytics check (use the annotator's Export for a real train/valid/test split)
Re-running skips images that already have a label file, so you can stop and resume.
"""

import argparse
import base64
import csv
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import anthropic
from PIL import Image, ImageDraw, ImageOps

IMG_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}

DEFAULT_MODEL = "claude-opus-5-5"
DEFAULT_EFFORT = "low"
DEFAULT_BACKEND = "claude_code"
BACKENDS = ("claude_code", "api")
BACKEND_TIER = {"claude_code": "standard", "api": "high"}   # image resolution tier per backend (see header)
MAX_TOKENS = 16384
FALLBACK_BETA = "server-side-fallback-2026-07-01"
CLAUDE_CODE_TIMEOUT_S = 600
CLAUDE_CODE_SYSTEM = ("You label images for an object detection dataset. Open the image file you are given with the "
                      "Read tool, look at it carefully, then reply with only the JSON list asked for.")
# env vars that would make the CLI bill the API (or think it runs nested inside another Claude Code session)
CLAUDE_CODE_DROP_ENV = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT",
                        "CLAUDE_CODE_SSE_PORT")
USAGE_LIMIT_RE = re.compile(r"usage limit|hit your limit|limit reached|rate.?limit|out of (extra )?usage", re.I)


class UsageLimitError(RuntimeError):
    """The subscription's usage limit is reached: stop the run, resume later."""

# The SwishStation detector's classes in pipeline id order (runner.CLASS_BALL .. CLASS_SHOOT = 0..4).
DEFAULT_CLASSES = ["ball", "made", "person", "rim", "shoot"]

# Per-class labeling rules sent to Claude (editable per project in the UI).
CLASS_GUIDE = {
    "ball": "the basketball. Box every basketball you can see, including one held in the hands, partly hidden "
            "behind a hand, the rim or the net, motion-blurred in flight, or cut off at the image edge. The box is "
            "tight around the visible round ball only (not the hands holding it, not the blur trail beyond the "
            "ball). Small far-away balls count.",
    "made": "the ball going in: the ball is at least half below the rim line (its centre at or below the ring), "
            "inside the net. Seen from above, the net wraps around the ball and the ball looks clearly smaller "
            "than the ring opening. Box the whole hoop: the ring plus the net hanging below it (from above this "
            "is the same area as the rim box), not just the ball. NOT made: the ball above the ring (even when it "
            "overlaps the opening in the picture), sitting on or rolling around the ring, beside the rim, or "
            "after it has dropped out of the net.",
    "person": "a person. Box every person, the full body from the head to the feet (include the parts cut off "
              "by the image edge up to the edge). One box per person, even when people overlap.",
    "rim": "the basketball rim (the orange hoop ring). Box the ring itself; the net below it is not part of "
           "the rim box. Include the rim even when seen from above or at a steep angle.",
    "shoot": "a player in the act of shooting: from the moment the ball is raised to shoot until just after it "
             "leaves the hands (arms up, ball at or above the head, or the follow-through). Box the shooting "
             "player's full body. A player only holding or dribbling the ball is NOT shoot.",
}

SCENE_NOTE = (
    "The frames come from a basketball training station: either a camera mounted above the basket looking down "
    "at the court and the shooter from the front (the rim at the bottom or edge of the picture), or a camera "
    "looking straight down through the rim from above. Fisheye-like distortion and motion blur are normal."
)

# (max_edge, max_visual_tokens) per Anthropic's vision docs.
# "high": Claude 4.7 and later (Opus 5.5, Sonnet 5.5, ...). "standard": older models.
RESOLUTION_TIERS = {"high": (2576, 4784), "standard": (1568, 1568)}

MAX_BASE64_BYTES = 9_500_000  # API limit is 10 MB base64 per image; leave headroom

# API list prices, USD per million tokens (input, output); thinking counts as output. For the per-image cost log
# (usage.csv): the api backend is billed this; the subscription backend is not billed per token (its tokens also
# include Claude Code's own turn around the Read tool, so its "API price" is only a rough comparison).
PRICE_PER_MTOK = {"claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5-5": (2.0, 10.0), "claude-opus-5": (5.0, 25.0),
                  "claude-fable-5-1": (10.0, 50.0), "claude-haiku-5-5": (0.10, 0.50)}
USAGE_FIELDS = ["image", "backend", "model", "effort", "image_px", "input_tokens", "output_tokens", "cost_usd",
                "cli_cost_usd"]
_usage_lock = threading.Lock()


def api_cost(model, input_tokens, output_tokens):
    """Cost at the API list price, or None for a model without a known price."""
    price = next((p for m, p in PRICE_PER_MTOK.items() if str(model).startswith(m)), None)
    if price is None or input_tokens is None or output_tokens is None:
        return None
    return (input_tokens * price[0] + output_tokens * price[1]) / 1e6


def append_usage(csv_path, row):
    """One image's tokens and cost appended to usage.csv (thread-safe; header on a new file)."""
    with _usage_lock:
        new = not Path(csv_path).exists()
        with open(csv_path, "a", newline="") as f:
            w = csv.DictWriter(f, fieldnames=USAGE_FIELDS, extrasaction="ignore")
            if new:
                w.writeheader()
            w.writerow(row)


def usage_summary(rows):
    """'N images: avg X input / Y output tokens, avg $Z per image at API price' for usage dicts."""
    rows = [r for r in rows if r.get("input_tokens") is not None]
    if not rows:
        return "no token usage recorded"
    n = len(rows)
    tin = sum(r["input_tokens"] for r in rows) / n
    tout = sum(r["output_tokens"] for r in rows) / n
    costs = [r["cost_usd"] for r in rows if r.get("cost_usd") is not None]
    cost = f", avg ${sum(costs) / len(costs):.4f} per image at API price (total ${sum(costs):.3f})" if costs else ""
    return f"{n} images: avg {tin:.0f} input / {tout:.0f} output tokens{cost}"

# Same wording as vlm-exam's _PIXEL_PROMPT_TEMPLATE (detection_coordinate_format: xyxy_absolute_resized_image)
PROMPT_TEMPLATE = (
    "Detect all objects in this image. "
    "Output a JSON list where each entry contains the 2D bounding box "
    'in the key "box_2d" and the text label in the key "label". '
    'The "box_2d" value must be [x_min, y_min, x_max, y_max]: the '
    "top-left and bottom-right corners in absolute pixel coordinates "
    "of the {width}x{height} pixel image. "
    "Return only the JSON list, with no extra text. "
    "Only use these labels: {class_list}"
)


def class_specs(names, descriptions=None):
    """[{name, description}] for class names, filling descriptions from CLASS_GUIDE when not given."""
    descriptions = descriptions or {}
    return [{"name": n, "description": descriptions.get(n) or CLASS_GUIDE.get(n.lower(), "")} for n in names]


def build_prompt(width, height, classes, scene=SCENE_NOTE, hint=""):
    """The vlm-exam prompt + class definitions + scene note + extra hint. classes: [{name, description}]."""
    prompt = PROMPT_TEMPLATE.format(width=width, height=height, class_list=", ".join(c["name"] for c in classes))
    defs = [f'- "{c["name"]}": {c["description"]}' for c in classes if c.get("description")]
    if defs:
        prompt += "\nLabel definitions:\n" + "\n".join(defs)
    if scene:
        prompt += f"\nScene: {scene}"
    if hint:
        prompt += f"\nNotes: {hint}"
    prompt += "\nIf none of these objects are in the image, return []."
    return prompt


def resized_size(width, height, max_edge, max_tokens):
    """Anthropic's reference function: the size Claude resizes an image to."""

    def fits(w, h):
        return (
            math.ceil(w / 28) * 28 <= max_edge
            and math.ceil(h / 28) * 28 <= max_edge
            and math.ceil(w / 28) * math.ceil(h / 28) <= max_tokens
        )

    if fits(width, height):
        return (width, height)
    if height > width:
        rh, rw = resized_size(height, width, max_edge, max_tokens)
        return (rw, rh)
    aspect = width / height
    lo, hi = 1, width
    while lo + 1 < hi:
        mid = (lo + hi) // 2
        if fits(mid, max(round(mid / aspect), 1)):
            lo = mid
        else:
            hi = mid
    return (lo, max(round(lo / aspect), 1))


def load_image(path, tier="high"):
    img = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    target = resized_size(*img.size, *RESOLUTION_TIERS[tier])
    if target != img.size:
        img = img.resize(target, Image.LANCZOS)
    return img


def encode(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    data = base64.standard_b64encode(buf.getvalue()).decode()
    if len(data) <= MAX_BASE64_BYTES:
        return data, "image/png"
    buf = io.BytesIO()  # very detailed photos can exceed the size limit as PNG
    img.save(buf, format="JPEG", quality=95)
    return base64.standard_b64encode(buf.getvalue()).decode(), "image/jpeg"


def make_client():
    return anthropic.Anthropic(max_retries=5, timeout=600)


def ask_claude(client, img, classes, model=DEFAULT_MODEL, effort=DEFAULT_EFFORT, scene=SCENE_NOTE, hint="",
               usage=None):
    """Claude's raw text answer for one (already resized) image. Raises on a refusal of the whole fallback chain.
    usage: a dict filled with the call's tokens and cost."""
    data, media_type = encode(img)
    resp = client.beta.messages.create(
        model=model,
        max_tokens=MAX_TOKENS,
        output_config={"effort": effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}},
                {"type": "text", "text": build_prompt(*img.size, classes, scene, hint)},
            ],
        }],
    )
    if usage is not None and getattr(resp, "usage", None) is not None:
        u = resp.usage
        tin = ((u.input_tokens or 0) + (getattr(u, "cache_creation_input_tokens", 0) or 0)
               + (getattr(u, "cache_read_input_tokens", 0) or 0))
        used = getattr(resp, "model", None) or model
        usage.update(backend="api", model=used, input_tokens=tin, output_tokens=u.output_tokens,
                     cost_usd=api_cost(used, tin, u.output_tokens))
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude declined this image")
    texts = [b.text for b in resp.content if b.type == "text"]
    return texts[-1].strip() if texts else ""


def claude_code_exe():
    """The Claude Code CLI: the native claude.exe behind npm's claude.cmd wrapper when there is one (a .cmd would
    run through cmd.exe), else whatever `claude` is on PATH. None when not installed."""
    found = shutil.which("claude")
    if found and found.lower().endswith((".cmd", ".ps1")):
        native = Path(found).parent / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe"
        if native.exists():
            return str(native)
    return found


def ask_claude_code(img, classes, model=DEFAULT_MODEL, effort=DEFAULT_EFFORT, scene=SCENE_NOTE, hint="",
                    workdir=None, usage=None):
    """Claude's raw text answer for one (already resized) image via `claude -p` on the subscription login.
    Raises UsageLimitError when the plan's limit is reached. usage: a dict filled with the CLI's reported tokens."""
    exe = claude_code_exe()
    if not exe:
        raise RuntimeError("Claude Code CLI not found: install it and log in with your subscription (`claude`, /login)")
    env = {k: v for k, v in os.environ.items() if k not in CLAUDE_CODE_DROP_ENV}
    with tempfile.TemporaryDirectory(dir=workdir, prefix="cc_") as tmp:
        img_path = Path(tmp) / "frame.png"
        img.save(img_path)
        prompt = (f"Open the image file {img_path.as_posix()} with the Read tool.\n"
                  + build_prompt(*img.size, classes, scene, hint))
        cmd = [exe, "-p", "--output-format", "json", "--model", model, "--effort", effort,
               "--tools", "Read", "--allowedTools", "Read", "--no-session-persistence", "--strict-mcp-config",
               "--system-prompt", CLAUDE_CODE_SYSTEM]
        proc = subprocess.run(cmd, input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              cwd=tmp, env=env, timeout=CLAUDE_CODE_TIMEOUT_S)
    out = proc.stdout.strip()
    try:
        reply = json.loads(out[out.find("{"):]) if "{" in out else {}
    except json.JSONDecodeError:
        reply = {}
    text = str(reply.get("result") or "")
    u = reply.get("usage") or {}
    if usage is not None and u:
        tin = sum(int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"))
        tout = int(u.get("output_tokens") or 0)
        usage.update(backend="claude_code", model=model, input_tokens=tin, output_tokens=tout,
                     cost_usd=api_cost(model, tin, tout), cli_cost_usd=reply.get("total_cost_usd"))
    if proc.returncode != 0 or reply.get("is_error") or not reply:
        msg = (text or proc.stderr.strip() or out or f"exit code {proc.returncode}")[:400]
        if USAGE_LIMIT_RE.search(msg):
            raise UsageLimitError(msg)
        if re.search(r"log ?in|not logged|authenticat|api key", msg, re.I):
            raise RuntimeError(f"Claude Code is not logged in with your subscription (run `claude`, then /login): {msg}")
        raise RuntimeError(f"Claude Code: {msg}")
    return text.strip()


def parse_answer(text):
    """Strict JSON, then the outermost [...] (handles ```json fences / prose), then loose {...} objects."""
    for candidate in (text, text[text.find("["): text.rfind("]") + 1] if "[" in text else ""):
        try:
            data = json.loads(candidate)
            if isinstance(data, list):
                return [e for e in data if isinstance(e, dict)]
        except json.JSONDecodeError:
            pass
    entries = []
    for m in re.finditer(r"\{[^{}]*\}", text):
        try:
            entries.append(json.loads(m.group(0)))
        except json.JSONDecodeError:
            pass
    return entries


def to_boxes(entries, names, w, h):
    """Claude's entries -> [(class_id, x1, y1, x2, y2)] normalised 0-1, clipped to the image; unknown labels and
    empty boxes dropped."""
    lookup = {c.lower(): i for i, c in enumerate(names)}
    boxes = []
    for e in entries:
        box, label = e.get("box_2d"), e.get("label")
        if not (isinstance(box, list) and len(box) == 4 and all(isinstance(v, (int, float)) for v in box)):
            continue
        cid = lookup.get(str(label).strip().lower())
        if cid is None:
            continue
        x1, x2 = sorted(min(max(float(v), 0.0), w) / w for v in (box[0], box[2]))
        y1, y2 = sorted(min(max(float(v), 0.0), h) / h for v in (box[1], box[3]))
        if x2 <= x1 or y2 <= y1:
            continue
        boxes.append((cid, x1, y1, x2, y2))
    return boxes


def yolo_lines(boxes):
    """[(cid, x1, y1, x2, y2) normalised] -> YOLO lines '<cid> <xc> <yc> <w> <h>'."""
    return [f"{cid} {(x1 + x2) / 2:.6f} {(y1 + y2) / 2:.6f} {x2 - x1:.6f} {y2 - y1:.6f}"
            for cid, x1, y1, x2, y2 in boxes]


def read_yolo(path):
    """A YOLO label file -> [(cid, x1, y1, x2, y2) normalised]; [] when missing."""
    boxes = []
    if not Path(path).exists():
        return boxes
    for line in Path(path).read_text().splitlines():
        parts = line.split()
        if len(parts) < 5:
            continue
        cid, xc, yc, bw, bh = int(float(parts[0])), *map(float, parts[1:5])
        boxes.append((cid, xc - bw / 2, yc - bh / 2, xc + bw / 2, yc + bh / 2))
    return boxes


def label_image(client, path, classes, model=DEFAULT_MODEL, effort=DEFAULT_EFFORT, tier=None,
                scene=SCENE_NOTE, hint="", backend=DEFAULT_BACKEND, workdir=None, usage=None):
    """One image -> (boxes [(cid, x1, y1, x2, y2) normalised], raw answer). classes: [{name, description}].
    client: an anthropic.Anthropic for the api backend (unused by claude_code); tier None = the backend's default.
    usage: a dict filled with the image's tokens and cost (USAGE_FIELDS)."""
    img = load_image(path, tier or BACKEND_TIER[backend])
    if usage is not None:
        usage.update(image=Path(path).name, effort=effort, image_px=f"{img.size[0]}x{img.size[1]}")
    if backend == "claude_code":
        answer = ask_claude_code(img, classes, model, effort, scene, hint, workdir, usage)
    else:
        answer = ask_claude(client, img, classes, model, effort, scene, hint, usage)
    if not answer:
        raise RuntimeError("empty answer")
    return to_boxes(parse_answer(answer), [c["name"] for c in classes], *img.size), answer


COLORS = ["#ff6b35", "#3ddc97", "#4d9de0", "#e15554", "#b07bdf", "#42d4f4", "#f032e6", "#bfef45"]


def draw_preview(path, boxes, names, out_path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    d = ImageDraw.Draw(im)
    w, h = im.size
    lw = max(2, round(max(im.size) / 600))
    for cid, x1, y1, x2, y2 in boxes:
        c = COLORS[cid % len(COLORS)]
        d.rectangle([x1 * w, y1 * h, x2 * w, y2 * h], outline=c, width=lw)
        d.text((x1 * w + 3, max(0, y1 * h - 12)), names[cid], fill=c)
    im.save(out_path, quality=85)


def process(path, args, client, classes, out):
    label_path = out / "labels" / f"{path.stem}.txt"
    if label_path.exists():
        return path.name, "skipped"
    usage = {}
    boxes, answer = label_image(client, path, classes, args.model, args.effort, args.tier, SCENE_NOTE, args.hint,
                                args.backend, usage=usage)
    if usage.get("input_tokens") is not None:
        append_usage(out / "usage.csv", usage)
        USAGE_ROWS.append(usage)
    (out / "raw" / f"{path.stem}.txt").write_text(answer)
    shutil.copy2(path, out / "images" / path.name)
    lines = yolo_lines(boxes)
    label_path.write_text("\n".join(lines) + ("\n" if lines else ""))
    if not args.no_preview:
        draw_preview(path, boxes, [c["name"] for c in classes], out / "previews" / f"{path.stem}.jpg")
    cost = f", ${usage['cost_usd']:.4f}" if usage.get("cost_usd") is not None else ""
    toks = (f", {usage['input_tokens']} in / {usage['output_tokens']} out tokens{cost}"
            if usage.get("input_tokens") is not None else "")
    return path.name, f"{len(lines)} boxes{toks}"


USAGE_ROWS = []                 # every image's usage dict of this run (summary at the end)


def main():
    p = argparse.ArgumentParser(description="Pre-label basketball frames with Claude -> YOLO labels")
    p.add_argument("--images", required=True, help="Folder of images")
    p.add_argument("--classes", default=",".join(DEFAULT_CLASSES),
                   help="Comma-separated, in class-id order (default: the detector's ball,made,person,rim,shoot)")
    p.add_argument("--out", default="labeled", help="Output folder")
    p.add_argument("--model", default=DEFAULT_MODEL, help="e.g. claude-opus-5-5 or claude-sonnet-5-5")
    p.add_argument("--effort", default=DEFAULT_EFFORT, choices=["low", "medium", "high"],
                   help="Benchmark: Opus 5.5 74.5%% mAP@50 at low vs 76.0%% at high, ~40%% more cost at high")
    p.add_argument("--backend", default=DEFAULT_BACKEND, choices=BACKENDS,
                   help="claude_code = your Claude subscription via the Claude Code CLI; api = API key + credits")
    p.add_argument("--tier", default=None, choices=list(RESOLUTION_TIERS),
                   help="image resolution; default: 'standard' for claude_code, 'high' for api")
    p.add_argument("--workers", type=int, default=2, help="Parallel requests (lower it if you hit rate limits)")
    p.add_argument("--limit", type=int, default=0, help="Only do the first N images (0 = all)")
    p.add_argument("--hint", default="", help="Extra labeling rules, e.g. 'ignore balls on the rack'")
    p.add_argument("--no-preview", action="store_true", help="Skip drawing preview images")
    args = p.parse_args()

    classes = class_specs([c.strip() for c in args.classes.split(",") if c.strip()])
    paths = sorted(f for f in Path(args.images).rglob("*") if f.suffix.lower() in IMG_EXTS)
    if args.limit:
        paths = paths[: args.limit]
    if not paths:
        sys.exit(f"No images found in {args.images}")

    out = Path(args.out)
    for sub in ("images", "labels", "previews", "raw"):
        (out / sub).mkdir(parents=True, exist_ok=True)
    names = [c["name"] for c in classes]
    (out / "classes.txt").write_text("\n".join(names) + "\n")
    yaml_names = "\n".join(f"  {i}: {c}" for i, c in enumerate(names))
    (out / "data.yaml").write_text(
        f"path: {out.resolve()}\ntrain: images\nval: images  # use the annotator's Export for a real split\n"
        f"names:\n{yaml_names}\n"
    )

    client = make_client() if args.backend == "api" else None
    print(f"Labeling {len(paths)} images with {args.model} (effort={args.effort}, backend={args.backend}) -> {out}/")
    done = failed = 0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(process, f, args, client, classes, out): f for f in paths}
        for fut in as_completed(futures):
            try:
                name, msg = fut.result()
                done += 1
                print(f"[{done + failed}/{len(paths)}] {name}: {msg}")
            except UsageLimitError as e:  # the plan's limit: stop, a re-run resumes
                print(f"Usage limit reached, stopping ({e}). Re-run later to continue.")
                pool.shutdown(wait=False, cancel_futures=True)
                break
            except Exception as e:  # keep going; failed images have no label file, so a re-run retries them
                failed += 1
                print(f"[{done + failed}/{len(paths)}] {futures[fut].name}: FAILED ({e})")
    print(f"\nDone: {done} ok, {failed} failed. Check {out}/previews, then review the boxes in the annotator.")
    print(f"Usage ({out / 'usage.csv'}): {usage_summary(USAGE_ROWS)}")


if __name__ == "__main__":
    main()
