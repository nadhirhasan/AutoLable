# Swish Annotator

A local web app for building an object-detection dataset of basketball frames. Claude draws the first boxes, you review and fix them, and the export trains straight into YOLO (yolo26) or RF-DETR.

It runs on your own computer. Your images and labels stay in a folder on your disk; only the frames you send to Claude for auto-labeling leave the machine.

## Which Claude account is used

The app has no account or key built in. Auto-labeling always runs on **your** Claude account, from the computer you run it on:

| Backend (chosen in the Auto-label dialog) | Uses | Cost |
|---|---|---|
| **Claude subscription** (default) | The Claude Code login on this computer | Counts against your Claude plan's usage limits; no API credits |
| **API key** | `ANTHROPIC_API_KEY` set in the terminal that starts the app | Pay-as-you-go API billing on your Anthropic Console account |

Use the subscription backend for labeling your own training data. If labeling becomes part of a product or service for other people, use the API-key backend on your own Console account.

## Setup

1. **Python 3.9 or newer**, then install the packages (a virtual environment or conda env is recommended):

   ```
   pip install -r requirements.txt
   ```

2. **Claude Code, logged in with your Claude subscription** (needed for the default backend):

   - Install it: `npm install -g @anthropic-ai/claude-code`, or the native installer from the Claude Code docs.
   - Run `claude` once in a terminal, type `/login`, and sign in with your Claude account.
   - Check: `claude --version` prints a version.

   For the **API key** backend instead, create a key at platform.claude.com and set it before starting the app:
   `set ANTHROPIC_API_KEY=sk-ant-...` (Windows) or `export ANTHROPIC_API_KEY=sk-ant-...` (macOS / Linux).
   With the subscription backend, any API key in the terminal is ignored, so it can't be billed by accident.

## Start

```
python annotator_app.py
```

The browser opens at http://127.0.0.1:8765. Options:

- `--root D:\datasets\swish`: where projects are stored (default: a `projects` folder next to the app)
- `--port 8765`: another port
- `--no-browser`: don't open the browser

The app is reachable only from this computer.

## Workflow

1. **Projects page:** click **＋ New project** and pick the classes. The default list is `ball, made, person, rim, shoot`, the SwishStation detector's classes in its own order, so the labels drop into retraining without changes. Each card's **⋯** menu has Open, Import, Export, Rename and Delete.
2. **Import** (inside a project):
   - **Video:** upload a file, or give its path on this computer (faster for big files). One frame is saved every N seconds of video time, with optional start, stop and frame limits.
   - **Images:** drag and drop.
   - **Folder:** give a path. YOLO labels found next to the images are brought in too, so an existing dataset can be corrected.
3. **Auto-label:** Claude boxes the images that are still to do (or the ones you select). Its boxes are marked **Review** until you check them. Images you've marked reviewed are never overwritten by a batch run.
4. **Review:** check each image, fix the boxes, and press **Enter** to mark it reviewed and move to the next. The filters on the left (All / To do / Review / Done) show what's left.
5. **Export:** writes a train / valid / test split. Frames within a few seconds of each other in the same video always stay in the same split, so near-duplicate frames don't leak into validation.

## Editing boxes

| Action | How |
|---|---|
| Draw a box | Drag on the image (Shift+drag draws even on top of another box) |
| Select / move / resize | Click a box, drag it, or pull its handles |
| Change class | Keys 1–9, or the dropdown in the Boxes panel |
| Delete selected box / all boxes | Del / Shift+Del |
| Delete this image | Ctrl+Del |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Previous / next image | A / D |
| Reviewed and next | Enter |
| Auto-label this image | L |
| Copy boxes from the previous image | P |
| Zoom / pan / fit | Mouse wheel / Space+drag / F |
| Hide boxes | H |

To act on many images at once, tick their thumbnails (or Ctrl+click, Shift+click for a range, or **Select all in list**). You can then Auto-label, mark Reviewed, Reset to To do, or Delete them.

Changes save automatically.

## Training on the export

The export folder works for both models:

- **YOLO (Ultralytics, e.g. yolo26):** `data.yaml` plus `train|valid|test/images` and `labels`.

  ```
  yolo detect train data="<export>/data.yaml" model=yolo26n.pt imgsz=640 epochs=100
  ```

