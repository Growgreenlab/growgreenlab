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
}

const SPEEDS = [0.5, 1, 2, 4, 8];

export default function ReplayControls(p: Props) {
  const pct = p.total > 0 ? Math.min(100, ((p.index + 1) / p.total) * 100) : 0;
  return (
    <div className="card">
      <h3>Replay controls</h3>
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
      </div>
      <div className="progress" aria-hidden>
        <i style={{ width: `${pct}%` }} />
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Candle {Math.min(p.index + 1, p.total)} of {p.total} · future candles stay hidden
      </div>
    </div>
  );
}
