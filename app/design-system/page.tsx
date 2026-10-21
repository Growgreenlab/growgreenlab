/**
 * /design-system — redesign Phase 0 specimen page (preview only).
 * Renders the v2 tokens + UI-kit primitives inside the opt-in
 * scopes ([data-theme="light"], [data-stage]) so the owner can QA
 * the foundations before any production page migrates.
 * NOT linked from production navigation; noindex.
 */
import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import { Badge, Banner, Button, Card, Input, Select, Table, Th, Td, PnlCell } from "../../components/ui";
import Demo from "./Demo";

export const metadata: Metadata = {
  title: "Design System (preview)",
  robots: { index: false, follow: false },
};

/* ---------- specimen helpers (page-local, not primitives) ---------- */

const row: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12 };
const section: CSSProperties = { marginTop: 32 };
const h2: CSSProperties = { fontSize: "var(--fs-h2)", color: "var(--ink-900)", letterSpacing: "-0.02em", margin: "0 0 12px" };
const note: CSSProperties = { fontSize: "var(--fs-small)", color: "var(--ink-500)", margin: "0 0 12px", maxWidth: 720, lineHeight: 1.55 };

function Swatch({ name, hex, varRef }: { name: string; hex: string; varRef: string }) {
  return (
    <div style={{ width: 150 }}>
      <div
        style={{
          height: 56,
          borderRadius: "var(--r-md)",
          border: "1px solid var(--border)",
          background: `var(${varRef})`,
        }}
      />
      <div className="ui-spec-name">{name}</div>
      <div className="ui-spec-sub">
        {varRef} · {hex}
      </div>
    </div>
  );
}

