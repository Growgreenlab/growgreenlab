"use client";

interface Props {
  playing: boolean;
  canPlay: boolean;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onReset: () => void;
  speed: number;
  onSpeed: (s: number) => void;
  index: number;
  total: number;
  /** 0..1 overall progress (includes intra-candle formation). */
  progress?: number;
  /** Slim single-row strip for the trading workspace (no card chrome). */
  compact?: boolean;
}

const SPEEDS = [0.5, 1, 2, 4, 8];

export default function ReplayControls(p: Props) {
  const pct = Math.min(100, Math.max(0,
    p.progress != null ? p.progress * 100 : ((p.index + 1) / Math.max(1, p.total)) * 100
  ));
  const bar = (
    <>
      <div className="controlsbar">
        {!p.playing ? (
          <button className="btn primary ctl-btn ctl-play" disabled={!p.canPlay} onClick={p.onPlay} title="Play">
            ▶
          </button>
        ) : (
          <button className="btn ctl-btn ctl-play" onClick={p.onPause} title="Pause">
            ⏸
          </button>
        )}
        <button className="btn ctl-btn" disabled={!p.canPlay} onClick={p.onNext} title="Next candle">
          ⏭
        </button>
        <button className="btn ctl-btn" disabled={!p.canPlay} onClick={p.onReset} title="Reset replay">
          ⟲
        </button>
        <div className="seg" role="group" aria-label="Replay speed">
          {SPEEDS.map((s) => (
            <button
              key={s}
              className={p.speed === s ? "on" : ""}
              onClick={() => p.onSpeed(s)}
              disabled={!p.canPlay}
              title={`${s}x speed`}
            >
              {s}x
            </button>
          ))}
        </div>
        <div className="ctl-count num">Candle {Math.min(p.index + 2, p.total)} / {p.total}</div>
      </div>
      <div className="progress" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
    </>
  );
  if (p.compact) return <div className="ws-controls">{bar}</div>;
  return (
    <div className="card">
      <h3>Replay controls</h3>
      {bar}
      <div className="hint" style={{ marginTop: 8 }}>
        Candle {Math.min(p.index + 2, p.total)} of {p.total} · 1x = live market speed (60s per candle) · future candles stay hidden
      </div>
    </div>
  );
}
