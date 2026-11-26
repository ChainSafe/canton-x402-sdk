import { useEffect, useMemo, useRef, useState } from "react";

import {
  registerPasskey,
  runAgent,
  subscribeTill,
  type AgentEvent,
  type AgentTask,
  type Me,
  type Sale,
  type TillState,
} from "./gateway.js";
import { PlaceFingerButton } from "./PlaceFingerButton.js";
import { AgentGlyph, PersonGlyph } from "./Wire.js";

type StepState = "waiting" | "asking" | "paid" | "failed" | "skipped";

interface StepView {
  tool: string;
  why: string;
  cents: number;
  state: StepState;
  note?: string;
}

export function AgentStage({
  task,
  maxBudget,
  me,
  onMeChange,
  onBusy,
  onBack,
}: {
  task: AgentTask | undefined;
  maxBudget: number;
  me: Me | null;
  onMeChange: () => void;
  onBusy: (busy: boolean) => void;
  onBack?: () => void;
}) {
  const [budget, setBudget] = useState(10);
  const [steps, setSteps] = useState<StepView[] | null>(null);
  const [spent, setSpent] = useState(0);
  const [answer, setAnswer] = useState<{ text: string; spent: number; calls: number; budget: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const planCost = useMemo(() => task?.steps.reduce((n, st) => n + st.cents, 0) ?? 0, [task]);
  const ready = Boolean(me?.signedIn && me.hasPasskey);

  useEffect(() => {
    setSteps(null);
    setAnswer(null);
    setSpent(0);
    setError(null);
  }, [task?.id]);

  useEffect(() => onBusy(busy), [busy, onBusy]);

  async function go() {
    if (!task) return;
    setBusy(true);
    setApproving(true);
    setError(null);
    setAnswer(null);
    setSpent(0);
    setSteps(task.steps.map((s) => ({ ...s, state: "waiting" })));
    try {
      await runAgent(task.id, budget, (e: AgentEvent) => {
        setApproving(false);
        if (e.type === "step") {
          setSpent(e.spent);
          setSteps((prev) =>
            prev ? prev.map((s, i) => (i === e.index ? { ...s, state: e.state, note: e.note } : s)) : prev,
          );
        } else if (e.type === "done") {
          setSpent(e.spent);
          setAnswer({ text: e.answer, spent: e.spent, calls: e.calls, budget: e.budgetCents });
          onMeChange();
        } else if (e.type === "error") {
          setError(e.error);
        }
      });
    } catch (err) {
      setSteps(null);
      setError(err instanceof Error ? err.message : "The agent did not start.");
    } finally {
      setBusy(false);
      setApproving(false);
    }
  }

  if (!task) return <div className="stage-empty">Pick a task on the left.</div>;

  return (
    <section className="delegate" aria-label={task.title}>
      <header className="stage-head">
        {onBack && (
          <button type="button" className="back" onClick={onBack}>
            Tasks
          </button>
        )}
        <p className="stage-kicker">
          <AgentGlyph /> Delegate a task
        </p>
        <h1 className="stage-title">{task.title}</h1>
      </header>

      {task && (
        <p className="ask">
          <span className="ask-who">You</span>
          {task.ask}
        </p>
      )}

      <div className="budget">
        <div className="budget-row">
          <label htmlFor="budget">Budget for this task</label>
          <output htmlFor="budget" className="budget-value">
            {budget}¢
          </output>
        </div>
        <input
          id="budget"
          type="range"
          min={1}
          max={maxBudget}
          step={1}
          value={budget}
          disabled={busy}
          onChange={(e) => setBudget(Number(e.target.value))}
          style={{ ["--fill" as string]: `${(budget / maxBudget) * 100}%` }}
        />
        <p className="budget-hint">
          {planCost > budget
            ? `The plan costs ${planCost}¢. With ${budget}¢ the agent stops when the next job would go over.`
            : `The plan costs ${planCost}¢. You approve the budget once, and the agent pays each job by itself.`}
        </p>
      </div>

      {ready && (
        <div className="delegate-go">
          <PlaceFingerButton
            busy={busy}
            ready={ready}
            disabled={busy || !task}
            label={approving ? "Approve on your device" : busy ? "Agent at work" : `Approve ${budget}¢ and send`}
            onClick={() => void go()}
          />
        </div>
      )}
      {error && <p className="error">{error}</p>}

      {steps && (
        <div className="run">
          <div className="run-head">
            <span className="seat-sub">
              <AgentGlyph /> Your agent
            </span>
            <span className="run-meter" aria-label={`${spent} of ${budget} cents spent`}>
              <span className="run-bar">
                <span style={{ width: `${Math.min(100, (spent / budget) * 100)}%` }} />
              </span>
              {spent}¢ of {budget}¢
            </span>
          </div>
          <ol className="run-steps">
            {steps.map((s, i) => (
              <li key={`${s.tool}-${i}`} className={`run-step st-${s.state}`}>
                <span className="run-dot" aria-hidden />
                <span className="run-main">
                  <span className="run-tool">{s.tool}</span>
                  <span className="run-why">{s.note ?? s.why}</span>
                </span>
                <span className="run-price">
                  {s.state === "asking" ? "402" : `${s.cents}¢`}
                </span>
                <span className="sr-only">{s.state}</span>
              </li>
            ))}
          </ol>
          {answer && (
            <div className="answer" role="status" aria-live="polite">
              <p className="answer-text">{answer.text}</p>
              <p className="answer-foot">
                {answer.calls} paid {answer.calls === 1 ? "call" : "calls"}, {answer.spent}¢ of {answer.budget}¢. You
                approved once.
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function timeLabel(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function Till({ onOwner }: { onOwner: () => void }) {
  const [state, setState] = useState<TillState | null>(null);
  const [fresh, setFresh] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const flashTimer = useRef<number>();

  useEffect(() => {
    const stop = subscribeTill(
      (s) => {
        setState(s);
        setLive(true);
      },
      (sale: Sale) => {
        setState((prev) => {
          const sales = [sale, ...(prev?.sales ?? [])].slice(0, 40);
          const payers = new Set(sales.map((x) => x.payer));
          return {
            sales,
            totals: {
              calls: (prev?.totals.calls ?? 0) + 1,
              cents: (prev?.totals.cents ?? 0) + sale.cents,
              payers: Math.max(prev?.totals.payers ?? 0, payers.size),
              byAgents: (prev?.totals.byAgents ?? 0) + (sale.caller === "agent" ? 1 : 0),
            },
          };
        });
        setFresh(sale.id);
        window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFresh(null), 1600);
      },
    );
    return () => {
      stop();
      window.clearTimeout(flashTimer.current);
    };
  }, []);

  const t = state?.totals ?? { calls: 0, cents: 0, payers: 0, byAgents: 0 };
  const sales = state?.sales ?? [];

  return (
    <section className="till" aria-labelledby="till-heading">
      <div className="till-head">
        <h2 id="till-heading" className="seat-title">
          <span className="till-mark" aria-hidden>
            $
          </span>
          The owner&rsquo;s seat
        </h2>
        <span className={`till-live ${live ? "on" : ""}`}>{live ? "Live" : "Connecting"}</span>
      </div>

      <div className="till-earned">
        <span className="till-earned-n">{t.cents}¢</span>
        <span className="till-earned-label">
          earned from {t.calls} paid {t.calls === 1 ? "call" : "calls"}
          {t.byAgents > 0 ? `, ${t.byAgents} by agents` : ""}
        </span>
      </div>

      <dl className="till-zeros">
        <div>
          <dt>Accounts you created</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>API keys you issued</dt>
          <dd>0</dd>
        </div>
        <div>
          <dt>Invoices you sent</dt>
          <dd>0</dd>
        </div>
      </dl>

      <div className="till-feed">
        {sales.length === 0 ? (
          <p className="till-empty">No paid calls yet. Send the agent, or pay for a job by hand.</p>
        ) : (
          <ul>
            {sales.slice(0, 9).map((s) => (
              <li key={s.id} className={`sale ${s.id === fresh ? "fresh" : ""}`}>
                <span className="sale-caller" title={s.caller === "agent" ? "Paid by an agent" : "Paid by a person"}>
                  {s.caller === "agent" ? <AgentGlyph /> : <PersonGlyph />}
                </span>
                <span className="sale-main">
                  <span className="sale-tool">{s.tool}</span>
                  <span className="sale-payer">{s.payer}</span>
                </span>
                <span className="sale-price">+{s.cents}¢</span>
                <span className="sale-time">{timeLabel(s.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="till-fee">
        A card payment costs 2.9% + 30¢ in fees (Stripe&rsquo;s standard US rate). Most of these calls cost 1¢.
      </p>
      <button type="button" className="till-owner-btn" onClick={onOwner}>
        What the owner added to get this
      </button>
    </section>
  );
}

const DIFF: Array<["+" | " ", string]> = [
  [" ", "app.post("],
  [" ", '  "/v1/hash.sha256",'],
  ["+", "  paymentRequired({"],
  ["+", "    facilitator,"],
  ["+", "    settle: true,"],
  ["+", "    requirements: {"],
  ["+", "      network,"],
  ["+", "      payTo,"],
  ["+", '      accepts: [{ asset: "Amulet", amount }],'],
  ["+", "    },"],
  ["+", "  }),"],
  [" ", "  (req, res) => res.json(hash(req.body)),"],
  [" ", ");"],
];

export function OwnerSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="sheet" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
    <section className="owner" aria-labelledby="owner-heading">
      <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
        Close
      </button>
      <div className="owner-copy">
        <h2 id="owner-heading">If you own an API, this is the whole change</h2>
        <p>
          Put <code>paymentRequired</code> in front of the route you already have. It answers 402 with the
          price, checks the payment with the facilitator, settles, and only then runs your handler.
          Agents find the price in the response. Nobody signs up.
        </p>
        <p className="owner-note">
          Shortened from <code>examples/one-job-apis/api/src/app.ts</code>, which prices all seventy jobs from the
          catalog.
        </p>
      </div>
      <pre className="owner-diff" aria-label="An Express route before and after adding paymentRequired">
        {DIFF.map(([kind, line], i) => (
          <span key={i} className={kind === "+" ? "d-add" : "d-ctx"}>
            {kind === "+" ? "+ " : "  "}
            {line}
            {"\n"}
          </span>
        ))}
      </pre>
    </section>
    </dialog>
  );
}