/** Tiny candle strip rendered from the scope's own chart tokens. */
function CandleStrip() {
  const candles = [
    { up: true, body: 22, wick: 34, x: 8 },
    { up: true, body: 30, wick: 40, x: 30 },
    { up: false, body: 12, wick: 24, x: 52 },
    { up: true, body: 38, wick: 48, x: 74 },
    { up: true, body: 46, wick: 56, x: 96 },
  ];
  return (
    <svg width="120" height="72" aria-label="Candle pair specimen">
      {candles.map((c, i) => {
        const color = c.up ? "var(--chart-up)" : "var(--chart-down)";
        const top = 64 - c.wick;
        return (
          <g key={i}>
            <line x1={c.x + 5} x2={c.x + 5} y1={top} y2={top + c.wick} stroke={color} strokeWidth="1.5" />
            <rect x={c.x} y={top + (c.wick - c.body) / 2} width="10" height={c.body} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}

function KitSection({ title, children, blurb }: { title: string; children: ReactNode; blurb?: string }) {
  return (
    <section style={section}>
      <h2 style={h2}>{title}</h2>
      {blurb && <p style={note}>{blurb}</p>}
      {children}
    </section>
  );
}

/* ---------- page ---------- */

export default function DesignSystemPage() {
  return (
    <div
      data-theme="light"
      style={{
        background: "var(--bg)",
        color: "var(--ink-700)",
        borderRadius: "var(--r-lg)",
        padding: "32px 28px 48px",
        lineHeight: 1.55,
      }}
    >
      <p className="ui-eyebrow">Grow Green Lab — Redesign v2 · Phase 0</p>
      <h1 style={{ fontSize: "var(--fs-h1)", color: "var(--ink-900)", letterSpacing: "-0.02em", margin: "0 0 8px" }}>
        Design system specimen
      </h1>
      <p style={{ ...note, marginBottom: 0 }}>
        Preview only — not linked from navigation. Everything below renders from the new token system
        (Direction v2, Palette A — Lavender) through the UI-kit primitives. No production page uses
        these yet.
      </p>

      <KitSection title="Surfaces & ink">
        <div style={row}>
          <Swatch name="Page bg" hex="#FAFAF8" varRef="--bg" />
          <Swatch name="Surface" hex="#FFFFFF" varRef="--surface" />
          <Swatch name="Surface 2" hex="#F4F4F2" varRef="--surface-2" />
          <Swatch name="Border" hex="#E4E1EA" varRef="--border" />
          <Swatch name="Ink 900" hex="#12284B" varRef="--ink-900" />
          <Swatch name="Ink 700" hex="#33415C" varRef="--ink-700" />
          <Swatch name="Ink 500" hex="#5F6E8A" varRef="--ink-500" />
          <Swatch name="Ink 300" hex="#9AA5B8" varRef="--ink-300" />
        </div>
      </KitSection>

      <KitSection
        title="Accent — Palette A · Lavender (adopted, D3)"
        blurb="Palette B (Muted Purple/Plum — #6E548F / #8A6FA8 / #64497F / #F1EBF5) was the documented alternate and is not tokenized."
      >
        <div style={row}>
          <Swatch name="Accent 600" hex="#6558C9" varRef="--accent-600" />
          <Swatch name="Accent 500" hex="#7C6BD9" varRef="--accent-500" />
          <Swatch name="Accent ink" hex="#5749B8" varRef="--accent-ink" />
          <Swatch name="Accent soft" hex="#EFEDFB" varRef="--accent-soft" />
        </div>
      </KitSection>

      <KitSection title="Trading semantics — the only green/red">
        <div style={row}>
          <Swatch name="Up ink (P&L text)" hex="#0B7A55" varRef="--up-ink" />
          <Swatch name="Down ink (P&L text)" hex="#C62A3A" varRef="--down-ink" />
          <Swatch name="Danger / Sell" hex="#C23333" varRef="--danger" />
          <Swatch name="Warn ink" hex="#96690A" varRef="--warn-ink" />
          <Swatch name="Chart up (light)" hex="#089981" varRef="--chart-up" />
          <Swatch name="Chart down (light)" hex="#F23645" varRef="--chart-down" />
        </div>
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: "var(--fs-small)", fontWeight: 600, color: "var(--ink-900)", marginBottom: 6 }}>
            Candle pair on light
          </div>
          <CandleStrip />
        </div>
      </KitSection>

      <KitSection
        title="Dark chart stage (bounded exception, D2)"
        blurb="One framed region inside a light page — the existing candle pair (#2EBD85 / #F6465D) is preserved on the stage. Order panels, controls, banners and modals never enter the stage."
      >
        <div data-stage className="ui-stage" style={{ padding: 20 }}>
          <div style={row}>
            <Swatch name="Stage bg" hex="#0F141A" varRef="--stage-bg" />
            <Swatch name="Stage surface" hex="#161D26" varRef="--stage-surface" />
            <Swatch name="Stage border" hex="#26303A" varRef="--stage-border" />
            <Swatch name="Stage ink" hex="#E6EDF3" varRef="--stage-ink" />
            <Swatch name="Stage muted" hex="#8B98A5" varRef="--stage-muted" />
          </div>
          <div style={{ marginTop: 16, fontSize: "var(--fs-small)", fontWeight: 600 }}>
            Candle pair on the stage
          </div>
          <CandleStrip />
        </div>
      </KitSection>

      <KitSection title="Type scale">
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ fontSize: "var(--fs-display)", color: "var(--ink-900)", fontWeight: 700, letterSpacing: "-0.02em" }}>Display 2.5 — Train your strategy</div>
          <div style={{ fontSize: "var(--fs-h1)", color: "var(--ink-900)", fontWeight: 700, letterSpacing: "-0.02em" }}>Heading 1 — 2.0</div>
          <div style={{ fontSize: "var(--fs-h2)", color: "var(--ink-900)", fontWeight: 700 }}>Heading 2 — 1.5</div>
          <div style={{ fontSize: "var(--fs-h3)", color: "var(--ink-900)", fontWeight: 700 }}>Heading 3 — 1.125</div>
          <div style={{ fontSize: "var(--fs-body)" }}>Body — 1.0 / 1.55. Every decision, recorded automatically.</div>
          <div style={{ fontSize: "var(--fs-small)", color: "var(--ink-500)" }}>Small — 0.875 secondary text.</div>
          <div className="ui-eyebrow">Eyebrow — micro uppercase +0.08em, accent ink</div>
          <div style={{ fontVariantNumeric: "tabular-nums", fontSize: "var(--fs-body)", color: "var(--ink-900)" }}>
            Tabular numerals: 1,234.50 · −$50.00 · R 1.00
          </div>
        </div>
      </KitSection>

      <KitSection title="Buttons" blurb="Navy primary = product actions. Accent = commercial moments only (D8). Buy/Sell = trading contexts only.">
        <div style={{ ...row, alignItems: "center" }}>
          <Button variant="primary">Save session</Button>
          <Button variant="accent">Upgrade to Pro</Button>
          <Button variant="secondary">Compare plans</Button>
          <Button variant="ghost">Learn more</Button>
          <Button variant="danger">Delete</Button>
          <Button variant="buy">Buy</Button>
          <Button variant="sell">Sell</Button>
          <Button variant="primary" disabled>
            Disabled
          </Button>
        </div>
      </KitSection>

      <KitSection title="Badges & banners">
        <div style={{ ...row, alignItems: "center", marginBottom: 12 }}>
          <Badge tone="pro">PRO</Badge>
          <Badge>SIMULATED</Badge>
          <Badge>SAMPLE</Badge>
          <Badge tone="live">LIVE</Badge>
        </div>
        <div style={{ display: "grid", gap: 8, maxWidth: 720 }}>
          <Banner tone="info">Info — your Pro comes from a promo code; it stacks with a paid plan.</Banner>
          <Banner tone="success">Success — grant created and audit-logged.</Banner>
          <Banner tone="warning">Warning — 3 free trades used today; the next buy needs Pro.</Banner>
          <Banner tone="danger">Danger — that code could not be redeemed.</Banner>
        </div>
      </KitSection>

      <KitSection title="Card & form">
        <div style={{ display: "grid", gap: 16, maxWidth: 560 }}>
          <Card eyebrow="Billing" title="Grow Green Lab Pro">
            <p style={{ margin: 0 }}>
              Plan cards, forms and tables compose from the same primitives. Accent is a guide —
              links, selected states, focus — not a shout.
            </p>
          </Card>
          <form style={{ display: "grid", gap: 12 }} onSubmit={undefined}>
            <Input id="ds-email" label="Email" type="email" placeholder="you@example.com" />
            <Select id="ds-plan" label="Plan">
              <option>Free — 3 trades/day</option>
              <option>Pro — CAD $9.99/mo</option>
              <option>Pro — CAD $99.99/yr</option>
            </Select>
            <Input id="ds-code" label="Promo code" error="Enter a valid account user ID (UUID)." defaultValue="not-a-code" />
          </form>
        </div>
      </KitSection>

      <KitSection title="Table">
        <div style={{ maxWidth: 720 }}>
          <Table>
            <thead>
              <tr>
                <Th>Symbol</Th>
                <Th>Setup</Th>
                <Th>P&amp;L</Th>
                <Th>R</Th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <Td>DRAM</Td>
                <Td>HOD breakout</Td>
                <PnlCell value={120.5} format={(n) => `+$${n.toFixed(2)}`} />
                <Td>1.00</Td>
              </tr>
              <tr>
                <Td>NOEV</Td>
                <Td>VWAP pullback</Td>
                <PnlCell value={-50} format={(n) => `−$${Math.abs(n).toFixed(2)}`} />
                <Td>−0.42</Td>
              </tr>
              <tr>
                <Td>SIMX</Td>
                <Td>EMA pullback</Td>
                <PnlCell value={0} format={() => "$0.00"} />
                <Td>0.00</Td>
              </tr>
            </tbody>
          </Table>
        </div>
      </KitSection>

      <KitSection title="Modal shell">
        <Demo />
      </KitSection>
    </div>
  );
}
