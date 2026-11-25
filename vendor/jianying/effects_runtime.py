#!/usr/bin/env python3
"""Load the effect registry (effects/effects.gen.json, generated from
src/features/editor/effects/modules/*) and expose each module's adapter.py.

The 剪映 adapter iterates ``load_registry()``; it never names an effect.
adapter.py contract (checked by effects_contract.py):
  JIANYING: dict[variant_id, mapping]   (may be {} for parametric effects)
  pre(ctx, value, clip) -> dict          optional, segment-constructor kwargs
  apply(ctx, seg, value, clip)           optional, post-construction hook
  apply_track(ctx, track_clip)           required iff target contains 'track'
  ALSO_FIELDS: tuple[str, ...]           optional, extra clip fields that trigger the module
"""
from __future__ import annotations

import json
import os
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any

DEFAULT_BUNDLE = Path(__file__).resolve().parent / "effects" / "effects.gen.json"


@dataclass
class Effect:
    id: str
    target: list[str]
    field: str
    status: str
    gate: str | None
    aliases: dict[str, str | None]
    variants: dict[str, dict[str, Any]]
    py: types.ModuleType

    @property
    def jianying(self) -> dict[str, dict[str, Any]]:
        return getattr(self.py, "JIANYING", {})

    def fields(self) -> tuple[str, ...]:
        return (self.field, *getattr(self.py, "ALSO_FIELDS", ()))


def load_registry(bundle: Path | None = None) -> list[Effect]:
    path = Path(os.environ.get("LOVIDEO_EFFECTS_BUNDLE") or bundle or DEFAULT_BUNDLE)
    data = json.loads(path.read_text(encoding="utf-8"))
    out: list[Effect] = []
    for meta in data["registry"]:
        mod = types.ModuleType(f"lovideo_effect_{meta['id']}")
        exec(compile(data["python"][meta["id"]], f"effects/{meta['id']}/adapter.py", "exec"),
             mod.__dict__)
        out.append(Effect(
            id=meta["id"], target=list(meta["target"]), field=meta["field"],
            status=meta["status"], gate=meta.get("gate"), aliases=meta.get("aliases") or {},
            variants={v["id"]: v for v in meta["variants"]}, py=mod))
    return out


def load_fonts(bundle: Path | None = None) -> dict[str, dict[str, Any]]:
    """Template font ids -> {family, jianying FontType name | None} (remotion/fonts.ts)."""
    path = Path(os.environ.get("LOVIDEO_EFFECTS_BUNDLE") or bundle or DEFAULT_BUNDLE)
    return json.loads(path.read_text(encoding="utf-8")).get("fonts") or {}
