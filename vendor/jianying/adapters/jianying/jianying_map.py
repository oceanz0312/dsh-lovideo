#!/usr/bin/env python3
"""剪映 adapter: Remotion-native timeline.json (schema 1/2) -> pyJianYingDraft ScriptFile.

Core loop only: builds tracks/segments for the core track types and hands every clip
field to the effect module that owns it (effects_runtime.load_registry()). 剪映 names
live only in each module's adapter.py ``JIANYING`` table.

Variant export rule: mapped iff the module has a JIANYING entry AND (variant status is
mvp/experimental OR v4_confirmed). Otherwise the variant's fallback chain is followed;
unknown ids never raise and are reported in ExportReport.degraded.
"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from effects_runtime import Effect, load_fonts, load_registry  # noqa: E402

_VIDEO_EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def ensure_audio_file(local: str, kind: str | None) -> str | None:
    """剪映 audio segments require an audio-only material. Generated videos
    also carry the source audio, so extract that track into ``.m4a`` first.
    Returns None when the file has no audio track."""
    if kind != "video" and os.path.splitext(local)[1].lower() not in _VIDEO_EXTS:
        return local
    out = f"{os.path.splitext(local)[0]}.m4a"
    if os.path.isfile(out) and os.path.getsize(out) > 0:
        return out
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", local, "-vn",
             "-c:a", "aac", "-b:a", "192k", out],
            capture_output=True,
            text=True,
        )
    except OSError:
        return None
    if proc.returncode != 0 or not os.path.isfile(out) or os.path.getsize(out) == 0:
        return None
    return out


@dataclass
class ExportReport:
    degraded: list[str] = field(default_factory=list)
    experimental: list[str] = field(default_factory=list)
    mapped: list[str] = field(default_factory=list)


class Ctx:
    """Per-(effect, clip) context handed to adapter.py hooks."""

    def __init__(self, jy: Any, script: Any, report: ExportReport, sec: int) -> None:
        self.jy, self.script, self.report, self.sec = jy, script, report, sec
        self.effect: Effect | None = None
        self.where = ""
        self.prev: Any = None
        self.track_name = ""
        self._tracks: set[str] = set()
        # last occupied µs per track: keeps contiguous clips from overlapping
        self._cursor: dict[str, int] = {}

    def us(self, s: Any) -> int:
        return int(round(float(s) * self.sec))

    def place(self, clip: dict[str, Any], track: str) -> tuple[int, int]:
        """µs span of a clip, snapped so back-to-back clips meet exactly.

        pyJianYingDraft's Timerange.overlaps() is a strict ``end <= start`` test.
        Rounding each clip's start and duration to µs separately leaves a 1µs
        seam between contiguous clips (e.g. 6.4056666 + 6.4056666 s), and that
        aborts the whole export with SegmentOverlap.
        """
        start = self.us(clip.get("start", 0))
        end = start + max(1, self.us(clip.get("dur", 1)))
        cursor = self._cursor.get(track, 0)
        if start < cursor:
            start = cursor
        if end <= start:  # a genuinely overlapping clip: keep a 1µs stub
            end = start + 1
        self._cursor[track] = end
        return start, end

    def cursor(self, track: str) -> int:
        return self._cursor.get(track, 0)

    def timerange(self, clip: dict[str, Any]):
        from pyJianYingDraft.time_util import Timerange
        start, end = self.place(clip, self.track_name)
        return Timerange(start, end - start)

    def enum(self, mapping: dict[str, Any]):
        return getattr(self.jy, mapping["enum"])[mapping["name"]]

    def ensure_track(self, kind: str) -> None:
        if self.track_name not in self._tracks:
            self.script.append_track(self.jy.TrackSpec(getattr(self.jy.TrackType, kind), self.track_name))
            self._tracks.add(self.track_name)

    def resolve(self, vid: str | None) -> dict[str, Any] | None:
        eff, rep = self.effect, self.report
        assert eff is not None
        orig = vid
        if vid in eff.aliases:
            vid = eff.aliases[vid]
        seen: set[str] = set()
        while vid and vid != "none" and vid not in seen:
            seen.add(vid)
            var = eff.variants.get(vid)
            m = eff.jianying.get(vid)
            if var and m and (var["status"] in ("mvp", "experimental") or m.get("v4_confirmed")):
                if vid != orig and orig not in eff.aliases:
                    rep.degraded.append(f"{self.where}: {orig} -> {vid} (fallback)")
                if var["status"] == "experimental":
                    rep.experimental.append(f"{self.where}: {vid}")
                rep.mapped.append(f"{self.where}: {vid}")
                return m
            vid = var.get("fallback") if var else None
        if orig and orig != "none":
            rep.degraded.append(f"{self.where}: {orig} -> dropped (no exportable 剪映 mapping)")
        return None


def _effects_for(reg: list[Effect], target: str) -> list[Effect]:
    return [e for e in reg if target in e.target]


def _present(e: Effect, clip: dict[str, Any]) -> bool:
    return any(clip.get(f) not in (None, [], {}) for f in e.fields())


def build_script(
    jy: Any,
    script: Any,
    doc: dict[str, Any],
    resolve_media: Callable[[str], str | None],
    is_bgm_clip: Callable[[dict[str, Any]], bool],
    registry: list[Effect] | None = None,
) -> ExportReport:
    from pyJianYingDraft.time_util import SEC, Timerange

    reg = registry if registry is not None else load_registry()
    fonts = load_fonts()
    rep = ExportReport()
    ctx = Ctx(jy, script, rep, SEC)

    def run_hooks(target: str, clip: dict[str, Any], where: str, seg: Any = None,
                  phase: str = "apply") -> dict[str, Any]:
        kwargs: dict[str, Any] = {}
        for e in _effects_for(reg, target):
            if not _present(e, clip):
                continue
            hook = getattr(e.py, phase, None)
            if hook is None:
                continue
            ctx.effect, ctx.where = e, where
            if e.status == "experimental" and phase == ("pre" if hasattr(e.py, "pre") else "apply") \
                    and not e.variants:
                rep.experimental.append(f"{where}: {e.id}={clip.get(e.field)}")
            value = clip.get(e.field)
            if phase == "pre":
                kwargs.update(hook(ctx, value, clip) or {})
            else:
                hook(ctx, seg, value, clip)
        return kwargs

    def fit_source(material: Any, offset: int, dur: int, speed: float,
                   where: str) -> tuple[int, int] | None:
        """(source span, target duration) clamped to the material's length.

        pyJianYingDraft raises if the source range ends past the file, which aborts
        the whole export; a BGM clip probed at 38.434s over a 38.400s file did that.
        Returns None when the offset is already past the end.
        """
        src = int(round(dur * speed))
        room = int(material.duration) - offset
        if room <= 0:
            rep.degraded.append(f"{where}: offset past end of media -> skipped")
            return None
        if src > room:
            rep.degraded.append(f"{where}: trimmed {(src - room) // 1000}ms past end of media")
            src = room
            dur = max(1, int(src / speed))
        return src, dur

    def visual_track(track: dict[str, Any], tname: str) -> None:
        segs: list[Any] = []
        clips = sorted(track.get("clips") or [], key=lambda c: float(c.get("start", 0)))
        for i, clip in enumerate(clips):
            where = f"{tname}[{clip.get('id', i)}]"
            local = resolve_media((clip.get("media") or {}).get("asset") or "")
            if not local:
                rep.degraded.append(f"{where}: media missing -> skipped")
                continue
            kw = run_hooks("visual", clip, where, phase="pre")
            start, end = ctx.place(clip, tname)
            dur = end - start
            speed = float(kw.pop("speed", 1.0))
            trim = ctx.us((clip.get("media") or {}).get("trimStart") or 0)
            # 独立音轨可以使用视频里的声音；画面轨按显式 muted 去重。
            if (clip.get("media") or {}).get("muted"):
                kw["volume"] = 0.0
            material = jy.VideoMaterial(local)
            fit = fit_source(material, trim, dur, speed, where)
            if not fit:
                continue
            src, dur = fit
            seg = jy.VideoSegment(material, Timerange(start, dur),
                                  source_timerange=Timerange(trim, src), **kw)
            run_hooks("visual", clip, where, seg)
            ctx.prev = segs[-1] if segs else None
            run_hooks("transition", clip, where, seg)
            segs.append(seg)
        if segs:
            ref = script.append_track(jy.TrackSpec(jy.TrackType.video, tname))
            for s in segs:
                script.add_segment(s, ref)

    def style_kwargs(st: Any, where: str = "") -> dict[str, Any]:
        """Core text style (structural, not an effect)."""
        if not isinstance(st, dict):
            return {}
        def rgb(c: Any, d=(1.0, 1.0, 1.0)):
            if not isinstance(c, str) or not c.startswith("#") or len(c) < 7:
                return d
            return tuple(int(c[i:i + 2], 16) / 255 for i in (1, 3, 5))
        kw: dict[str, Any] = {"style": jy.TextStyle(
            size=float(st.get("size", 6.0)), bold=bool(st.get("bold")), italic=bool(st.get("italic")),
            color=rgb(st.get("color")),
            align={"left": 0, "center": 1, "right": 2}.get(st.get("align", "center"), 1))}
        if st.get("stroke"):
            kw["border"] = jy.TextBorder(color=rgb(st["stroke"].get("color"), (0, 0, 0)),
                                         width=float(st["stroke"].get("width", 40)))
        if st.get("bg"):
            kw["background"] = jy.TextBackground(color=st["bg"].get("color", "#000000"),
                                                 alpha=float(st["bg"].get("alpha", 1.0)))
        if st.get("shadow"):
            kw["shadow"] = jy.TextShadow()
        fid = st.get("font")
        if fid:
            name = (fonts.get(fid) or {}).get("jianying")
            if name and name in jy.FontType.__members__:
                kw["font"] = jy.FontType[name]
                rep.degraded.append(f"{where}: font {fid} -> 剪映 {name} (approx)")
            else:
                rep.degraded.append(f"{where}: font {fid} -> 剪映 default font")
        return kw

    def text_track(clips: list[dict[str, Any]], tname: str, track_style: Any, with_effects: bool) -> None:
        refs: list[Any] = []
        for i, clip in enumerate(sorted(clips, key=lambda c: float(c.get("start", 0)))):
            where = f"{tname}[{clip.get('id', i)}]"
            # First text track with room: only genuinely overlapping captions stack,
            # contiguous ones must share a track instead of rounding into a new one.
            start = ctx.us(clip.get("start", 0))
            slot = next(
                (j for j in range(len(refs)) if start >= ctx.cursor(f"{tname}_{j}")),
                None,
            )
            if slot is None:
                ref = script.append_track(jy.TrackSpec(jy.TrackType.text, f"{tname}_{len(refs)}"))
                refs.append(ref)
                slot = len(refs) - 1
            kw = style_kwargs(clip.get("style") or track_style or {}, where)
            if with_effects:
                kw.update(run_hooks("text", clip, where, phase="pre"))
            anchor = clip.get("anchor") or {"x": 0.5, "y": 0.5 if with_effects else 0.9}
            settings = kw.get("clip_settings") or jy.ClipSettings()
            # Jianying uses canvas-half translations, with positive Y upwards.
            settings.transform_x += (float(anchor["x"]) - 0.5) * 2
            settings.transform_y += (0.5 - float(anchor["y"])) * 2
            kw["clip_settings"] = settings
            begin, end = ctx.place(clip, f"{tname}_{slot}")
            seg = jy.TextSegment(str(clip.get("text", "")), Timerange(begin, end - begin), **kw)
            if with_effects:
                run_hooks("text", clip, where, seg)
            script.add_segment(seg, refs[slot])

    audio_refs: dict[str, Any] = {}
    order = {"scene": 0, "overlay": 1, "fx": 2, "filter": 3, "text": 4, "subtitle": 5, "audio": 6}
    n_overlay = 0
    for track in sorted(doc.get("tracks") or [], key=lambda t: order.get(t.get("type"), 9)):
        ttype = track.get("type")
        if ttype == "scene":
            visual_track(track, "main")
        elif ttype == "overlay":
            n_overlay += 1
            visual_track(track, f"pip{n_overlay}")
        elif ttype == "text":
            text_track(track.get("clips") or [], f"text_{track.get('id', 't')}", None, True)
        elif ttype == "subtitle" and track.get("hidden"):
            continue  # 用户关掉了字幕，草稿里不带
        elif ttype == "subtitle":
            text_track(track.get("clips") or [], f"subtitle_{track.get('id', 's')}",
                       track.get("style") or {"size": 6, "align": "center"}, False)
        elif ttype in ("fx", "filter"):
            owners = [e for e in _effects_for(reg, "track") if e.field == ttype]
            for i, clip in enumerate(track.get("clips") or []):
                ctx.where = f"{ttype}_{track.get('id', '0')}[{clip.get('id', i)}]"
                ctx.track_name = f"{ttype}_{track.get('id', '0')}"
                vid = clip.get("effect") if ttype == "fx" else clip.get("filter")
                # several modules may own a track type: dispatch by vocab id, else first owner
                mine = [e for e in owners if vid in e.variants or vid in e.aliases] or owners[:1]
                if not owners:
                    rep.degraded.append(f"{ctx.where}: no effect module owns track type {ttype}")
                for e in mine:
                    ctx.effect = e
                    e.py.apply_track(ctx, clip)
        elif ttype == "audio":
            for i, clip in enumerate(track.get("clips") or []):
                where = f"audio[{clip.get('id', i)}]"
                aid = str(clip.get("asset") or "")
                local = resolve_media(aid)
                if not local:
                    rep.degraded.append(f"{where}: media missing -> skipped")
                    continue
                kind = ((doc.get("assets") or {}).get(aid) or {}).get("kind")
                local = ensure_audio_file(local, kind)
                if not local:
                    rep.degraded.append(f"{where}: no audio track -> skipped")
                    continue
                role = track.get("role") or ("bgm" if is_bgm_clip(clip) else "source")
                kw = run_hooks("audio", clip, where, phase="pre")
                speed = float(kw.pop("speed", 1.0))
                begin, end = ctx.place(clip, f"audio_{role}")
                offset = ctx.us(clip.get("offset", 0))
                material = jy.AudioMaterial(local)
                fit = fit_source(material, offset, end - begin, speed, where)
                if not fit:
                    continue
                src, dur = fit
                seg = jy.AudioSegment(
                    material, Timerange(begin, dur),
                    source_timerange=Timerange(offset, src),
                    volume=10 ** (float(clip.get("gain", 0)) / 20), **kw)
                run_hooks("audio", clip, where, seg)
                if role not in audio_refs:
                    audio_refs[role] = script.append_track(jy.TrackSpec(jy.TrackType.audio, role))
                script.add_segment(seg, audio_refs[role])
        elif ttype == "sticker":
            if track.get("clips"):
                rep.degraded.append("sticker track: not exported to 剪映 (Do-not-do: no stable resource_id)")
        else:
            rep.degraded.append(f"track type {ttype}: unknown -> skipped")
    return rep
