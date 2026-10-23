#!/usr/bin/env python3
"""Offline real-video perception/replay. Never synthesizes camera detections or ranges.

Install mediapipe, opencv-python-headless and Pillow in an isolated Python runtime.
The detector uses the app's EfficientDet-Lite0 model, IMAGE mode, CPU, score 0.35,
and at most 12 results. Python inference latency is not phone latency. Rendering
consumes the production TypeScript engine's separately generated decision JSON.
"""

from __future__ import annotations

import argparse
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import sys
import textwrap
import time


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8-sig"))


def write_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, indent=2, allow_nan=False), encoding="utf-8")


def open_video(path):
    import cv2

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        raise RuntimeError(f"Cannot decode video: {path}")
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    return cap, {
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)),
        "sourceFps": fps,
        "sourceFrames": int(frames),
        "sourceDurationSec": frames / fps if fps > 0 else None,
    }


def frame_at(cap, seconds):
    import cv2

    cap.set(cv2.CAP_PROP_POS_MSEC, seconds * 1000)
    ok, frame = cap.read()
    if not ok:
        raise RuntimeError(f"Cannot decode source frame at {seconds:.3f}s")
    return frame


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


@lru_cache(maxsize=24)
def font(size, bold=False):
    from PIL import ImageFont

    for candidate in (["C:/Windows/Fonts/segoeuib.ttf"] if bold else ["C:/Windows/Fonts/segoeui.ttf"]):
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def contact_sheet(args):
    import cv2
    from PIL import Image, ImageDraw

    cap, metadata = open_video(args.video)
    times = [float(value) for value in args.times.split(",")]
    analyzed_frames = [frame for path in args.detections for frame in read_json(path)["frames"]]
    columns, tile_width, tile_height = 3, 480, 306
    sheet = Image.new("RGB", (columns * tile_width, math.ceil(len(times) / columns) * tile_height + 64), "#0b1423")
    draw = ImageDraw.Draw(sheet)
    title = "REAL DETECTOR OUTPUT | Spiegelgasse, Zurich | Albinfo | CC0" if analyzed_frames else "REAL SOURCE VIDEO | Spiegelgasse, Zurich | Albinfo | CC0"
    draw.text((18, 12), title, font=font(24, True), fill="white")
    for index, second in enumerate(times):
        rgb = cv2.cvtColor(frame_at(cap, second), cv2.COLOR_BGR2RGB)
        tile = Image.fromarray(rgb)
        tile.thumbnail((tile_width - 8, 266))
        detected = min(analyzed_frames, key=lambda frame: abs(frame["sourceTimeMs"] / 1000 - second)) if analyzed_frames else None
        if detected is not None and abs(detected["sourceTimeMs"] / 1000 - second) <= .13:
            tile_draw = ImageDraw.Draw(tile)
            for observation in detected["observations"]:
                box = observation["box"]
                x0, y0 = box["x"] * tile.width, box["y"] * tile.height
                x1, y1 = (box["x"] + box["w"]) * tile.width, (box["y"] + box["h"]) * tile.height
                tile_draw.rectangle((x0, y0, x1, y1), outline="#00ffff", width=2)
                label = f"{observation['label']} {observation['confidence']:.2f}"
                label_y = max(0, y0 - 18)
                label_width = tile_draw.textlength(label, font=font(14, True))
                tile_draw.rectangle((x0, label_y, min(tile.width, x0 + label_width + 4), label_y + 19), fill="#0b1423")
                tile_draw.text((x0 + 2, label_y), label, font=font(14, True), fill="#00ffff")
        x, y = index % columns * tile_width, 64 + index // columns * tile_height
        sheet.paste(tile, (x + (tile_width - tile.width) // 2, y))
        suffix = f"{len(detected['observations'])} model observations" if detected is not None and abs(detected["sourceTimeMs"] / 1000 - second) <= .13 else "unannotated frame"
        draw.text((x + 12, y + 269), f"Source {second:06.2f}s | {suffix}", font=font(18), fill="#cbd5e1")
    cap.release()
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(target)
    print(json.dumps({"contactSheet": str(target.resolve()), "timesSec": times, **metadata}), flush=True)


def infer(args):
    import cv2
    import mediapipe as mp
    import numpy as np
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision

    if args.fps <= 0 or args.duration <= 0 or args.start < 0:
        raise ValueError("fps/duration must be positive and start nonnegative")
    cap, source = open_video(args.video)
    duration = min(args.duration, max(0, source["sourceDurationSec"] - args.start)) if source["sourceDurationSec"] else args.duration
    options = vision.ObjectDetectorOptions(
        base_options=python.BaseOptions(model_asset_path=str(Path(args.model).resolve()), delegate=python.BaseOptions.Delegate.CPU),
        running_mode=vision.RunningMode.IMAGE,
        score_threshold=0.35,
        max_results=12,
    )
    frames, latencies = [], []
    started = time.perf_counter()
    with vision.ObjectDetector.create_from_options(options) as detector:
        for index in range(math.ceil(duration * args.fps)):
            relative = index / args.fps
            source_second = args.start + relative
            bgr = frame_at(cap, source_second)
            height, width = bgr.shape[:2]
            rgb = np.ascontiguousarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
            before = time.perf_counter()
            result = detector.detect(image)
            latency = (time.perf_counter() - before) * 1000
            latencies.append(latency)
            observations = []
            for detection in result.detections:
                if not detection.categories or detection.bounding_box is None:
                    continue
                category, bbox = detection.categories[0], detection.bounding_box
                x, y = max(0, bbox.origin_x / width), max(0, bbox.origin_y / height)
                box_width, box_height = min(1 - x, bbox.width / width), min(1 - y, bbox.height / height)
                observations.append({
                    "label": category.category_name,
                    "confidence": float(category.score),
                    "box": {"x": x, "y": y, "w": box_width, "h": box_height},
                    "centerX": x + box_width / 2,
                    "centerY": y + box_height / 2,
                    "bottomCenterX": x + box_width / 2,
                    "bottomCenterY": y + box_height,
                    "timestamp": round(relative * 1000),
                })
            frames.append({"index": index, "timeMs": round(relative * 1000), "sourceTimeMs": round(source_second * 1000),
                           "width": width, "height": height, "latencyMs": round(latency, 3), "observations": observations})
            if index % max(1, round(args.fps * 5)) == 0:
                print(json.dumps({"progress": index, "of": math.ceil(duration * args.fps), "sourceSec": source_second, "detections": len(observations)}), flush=True)
    cap.release()
    ordered = sorted(latencies)
    output = {
        "metadata": {
            "schemaVersion": 1,
            "video": str(Path(args.video).resolve()),
            "videoSha256": sha256(args.video),
            "sourcePage": "https://commons.wikimedia.org/wiki/File:Spiegelgasse.ogv",
            "sourceAuthor": "Albinfo",
            "sourceLicense": "CC0-1.0",
            "sourceLicenseUrl": "https://creativecommons.org/publicdomain/zero/1.0/",
            "model": str(Path(args.model).resolve()),
            "modelSha256": sha256(args.model),
            "runtime": "MediaPipe Python " + str(mp.__version__),
            "detectorMode": "IMAGE", "delegate": "CPU", "scoreThreshold": 0.35, "maxResults": 12,
            "inferenceProvenance": "Actual model detections from real decoded source frames; no invented labels or sensor measurements.",
            "sourceSamplingProvenance": "sourceTimeMs is the requested video timeline sample; decoder frame selection is bounded by source frame granularity, not a hardware exposure timestamp.",
            "latencyProvenance": "Offline desktop CPU inference only; not phone or hardware response latency.",
            "sensorProvenance": "No recorded sonar, IMU, GPS, calibrated depth, or body-relative/world camera pose is present in this video.",
            "startSec": args.start, "durationSec": duration, "sampleFps": args.fps,
            "frameCount": len(frames), "observationCount": sum(len(frame["observations"]) for frame in frames),
            "desktopInferenceMedianMs": ordered[len(ordered) // 2] if ordered else None,
            "desktopInferenceP95Ms": ordered[min(len(ordered) - 1, math.floor(len(ordered) * .95))] if ordered else None,
            "wallSeconds": time.perf_counter() - started,
            **source,
        },
        "frames": frames,
    }
    write_json(args.output, output)
    print(json.dumps({"output": str(Path(args.output).resolve()), **output["metadata"]}), flush=True)


def line(draw, text, x, y, width=43, size=21, color="#cbd5e1", bold=False, spacing=5):
    for part in textwrap.wrap(str(text), width=width, break_long_words=False) or [""]:
        draw.text((x, y), part, font=font(size, bold), fill=color)
        y += size + spacing
    return y


def finite_text(value, suffix="", precision=1):
    return f"{value:.{precision}f}{suffix}" if isinstance(value, (int, float)) and math.isfinite(value) else "UNKNOWN"


def find_ffmpeg(explicit=None):
    if explicit:
        return explicit
    installed = shutil.which("ffmpeg")
    if installed:
        return installed
    local = sorted(Path(".build-tmp/media-runtime/imageio_ffmpeg/binaries").glob("ffmpeg*.exe"))
    if local:
        return str(local[0].resolve())
    raise RuntimeError("ffmpeg is required for H.264 output; provide --ffmpeg")


def render(args):
    import cv2
    import numpy as np
    from PIL import Image, ImageDraw

    detections, decisions = read_json(args.detections), read_json(args.decisions)
    by_index = {frame["index"]: frame for frame in decisions["frames"]}
    cap, _ = open_video(args.video)
    width, height = 1600, 1000
    target = Path(args.output)
    target.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = find_ffmpeg(args.ffmpeg)
    fps = detections["metadata"]["sampleFps"]
    command = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "rawvideo", "-vcodec", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
               "-r", str(fps), "-i", "-", "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(target)]
    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    selected = []
    if args.contact_times:
        requested = [float(value) * 1000 for value in args.contact_times.split(",")]
        contact_indices = {min(detections["frames"], key=lambda frame: abs(frame["timeMs"] - at))["index"] for at in requested}
    else:
        contact_indices = set(round((len(detections["frames"]) - 1) * ratio) for ratio in [0, .2, .4, .6, .8, 1])
    try:
        for frame in detections["frames"]:
            matched = by_index.get(frame["index"])
            if matched is None:
                raise ValueError(f"Missing production decision for frame {frame['index']}")
            state = matched.get("decision", matched.get("result", matched.get("guidance", matched.get("state", matched))))
            sensor = matched.get("sensor", {})
            simulated = str(sensor.get("provenance", "unavailable")).upper() == "SIMULATED"
            tracks = matched.get("tracks", [])
            fused = matched.get("fusedObjects", [])
            scene = matched.get("scene", {})
            if not tracks:
                tracks = scene.get("tracks", [])
            if not fused:
                fused = scene.get("fusedObjects", [])
            fused_by_id = {obj["track"]["trackId"]: obj for obj in fused if obj.get("track")}
            bgr = frame_at(cap, frame["sourceTimeMs"] / 1000)
            image = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
            image.thumbnail((1120, 630))
            canvas = Image.new("RGB", (width, height), "#0b1423")
            draw = ImageDraw.Draw(canvas)
            title = "SMARTSTICK  /  REAL VIDEO + SIMULATED SENSOR TEST" if simulated else "SMARTSTICK  /  REAL WALKING VIDEO REPLAY"
            draw.text((26, 14), title, font=font(27 if simulated else 30, True), fill="#fbbf24" if simulated else "white")
            draw.text((26, 53), f"Replay {frame['timeMs']/1000:05.2f}s  |  Source {frame['sourceTimeMs']/1000:05.2f}s  |  {fps:g} FPS sampled evidence", font=font(21), fill="#94a3b8")
            left, top = (1120 - image.width) // 2, 94 + (630 - image.height) // 2
            canvas.paste(image, (left, top))
            if tracks:
                for track in tracks:
                    box = track["currentBox"]
                    evidence = fused_by_id.get(track["trackId"], {}).get("evidence", track.get("state", "unknown").lower())
                    color = "#38bdf8" if evidence == "confirmed" else "#fbbf24" if evidence == "tentative" else "#f87171"
                    x0, y0 = left + box["x"] * image.width, top + box["y"] * image.height
                    x1, y1 = x0 + box["w"] * image.width, y0 + box["h"] * image.height
                    draw.rectangle((x0, y0, x1, y1), outline=color, width=3)
                    label = f"#{track['trackId']} {track['label']} {track.get('confidence', 0):.2f} | {evidence}"
                    text_box = draw.textbbox((x0, y0), label, font=font(18, True))
                    label_y = max(top, y0 - 26)
                    draw.rectangle((x0, label_y, min(1120, x0 + text_box[2] - text_box[0] + 10), label_y + 26), fill="#0b1423")
                    draw.text((x0 + 4, label_y), label, font=font(18, True), fill=color)
            else:
                for observation in frame["observations"]:
                    box = observation["box"]
                    draw.rectangle((left + box["x"] * image.width, top + box["y"] * image.height, left + (box["x"] + box["w"]) * image.width, top + (box["y"] + box["h"]) * image.height), outline="#fbbf24", width=3)
            draw.rectangle((1120, 0, 1599, 999), fill="#111e32")
            y = line(draw, "PRODUCTION ALGORITHM", 1144, 24, width=28, size=25, color="white", bold=True)
            subtitle = "Real camera detections. Range / motion inputs below are SIMULATED." if simulated else "Real camera detections; independent sensor channels are UNKNOWN."
            y = line(draw, subtitle, 1144, y + 14, width=33, size=21, color="#fbbf24" if simulated else "#cbd5e1")
            severity = str(state.get("severity", "unknown")).upper()
            severity_color = "#f87171" if severity in ["WARNING", "DANGER"] else "#fbbf24" if severity in ["AWARENESS", "UNAVAILABLE"] else "#cbd5e1"
            y = line(draw, severity, 1144, y + 18, width=28, size=32, color=severity_color, bold=True)
            y = line(draw, str(state.get("plan", "UNKNOWN")), 1144, y + 8, width=32, size=22, color="white", bold=True)
            y = line(draw, "Route hold: " + ("YES" if state.get("routeHold") else "NO"), 1144, y + 12, width=32, size=22)
            y = line(draw, "World / body directions: UNKNOWN", 1144, y + 14, width=32, size=21)
            if simulated:
                range_state = str(sensor.get("rangeState", "unknown")).upper()
                usable_range = sensor.get("rangeCm") if range_state == "VALID" else None
                y = line(draw, "SIMULATED range: " + finite_text(usable_range, " cm"), 1144, y + 16, width=32, size=21, color="#fbbf24")
                diagnostics = range_state
                if range_state != "VALID" and sensor.get("rangeCm") is not None:
                    diagnostics += " (last " + finite_text(sensor["rangeCm"], " cm") + ")"
                elif range_state == "VALID" and sensor.get("rangeCm") is None:
                    diagnostics += " / NO RETURN"
                y = line(draw, "Range channel: " + diagnostics, 1144, y + 6, width=34, size=18, color="#fbbf24")
                y = line(draw, "SIMULATED motion: " + str(sensor.get("motion", "UNKNOWN")), 1144, y + 8, width=32, size=21, color="#fbbf24")
                y = line(draw, "Recorded GPS / IMU: unavailable", 1144, y + 8, width=32, size=21)
            else:
                for label in ["Sonar distance: UNKNOWN", "GPS walking speed: UNKNOWN", "IMU / camera mounting: UNKNOWN"]:
                    y = line(draw, label, 1144, y + 8, width=32, size=21)
            hold_reason = state.get("holdReason")
            if hold_reason:
                y = line(draw, "Hold reason: " + str(hold_reason), 1144, y + 12, width=34, size=19)
            reasons = state.get("reasonCodes", state.get("reasons", matched.get("reasons", [])))
            if reasons:
                y = line(draw, "DECISION EVIDENCE", 1144, y + 20, width=32, size=21, color="white", bold=True)
                for reason in reasons[:5]:
                    if y > 850:
                        break
                    y = line(draw, "- " + str(reason), 1144, y + 6, width=32, size=18)
            line(draw, "No physical clearance, depth, drop-off or road-crossing certification.", 1144, 890, width=35, size=18, color="#fbbf24")
            y = line(draw, "EVIDENCE, NOT A 3D MAP", 26, 747, width=70, size=26, color="white", bold=True)
            y = line(draw, f"Actual model observations: {len(frame['observations'])}   |   Tracks: {len(tracks)}   |   Desktop inference: {frame['latencyMs']:.1f} ms", 26, y + 11, width=87, size=22)
            y = line(draw, "Undetected image areas remain UNKNOWN. Camera-side boxes are not measured lanes or free space.", 26, y + 12, width=87, size=21)
            intent = matched.get("speechIntent")
            if intent:
                y = line(draw, "Guidance intent: " + str(intent), 26, y + 10, width=87, size=20, color="#93c5fd")
            else:
                y = line(draw, "Terrain / stairs / drop-offs / overhead hazards: not established by this replay.", 26, y + 10, width=87, size=21, color="#fbbf24")
            if simulated and sensor.get("phase"):
                line(draw, sensor["phase"], 26, 925, width=110, size=18, color="#fbbf24")
            line(draw, "Source: Spiegelgasse, Zurich | Albinfo | CC0 | sample / annotation added for evaluation", 26, 959, width=105, size=17, color="#94a3b8")
            if frame["index"] in contact_indices:
                selected.append(canvas.copy())
            process.stdin.write(np.asarray(canvas).tobytes())
            if frame["index"] % max(1, round(fps * 5)) == 0:
                print(json.dumps({"renderedFrame": frame["index"], "of": len(detections["frames"]), "output": str(target)}), flush=True)
        process.stdin.close()
        code = process.wait()
        if code:
            raise RuntimeError(f"ffmpeg exited {code}")
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        cap.release()
    if selected:
        sheet = Image.new("RGB", (1600, 1500), "#0b1423")
        for index, image in enumerate(selected):
            image.thumbnail((800, 500))
            sheet.paste(image, ((index % 2) * 800, (index // 2) * 500))
        sheet.save(target.with_suffix(".contact-sheet.jpg"), quality=92)
    print(json.dumps({"video": str(target.resolve()), "frames": len(detections["frames"]), "fps": fps, "contactSheet": str(target.with_suffix('.contact-sheet.jpg').resolve())}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    contact = sub.add_parser("contact-sheet")
    contact.add_argument("--video", required=True)
    contact.add_argument("--output", required=True)
    contact.add_argument("--times", default="0,15,30,45,60,90,115")
    contact.add_argument("--detections", nargs="*", default=[])
    contact.set_defaults(action=contact_sheet)
    inference = sub.add_parser("infer")
    inference.add_argument("--video", required=True)
    inference.add_argument("--output", required=True)
    inference.add_argument("--model", default="public/models/efficientdet_lite0.tflite")
    inference.add_argument("--start", type=float, default=0)
    inference.add_argument("--duration", type=float, default=60)
    inference.add_argument("--fps", type=float, default=4)
    inference.set_defaults(action=infer)
    rendering = sub.add_parser("render")
    rendering.add_argument("--video", required=True)
    rendering.add_argument("--detections", required=True)
    rendering.add_argument("--decisions", required=True)
    rendering.add_argument("--output", required=True)
    rendering.add_argument("--ffmpeg")
    rendering.add_argument("--contact-times", help="Comma-separated relative replay seconds for the six contact-sheet frames")
    rendering.set_defaults(action=render)
    args = parser.parse_args()
    args.action(args)


if __name__ == "__main__":
    main()