- **RF-DETR:** `_annotations.coco.json` in each split folder (Roboflow COCO layout). Class 0 is a placeholder and the real classes start at 1, matching the Roboflow export the current SwishStation checkpoint was trained on.

  ```python
  from rfdetr import RFDETRNano
  RFDETRNano().train(dataset_dir=r"<export>", epochs=100, batch_size=8)
  ```

The Export dialog shows both commands with the real path filled in.

## Usage limits and cost

- **Subscription:** each frame is one Claude Code request. In our tests it took about 6 seconds per frame (Claude Opus 5.5, effort low). Keep **Parallel requests** at 2–3. When your plan's limit is reached, the run stops and says so; frames already labeled are kept, and **Images still to do** continues later.
- **API key:** about $0.016 per 1920×1080 frame on Opus 5.5 (see below). Sonnet 5.5 is about half that.
- Try about 20 frames first and check the boxes before labeling thousands.

### Cost per image

Every labeled image is logged in `usage.csv` (the project folder in the app, the `--out` folder on the command line): image size sent, input and output tokens, and the cost at the API list price. The app's job message and the command line's last line show the average per image.

**Measured on 10 basketball frames** (2026-10-18; Opus 5.5, subscription backend; backboard and rim cameras):

| Effort | Output tokens per frame (min–max, average) |
|---|---|
| low | 86–201, average 148 |
| high | 85–320, average 206 |

The model hardly thinks on these frames, so effort high costs only about $0.001 more per frame than low. The cost is almost all **input**, mainly the image.

**What one frame costs on the API key backend** (Opus 5.5: $4 per million input tokens, $20 per million output; worked out from the measured tokens, not a billed run):

| | Tokens | Cost |
|---|---|---|
| Image, 1920×1080 sent at full size | about 2,700 | $0.011 |
| Prompt: the detection instruction (~100) plus the class rules and scene note (~480) | about 580 | $0.002 |
| Output, effort low / high | about 150 / 200 | $0.003 / $0.004 |
| **Total** | | **about $0.016 (low) / $0.017 (high)** |

- The subscription backend's own token counts are higher (about 6,250 input tokens per frame), because Claude Code adds its tool setup and an extra turn to open the image. Its images are sent at 1456×819. It is not billed per token: it counts against the plan.
- **Cheaper:** a smaller image (1456×819 is about 1,560 image tokens, saving about $0.004 per frame) or shorter class rules (up to about $0.002). Both can make the boxes worse (small far-away balls, the made / not-made rule), so compare the boxes on the same frames before switching.

**Compared with the Roboflow Playground** (which showed $0.0087 per frame for Claude Opus 5.5 on a 1920×1080 frame):
- Roboflow's open-source Claude block ([roboflow/inference](https://github.com/roboflow/inference/blob/main/workflows/roboflow_workflows/core_steps/models/foundation/anthropic_claude/v5.py)) sends detection images the same way as this app: at the size Claude uses internally, with the same 2576 px / 4784-token limit, so a 1920×1080 frame goes at full size. It also uses the same detection prompt (from the vlm-exam benchmark), without the class rules.
- At the API list price, that request is about 2,800 input tokens, which is about $0.011 before any output. The Playground's $0.0087 is below that, so it does something the open-source block doesn't show: it shrinks the upload first, uses its own price, or runs different code. Not known.
- At the same list price, Roboflow's request would cost about $0.013–0.014 per frame and this app's about $0.016. The difference is the class rules.

## Troubleshooting

| Message | Fix |
|---|---|
| "Claude Code CLI not found" | Install Claude Code and make sure `claude --version` works in a new terminal. |
| "Claude Code is not logged in" | Run `claude`, then `/login`. |
| "Subscription usage limit reached" | Wait for your plan's limit to reset, then run **Images still to do** again. |
| "No working Anthropic credentials" | Only for the API-key backend: set `ANTHROPIC_API_KEY` before starting the app. |
| Export refuses the folder | Pick an empty folder (the app only overwrites folders it exported to itself). |

## Files

- `annotator_app.py`: the web app (FastAPI)
- `claude_autolabel.py`: the Claude labeling engine; also works on its own from the command line (`python claude_autolabel.py --help`)
- `static/`: the browser UI
- `projects/` (created on first run): one folder per project with `images/`, `labels/` (YOLO), `project.json`, `usage.csv` (tokens and cost per labeled image) and the default `export/`
