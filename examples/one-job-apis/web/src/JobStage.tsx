import { useEffect, useMemo, useState } from "react";

import { NEEDS_OTHER, type Tool } from "@chainsafe/x402-example-one-job-catalog";

import { executeJob, type Me, type PayResult } from "./gateway.js";
import { PlaceFingerButton } from "./PlaceFingerButton.js";
import { SAMPLES } from "./samples.js";
import { VIA_LINE, ViaMark, centsLabel } from "./shared.js";
import { AgentGlyph, Wire, exchangeSteps } from "./Wire.js";

type Tab = "call" | "wire" | "agent";

/** One job on the stage: run it by hand, then see what crossed the wire. */
export function JobStage({
  tool,
  me,
  onMeChange,
  onBack,
}: {
  tool: Tool;
  me: Me | null;
  onMeChange: () => void;
  onBack?: () => void;
}) {
  const sample = SAMPLES[tool.tool] ?? { text: "" };
  const [text, setText] = useState(sample.text);
  const [other, setOther] = useState(sample.other ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PayResult["receipt"] | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [trace, setTrace] = useState<Record<string, unknown> | null>(null);
  const [runs, setRuns] = useState(0);
  const [tab, setTab] = useState<Tab>("call");
  const [seenWire, setSeenWire] = useState(true);
  const [showRaw, setShowRaw] = useState(false);

  useEffect(() => {
    const s = SAMPLES[tool.tool] ?? { text: "" };
    setText(s.text);
    setOther(s.other ?? "");
    setError(null);
    setReceipt(null);
    setResult(null);
    setTrace(null);
    setTab("call");
    setSeenWire(true);
    setShowRaw(false);
  }, [tool.tool]);

  const quota = me?.prepaidCalls ?? 0;
  const ready = Boolean(me?.signedIn && me.hasPasskey && tool.live);
  const useQuota = quota > 0;
  const steps = useMemo(() => exchangeSteps(tool.tool, trace), [tool.tool, trace]);

  async function pay(perCall = false) {
    setBusy(true);
    setError(null);
    setReceipt(null);
    setResult(null);
    setTrace(null);
    try {
      const body = NEEDS_OTHER.has(tool.tool) ? { text, other: other.trim() } : { text };
      if (!body.text.trim()) throw new Error("Add some input first.");
      if (NEEDS_OTHER.has(tool.tool) && !other.trim()) throw new Error("This job needs the second field too.");
      const paid = await executeJob(tool.tool, body, quota, perCall);
      setReceipt(paid.receipt);
      setResult(JSON.stringify(paid.result, null, 2));
      setTrace(paid.trace);
      setRuns((n) => n + 1);
      setSeenWire(false);
      onMeChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The payment did not go through.");
    } finally {
      setBusy(false);
    }
  }

  function open(t: Tab) {
    setTab(t);
    if (t === "wire") setSeenWire(true);
  }

  return (
    <section className="job-stage" aria-label={tool.tool}>
      <header className="stage-head">
        {onBack && (
          <button type="button" className="back" onClick={onBack}>
            Jobs
          </button>
        )}
        <p className="stage-kicker">
          <ViaMark via={tool.via} />
          {tool.group}, {VIA_LINE[tool.via].toLowerCase()}
        </p>
        <h1 className="stage-title mono">{tool.tool}</h1>
        <p className="stage-sub">
          Takes {tool.body}. Returns {tool.result}.
        </p>
      </header>

      <div className="tabs" role="tablist" aria-label="Views of this job">
        <button type="button" role="tab" aria-selected={tab === "call"} className={tab === "call" ? "on" : ""} onClick={() => open("call")}>
          Call it
        </button>
        <button type="button" role="tab" aria-selected={tab === "wire"} className={tab === "wire" ? "on" : ""} onClick={() => open("wire")}>
          What happened
          {!seenWire && <span className="tab-dot" aria-label="new" />}
        </button>
        <button type="button" role="tab" aria-selected={tab === "agent"} className={tab === "agent" ? "on" : ""} onClick={() => open("agent")}>
          Without the button
        </button>
      </div>

      {tab === "call" && (
        <div className="tab-body call">
          <div className="fields">
            <label htmlFor="text">Input</label>
            <textarea id="text" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
            {NEEDS_OTHER.has(tool.tool) && (
              <>
                <label htmlFor="other">Second input</label>
                <textarea id="other" className="short" spellCheck={false} value={other} onChange={(e) => setOther(e.target.value)} />
              </>
            )}
          </div>

          <div className="pay-bar">
            <div className="price-block">
              {useQuota ? (
                <>
                  <span className="price-lg">{quota}</span>
                  <span className="price-unit">prepaid calls left</span>
                </>
              ) : (
                <>
                  <span className="price-lg">{centsLabel(tool.cents)}</span>
                  <span className="price-unit">per call, in Canton Coin</span>
                </>
              )}
            </div>
            <PlaceFingerButton
              busy={busy}
              ready={ready}
              disabled={busy || !ready}
              label={busy ? "Running" : useQuota ? "Run job" : "Pay with passkey"}
              onClick={() => void pay(false)}
            />
            {useQuota && (
              <button type="button" className="link-btn pay-anyway" disabled={busy || !ready} onClick={() => void pay(true)}>
                Pay this call anyway (x402)
              </button>
            )}
          </div>
          {error && <p className="error">{error}</p>}

          {(result || receipt) && (
            <div className="outcome">
              {result && (
                <div className="result-block">
                  <h2>Answer</h2>
                  <pre className="result">{result}</pre>
                </div>
              )}
              {receipt && (
                <div className="receipt receipt-feed" role="status" aria-live="polite">
                  <div className="receipt-paper">
                    <p className="receipt-head">
                      <span>{receipt.billing === "prepaid" ? "Prepaid quota" : "Paid"}</span>
                      <span>{receipt.tool}</span>
                    </p>
                    <p className="receipt-amount">
                      {receipt.billing === "prepaid" ? "1 call from your pack" : centsLabel(receipt.cents)}
                    </p>
                    <dl className="receipt-meta">
                      <div>
                        <dt>Payer</dt>
                        <dd>{receipt.payer}</dd>
                      </div>
                      <div>
                        <dt>Transaction</dt>
                        <dd>{receipt.transaction}</dd>
                      </div>
                      <div>
                        <dt>Network</dt>
                        <dd>{receipt.network}</dd>
                      </div>
                    </dl>
                    {receipt.demo && (
                      <p className="receipt-foot">
                        Passkey and x402 exchange are real. The ledger uses demo tokens until DevNet keys are wired.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "wire" && (
        <div className="tab-body">
          <Wire
            steps={steps}
            mode={busy ? "pending" : trace ? "once" : "idle"}
            replayKey={runs}
            interactive={Boolean(trace)}
            caption={
              trace
                ? "This call. Tap a message to see what it carried."
                : "Pay once on the first tab and this fills in with the real exchange."
            }
          />
          {trace && (
            <>
              <button type="button" className="link-btn raw-toggle" onClick={() => setShowRaw((v) => !v)}>
                {showRaw ? "Hide the full trace" : "Show the full trace as JSON"}
              </button>
              {showRaw && <pre className="raw">{JSON.stringify(trace, null, 2)}</pre>}
            </>
          )}
        </div>
      )}

      {tab === "agent" && (
        <div className="tab-body agent-call">
          <p>
            <AgentGlyph /> An agent makes this exact call. It reads the price from the 402, checks it against the
            budget you gave it, signs, and retries. Nobody presses anything.
          </p>
          <pre className="agent-http">
            <span className="h-dim">POST</span> /v1/{tool.tool}
            {"\n"}
            <span className="h-ask">402</span> <span className="h-dim">PAYMENT-REQUIRED</span> {centsLabel(tool.cents)} Canton Coin to the merchant
            {"\n"}
            <span className="h-dim">     budget check</span> {centsLabel(tool.cents)} fits, sign
            {"\n"}
            <span className="h-dim">POST</span> /v1/{tool.tool}
            {"\n"}
            <span className="h-dim">     PAYMENT-SIGNATURE</span> signed by the agent
            {"\n"}
            <span className="h-ok">200</span> <span className="h-dim">PAYMENT-RESPONSE</span> answer plus receipt
          </pre>
          <p className="agent-note">
            In this demo the daily cap on your account plays the agent&rsquo;s budget, and your passkey plays its
            signature. Try it for real under Agent.
          </p>
        </div>
      )}
    </section>
  );
}
