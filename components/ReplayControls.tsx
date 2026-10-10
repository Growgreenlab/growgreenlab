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
  return (
    <div className="card">
      <h3>Replay controls</h3>
      <div className="controlsbar">
        {!p.playing ? (
          <button className="btn primary" disabled={!p.canPlay} onClick={p.onPlay}>
            ▶ Play
          </button>
        ) : (
          <button className="btn" onClick={p.onPause}>
            ⏸ Pause
          </button>
        )}
        <button className="btn" disabled={!p.canPlay} onClick={p.onNext}>
          Next candle ⏭
        </button>
        <button className="btn" disabled={!p.canPlay} onClick={p.onReset}>
          ⟲ Reset
        </button>
        <select
          className="select speedsel"
          value={p.speed}
          onChange={(e) => p.onSpeed(Number(e.target.value))}
          aria-label="Replay speed"
        >
          {SPEEDS.map((s) => (
            <option key={s} value={s}>
              {s}x
            </option>
          ))}
        </select>
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Candle {Math.min(p.index + 1, p.total)} of {p.total} · future candles stay hidden
      </div>
    </div>
  );
}
