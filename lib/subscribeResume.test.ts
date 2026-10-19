/**
 * subscribeResume.test.ts — Pro subscribe intent through sign-in.
 * Run: npx -y tsx lib/subscribeResume.test.ts
 *
 * Pins the helpers behind the pricing → login → resume-checkout flow:
 *  - buildSubscribeNext produces the exact /login?next=… URL for both
 *    plans (the intent rides the auth flow's existing `next` param);
 *  - parseSubscribeParam accepts ONLY "monthly" | "yearly" — a
 *    client-supplied Stripe price ID, wrong case, empty value, or a
 *    repeated-param array all parse to null (no resume);
 *  - isSafeNext — the predicate BOTH the login page and the auth
 *    callback use to decide the post-auth destination — accepts
 *    internal paths and rejects protocol-relative and backslash
 *    open-redirect variants;
 *  - the consume-once intent returns the plan exactly once, so a
 *    re-running resume effect can never double-fire checkout.
 */
import {
  buildSubscribeNext,
  parseSubscribeParam,
  isSafeNext,
  createSubscribeIntent,
} from "./subscribeResume";

let passed = 0, failed = 0;
function check(name: string, cond: boolean) {
  if (cond) { passed++; } else { failed++; console.error(`FAIL: ${name}`); }
}
function eq(name: string, a: unknown, b: unknown) {
  check(`${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`, a === b);
}

/* ---------- buildSubscribeNext: exact output, both plans ---------- */
eq("buildSubscribeNext monthly",
  buildSubscribeNext("monthly"),
  "/login?next=%2Fpricing%3Fsubscribe%3Dmonthly");
eq("buildSubscribeNext yearly",
  buildSubscribeNext("yearly"),
  "/login?next=%2Fpricing%3Fsubscribe%3Dyearly");
// Round-trip: the login page decodes `next` back to the resume URL.
eq("buildSubscribeNext decodes to the resume URL",
  decodeURIComponent(buildSubscribeNext("yearly").slice("/login?next=".length)),
  "/pricing?subscribe=yearly");

/* ---------- parseSubscribeParam: accept matrix ---------- */
eq("accepts monthly", parseSubscribeParam("monthly"), "monthly");
eq("accepts yearly", parseSubscribeParam("yearly"), "yearly");

/* ---------- parseSubscribeParam: reject matrix ---------- */
eq("rejects a Stripe price ID", parseSubscribeParam("price_1US7XQCkdp8RhthV44kxldcP"), null);
eq("rejects price_ prefix", parseSubscribeParam("price_monthly"), null);
eq("rejects wrong case Monthly", parseSubscribeParam("Monthly"), null);
eq("rejects wrong case YEARLY", parseSubscribeParam("YEARLY"), null);
eq("rejects empty string", parseSubscribeParam(""), null);
eq("rejects array of valid plans", parseSubscribeParam(["monthly", "yearly"]), null);
eq("rejects single-element array", parseSubscribeParam(["monthly"]), null);
eq("rejects null", parseSubscribeParam(null), null);
eq("rejects undefined", parseSubscribeParam(undefined), null);
eq("rejects non-string number", parseSubscribeParam(1), null);
eq("rejects whitespace-padded plan", parseSubscribeParam(" monthly"), null);
eq("rejects trailing junk", parseSubscribeParam("monthlyx"), null);

/* ---------- isSafeNext: accepts internal destinations ---------- */
check("accepts the subscribe resume URL", isSafeNext("/pricing?subscribe=monthly"));
check("accepts the yearly resume URL", isSafeNext("/pricing?subscribe=yearly"));
check("accepts /replay (the ordinary default)", isSafeNext("/replay"));
check("accepts /community precedent", isSafeNext("/community"));
check("accepts a nested path with query", isSafeNext("/journal?tab=analytics"));
eq("accepts root /", isSafeNext("/"), true);
eq("accepts plain deep path", isSafeNext("/a/b/c"), true);

/* ---------- isSafeNext: rejects open-redirect variants ---------- */
eq("rejects protocol-relative //evil.com", isSafeNext("//evil.com"), false);
eq("rejects //evil.com with path", isSafeNext("//evil.com/phish"), false);
eq("rejects triple-slash", isSafeNext("///evil.com"), false);
eq("rejects absolute https URL", isSafeNext("https://evil.com"), false);
eq("rejects absolute http URL", isSafeNext("http://evil.com/replay"), false);
eq("rejects backslash variant /\\evil.com", isSafeNext("/\\evil.com"), false);
eq("rejects backslash-first \\/evil.com", isSafeNext("\\/evil.com"), false);
eq("rejects backslash-only start", isSafeNext("\\\\evil.com"), false);
eq("rejects embedded backslash", isSafeNext("/pricing\\@evil.com"), false);
eq("rejects empty string", isSafeNext(""), false);
eq("rejects relative path without slash", isSafeNext("pricing"), false);
eq("rejects null", isSafeNext(null), false);
eq("rejects undefined", isSafeNext(undefined), false);
eq("rejects non-string", isSafeNext(42), false);

/* ---------- consume-once intent ---------- */
{
  const intent = createSubscribeIntent("yearly");
  eq("first take returns the plan", intent.take(), "yearly");
  eq("second take returns null", intent.take(), null);
  eq("third take still null", intent.take(), null);
}
{
  const intent = createSubscribeIntent("monthly");
  eq("monthly intent first take", intent.take(), "monthly");
  eq("monthly intent consumed", intent.take(), null);
}
{
  const intent = createSubscribeIntent("price_1US7XQCkdp8RhthV44kxldcP");
  eq("a price-ID param yields no intent", intent.take(), null);
}
{
  const intent = createSubscribeIntent(undefined);
  eq("missing param yields no intent", intent.take(), null);
}
{
  const intent = createSubscribeIntent(["yearly"]);
  eq("array param yields no intent", intent.take(), null);
}

console.log(`=== SUBSCRIBE RESUME RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
