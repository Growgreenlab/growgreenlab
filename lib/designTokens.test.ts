/**
 * designTokens.test.ts — redesign Phase 0 leakage guards.
 * Run: npx -y tsx lib/designTokens.test.ts
 *
 * Pins the Phase 0 token architecture (Direction v2 §2–§3):
 *  (a) Stage scope — the --stage-* tokens are DEFINED only inside
 *      the [data-stage] block of app/tokens.css, and var(--stage-*)
 *      is REFERENCED only by the .ui-stage rule (which is applied
 *      on the same element that carries data-stage).
 *  (b) Token-driven primitives — components/ui/** and the UIKIT
 *      section of app/globals.css contain NO hardcoded color
 *      literals (hex / rgb / hsl). Colors live only in the
 *      allowlisted token-definition file, app/tokens.css.
 * Also pins the adopted values: Palette A accent (D3) and the
 * split candle pair (D5: light #089981/#F23645, stage #2EBD85/#F6465D).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

let passed = 0, failed = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}${extra ? ` — ${extra}` : ""}`); }
}

const root = new URL("../", import.meta.url).pathname;
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

/** Return the text of the CSS block whose selector matches, via brace matching. */
function extractBlock(css: string, selectorRe: RegExp): string | null {
  const m = selectorRe.exec(css);
  if (!m) return null;
  const open = css.indexOf("{", m.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) return css.slice(open + 1, i); }
  }
  return null;
}

const HEX_OR_FN = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/;

function main() {
  const tokensCss = read("app/tokens.css");
  const globalsCss = read("app/globals.css");

  /* ---------- token definitions exist & carry adopted values ---------- */
  const lightBlock = extractBlock(tokensCss, /\[data-theme="light"\]\s*\{/);
  check("tokens.css defines the [data-theme=\"light\"] scope", lightBlock !== null);
  const stageBlock = extractBlock(tokensCss, /\[data-stage\]\s*\{/);
  check("tokens.css defines the [data-stage] scope", stageBlock !== null);
  if (lightBlock) {
    check("D3 accent-600 is Palette A lavender #6558C9", /--accent-600:\s*#6558C9/i.test(lightBlock));
    check("D5 light candle pair #089981/#F23645", /--chart-up:\s*#089981/i.test(lightBlock) && /--chart-down:\s*#F23645/i.test(lightBlock));
    check("light scope sets the off-white platform bg #FAFAF8 (D1)", /--bg:\s*#FAFAF8/i.test(lightBlock));
    check("light scope defines no --stage-* tokens", !/--stage-[a-z-]+\s*:/.test(lightBlock));
  }
  if (stageBlock) {
    check("stage bg is #0F141A", /--stage-bg:\s*#0F141A/i.test(stageBlock));
    check("D5 stage candle pair preserved #2EBD85/#F6465D", /--chart-up:\s*#2EBD85/i.test(stageBlock) && /--chart-down:\s*#F6465D/i.test(stageBlock));
  }

  /* ---------- (a) stage tokens defined ONLY inside [data-stage] ---------- */
  if (stageBlock) {
    const withoutStage = tokensCss.replace(stageBlock, "");
    check("(a) no --stage-* definitions outside the [data-stage] block", !/--stage-[a-z-]+\s*:/.test(withoutStage));
  }

  /* ---------- (a) stage var references only from .ui-stage ---------- */
  const uikitStart = globalsCss.indexOf("UIKIT:BEGIN");
  const uikitEnd = globalsCss.indexOf("UIKIT:END");
  check("globals.css has the UIKIT section markers", uikitStart >= 0 && uikitEnd > uikitStart);
  const uikit = uikitStart >= 0 ? globalsCss.slice(uikitStart, uikitEnd) : "";
  const stageRefs = [...uikit.matchAll(/var\(--stage-[a-z-]+\)/g)];
  check("(a) UIKIT section references stage tokens (the .ui-stage surface)", stageRefs.length > 0, `${stageRefs.length} refs`);
  // Every rule block in the section that references a stage var must be .ui-stage.
  const rules = uikit.split("}").map((r) => r.trim()).filter(Boolean);
  const badRules = rules.filter((r) => /var\(--stage-/.test(r) && !/\.ui-stage\b/.test(r.split("{")[0] ?? ""));
  check("(a) every stage-var rule in UIKIT is the .ui-stage rule", badRules.length === 0, badRules.join(" | ").slice(0, 120));

  const uiDir = join(root, "components/ui");
  const uiFiles = readdirSync(uiDir).filter((f) => /\.tsx?$/.test(f));
  check("components/ui has primitive sources", uiFiles.length >= 6, uiFiles.join(","));
  for (const f of uiFiles) {
    const src = read(join("components/ui", f));
    check(`(a) ${f} never references --stage-* directly`, !src.includes("--stage-"));
    check(`(b) ${f} has no hardcoded color literals`, !HEX_OR_FN.test(src));
  }

  const specimen = read("app/design-system/page.tsx");
  check("(a) specimen page carries data-stage only as a scoped region", specimen.includes("data-stage") && !/var\(--stage-/.test(specimen));

  /* ---------- (b) UIKIT css section is fully token-driven ---------- */
  check("(b) UIKIT section has no hardcoded color literals", !HEX_OR_FN.test(uikit));

  console.log(`=== DESIGN TOKENS RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main();
