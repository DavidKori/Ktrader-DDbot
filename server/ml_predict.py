"""
LightGBM Inference Service — TradeWithKen
==========================================
Two endpoints:
  POST /predict           direction probability (long-side success)
  POST /predict_duration  optimal tick count + max hold seconds

Both return safe defaults until you train and drop in real model files.

Run:
    pip install fastapi uvicorn lightgbm pydantic numpy
    uvicorn ml_predict:app --host 0.0.0.0 --port 8001

Environment:
    LGBM_DIRECTION_MODEL_PATH   default: models/direction.txt
    LGBM_DURATION_MODEL_PATH    default: models/duration.txt
"""
from __future__ import annotations
import os
from pathlib import Path
from typing import Optional

import numpy as np
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

try:
    import lightgbm as lgb
except Exception:
    lgb = None  # type: ignore

DIRECTION_PATH = Path(os.getenv("LGBM_DIRECTION_MODEL_PATH", "models/direction.txt"))
DURATION_PATH  = Path(os.getenv("LGBM_DURATION_MODEL_PATH",  "models/duration.txt"))

app = FastAPI(title="TradeWithKen ML Inference")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"], allow_credentials=False,
    allow_methods=["POST", "GET"], allow_headers=["*"],
)


# ────── Direction model ──────
class DirectionFeatures(BaseModel):
    rsi: float
    macd_hist: float
    bollinger_bw: float
    bollinger_pos: float
    atr: float
    adx: float
    ema_diff: float
    ema_diff_pct: float
    vol_z: float
    vol_regime_num: float
    momentum_5: float
    momentum_20: float


class DirectionPrediction(BaseModel):
    probability: float
    confidence: str
    risk_score: float


DIRECTION_FEATURE_ORDER = [
    "rsi", "macd_hist", "bollinger_bw", "bollinger_pos",
    "atr", "adx", "ema_diff", "ema_diff_pct",
    "vol_z", "vol_regime_num", "momentum_5", "momentum_20",
]


# ────── Duration model ──────
class DurationFeatures(BaseModel):
    rsi: float
    macd_hist: float
    atr: float
    adx: float
    bollinger_bw: float
    vol_z: float
    regime: str
    tickIntervalSec: float


class DurationPrediction(BaseModel):
    duration_ticks: int
    max_hold_sec: int
    rationale: str


DURATION_FEATURE_ORDER = [
    "rsi", "macd_hist", "atr", "adx", "bollinger_bw", "vol_z", "tickIntervalSec",
    # regime is one-hot encoded into these 6 slots
    "regime_trending_bull", "regime_trending_bear", "regime_mean_reverting",
    "regime_volatile_breakout", "regime_choppy_low_vol", "regime_unknown",
]


def _load_model(path: Path) -> Optional["lgb.Booster"]:
    if lgb is None or not path.exists():
        return None
    try:
        return lgb.Booster(model_file=str(path))
    except Exception:
        return None


DIRECTION_MODEL: Optional["lgb.Booster"] = _load_model(DIRECTION_PATH)
DURATION_MODEL:  Optional["lgb.Booster"] = _load_model(DURATION_PATH)


@app.post("/predict", response_model=DirectionPrediction)
def predict(f: DirectionFeatures) -> DirectionPrediction:
    if DIRECTION_MODEL is None:
        return DirectionPrediction(probability=0.5, confidence="low", risk_score=0.5)
    row = [getattr(f, n) for n in DIRECTION_FEATURE_ORDER]
    x = np.array([row], dtype=np.float64)
    p = float(DIRECTION_MODEL.predict(x)[0])
    p = max(0.0, min(1.0, p))
    confidence = "high" if p >= 0.80 else "medium" if p >= 0.65 else "low"
    return DirectionPrediction(probability=p, confidence=confidence, risk_score=1.0 - p)


@app.post("/predict_duration", response_model=DurationPrediction)
def predict_duration(f: DurationFeatures) -> DurationPrediction:
    # Deterministic fallback rule when no model is trained yet — produces sane
    # values that match the TS planner in duration-model.ts.
    if DURATION_MODEL is None:
        base = 5
        if f.adx > 35:  base = 9
        elif f.adx > 25: base = 7
        elif f.adx < 15: base = 4
        if f.vol_z > 2:  base += 1
        if f.vol_z < -1: base -= 1
        base = max(3, min(15, base))
        hold = int(120 + min(50, max(5, f.adx)) * 12 - f.bollinger_bw * 1500)
        hold = max(60, min(1800, hold))
        return DurationPrediction(duration_ticks=base, max_hold_sec=hold,
                                  rationale="deterministic fallback")

    regimes = ["trending_bull", "trending_bear", "mean_reverting",
               "volatile_breakout", "choppy_low_vol", "unknown"]
    one_hot = [1.0 if f.regime == r else 0.0 for r in regimes]
    row = [f.rsi, f.macd_hist, f.atr, f.adx, f.bollinger_bw,
           f.vol_z, f.tickIntervalSec, *one_hot]
    x = np.array([row], dtype=np.float64)
    raw = DURATION_MODEL.predict(x)[0]
    # Model is expected to be a regressor that outputs [duration_ticks, max_hold_sec]
    # via 2 separate boosters or by a single multi-output regressor. Default to
    # interpreting the first cell as duration; safe-clamp.
    try:
        dt = int(np.clip(raw[0] if hasattr(raw, "__len__") else raw, 3, 15))
        mh = int(np.clip(raw[1] if hasattr(raw, "__len__") else 240, 60, 1800))
    except Exception:
        dt, mh = 5, 240
    return DurationPrediction(duration_ticks=dt, max_hold_sec=mh,
                              rationale="lightgbm-trained")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {
        "status": "ok",
        "direction_model_loaded": str(DIRECTION_MODEL is not None),
        "duration_model_loaded":  str(DURATION_MODEL  is not None),
    }
