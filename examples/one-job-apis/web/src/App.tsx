import { useCallback, useEffect, useMemo, useState } from "react";

import { GROUPS, TOOLS, findTool, type Group, type Via } from "@chainsafe/x402-example-one-job-catalog";

import { AgentStage, OwnerSheet, Till } from "./AgentView.js";
import {
  devLogin,
  fetchAgentTasks,
  fetchGatewayHealth,
  fetchMe,
  logout,
  registerPasskey,
  signInWithGoogle,
  type AgentTask,
  type GatewayHealth,
  type Me,
} from "./gateway.js";
import { JobStage } from "./JobStage.js";
import { QuotaShelf } from "./QuotaShelf.js";
import { GridGlyph, TillGlyph, ViaMark, centsLabel } from "./shared.js";
import { AgentGlyph, PersonGlyph, Wire, exchangeSteps, type Caller } from "./Wire.js";

const DEMO_EMAIL = "demo@chainsafe.io";

type Section = "agent" | "jobs";
/** Which zone a phone shows. Wide screens show all of them. */
type Pane = "list" | "stage" | "till";
type CallerFilter = "Any" | Via;

interface Route {
  section: Section;
  item: string | null;
}

function readRoute(): Route {
  const [head, item] = window.location.hash.replace(/^#\/?/, "").split("/");
  return { section: head === "jobs" ? "jobs" : "agent", item: item ? decodeURIComponent(item) : null };
}

function go(section: Section, item?: string | null) {
  window.location.hash = item ? `${section}/${encodeURIComponent(item)}` : section;
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [gateway, setGateway] = useState<GatewayHealth | null>(null);
  const [route, setRoute] = useState<Route>(readRoute);
  const [pane, setPane] = useState<Pane>(route.item ? "stage" : "list");
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [maxBudget, setMaxBudget] = useState(50);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  const [agentBusy, setAgentBusy] = useState(false);
  const presenter = useMemo(() => new URLSearchParams(window.location.search).get("presenter") === "1", []);

  const refreshMe = useCallback(async () => {
    setMe(await fetchMe().catch(() => ({ signedIn: false })));
  }, []);

  useEffect(() => {
    void refreshMe();
    void fetchGatewayHealth().then(setGateway);
    void fetchAgentTasks()
      .then((d) => {
        setTasks(d.tasks);
        setMaxBudget(d.maxBudgetCents);
      })
      .catch((err: unknown) =>
        setTaskError(
          `Could not load the agent tasks (${err instanceof Error ? err.message : "no answer"}). Restart the gateway on :8790.`,
        ),
      );
  }, [refreshMe]);

  useEffect(() => {
    const onHash = () => {
      const r = readRoute();
      setRoute(r);
      setPane(r.item ? "stage" : "list");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const onboarded = Boolean(me?.signedIn && me.hasPasskey);
  const taskId = route.section === "agent" ? (route.item ?? tasks[0]?.id ?? null) : null;
  const task = tasks.find((t) => t.id === taskId);
  const tool = route.section === "jobs" && route.item ? findTool(route.item) : undefined;
  const onBack = () => go(route.section);

  let stage: React.ReactNode;
  if (!onboarded) {
    stage = <Welcome me={me} gateway={gateway} onChange={() => void refreshMe()} />;
  } else if (route.section === "agent") {
    stage = taskError ? (
      <div className="stage-empty error">{taskError}</div>
    ) : (
      <AgentStage
        task={task}
        maxBudget={maxBudget}
        me={me}
        onMeChange={() => void refreshMe()}
        onBusy={setAgentBusy}
        onBack={onBack}
      />
    );
  } else if (tool) {
    stage = <JobStage tool={tool} me={me} onMeChange={() => void refreshMe()} onBack={onBack} />;
  } else {
    stage = <JobsEmpty />;
  }

  return (
    <div className={`app ${presenter ? "presenter" : ""} ${onboarded ? "" : "onboarding"}`} data-pane={onboarded || pane === "till" ? pane : "stage"} data-section={route.section}>
      <nav className="rail" aria-label="Sections">
        <span className="rail-brand" aria-label="ChainSafe one-job APIs">
          CS
        </span>
        <RailButton label="Agent" on={route.section === "agent" && pane !== "till"} onClick={() => { go("agent"); setPane("list"); }}>
          <AgentGlyph />
        </RailButton>
        <RailButton label="Jobs" on={route.section === "jobs" && pane !== "till"} onClick={() => { go("jobs"); setPane("list"); }}>
          <GridGlyph />
        </RailButton>
        <RailButton label="Till" on={pane === "till"} className="rail-till" onClick={() => setPane("till")}>
          <TillGlyph />
        </RailButton>
        <span className="rail-spacer" />
        <Account me={me} gateway={gateway} onChange={() => void refreshMe()} />
      </nav>

      <aside className="sidebar" aria-label={route.section === "agent" ? "Tasks" : "Jobs"}>
        {route.section === "agent" ? (
          <TaskList tasks={tasks} current={taskId} locked={agentBusy} />
        ) : (
          <>
            <QuotaShelf me={me} onChange={() => void refreshMe()} />
            <JobList current={route.item} />
          </>
        )}
      </aside>

      <main className="stage">{stage}</main>

      <aside className="inspector" aria-label="The owner's till">
        <button type="button" className="inspector-close" onClick={() => setPane(route.item ? "stage" : "list")}>
          Close
        </button>
        <Till onOwner={() => setOwnerOpen(true)} />
      </aside>

      <OwnerSheet open={ownerOpen} onClose={() => setOwnerOpen(false)} />
    </div>
  );
}

function RailButton({
  label,
  on,
  className = "",
  onClick,
  children,
}: {
  label: string;
  on: boolean;
  className?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={`rail-btn ${on ? "on" : ""} ${className}`} aria-current={on ? "page" : undefined} onClick={onClick}>
      {children}
      <span>{label}</span>
    </button>
  );
}

function Account({ me, gateway, onChange }: { me: Me | null; gateway: GatewayHealth | null; onChange: () => void }) {
  if (!me?.signedIn) return null;
  const spent = me.spentCentsToday ?? 0;
  const cap = me.dailyCapCents ?? 500;
  const pct = Math.min(100, (spent / cap) * 100);
  return (
    <div className="account">
      <span
        className="account-ring"
        style={{ ["--pct" as string]: `${pct}%` }}
        title={`${spent}¢ of ${cap}¢ spent today`}
      >
        {me.picture ? <img src={me.picture} alt="" /> : <span>{me.name?.slice(0, 1).toUpperCase() ?? "?"}</span>}
      </span>
      <span className="account-spend">
        {spent}¢{(me.prepaidCalls ?? 0) > 0 ? ` · ${me.prepaidCalls} left` : ""}
      </span>
      {gateway?.oauth && (
        <button type="button" className="account-out" onClick={() => signInWithGoogle()}>
          Switch
        </button>
      )}
      <button type="button" className="account-out" onClick={() => void logout().then(onChange)}>
        Sign out
      </button>
    </div>
  );
}

function TaskList({ tasks, current, locked }: { tasks: AgentTask[]; current: string | null; locked: boolean }) {
  return (
    <div className="list">
      <header className="list-head">
        <h2>Tasks</h2>
        <p>Hand one to your agent. It picks the jobs and pays for them.</p>
      </header>
      <ul className="list-items">
        {tasks.map((t) => {
          const cost = t.steps.reduce((n, s) => n + s.cents, 0);
          return (
            <li key={t.id}>
              <a
                href={`#agent/${t.id}`}
                className={`item task-item ${t.id === current ? "on" : ""}`}
                aria-current={t.id === current ? "true" : undefined}
                aria-disabled={locked && t.id !== current ? "true" : undefined}
                onClick={(e) => {
                  if (locked && t.id !== current) e.preventDefault();
                }}
              >
                <span className="item-top">
                  <span className="item-title">{t.title}</span>
                  <span className="item-price">{cost}¢</span>
                </span>
                <span className="item-sub">{t.ask}</span>
                <span className="item-meta">
                  {t.steps.map((s) => (
                    <span key={s.tool} className="item-chip">
                      {s.tool}
                    </span>
                  ))}
                </span>
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function JobList({ current }: { current: string | null }) {
  const [query, setQuery] = useState("");
  const [via, setVia] = useState<CallerFilter>("Any");
  const [group, setGroup] = useState<Group | "All">("All");

  const list = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return TOOLS.filter((t) => {
      if (via !== "Any" && t.via !== via) return false;
      if (group !== "All" && t.group !== group) return false;
      if (!needle) return true;
      return t.tool.includes(needle) || t.body.toLowerCase().includes(needle) || t.result.toLowerCase().includes(needle);
    }).sort((a, b) => a.tool.localeCompare(b.tool));
  }, [query, via, group]);

  return (
    <div className="list">
      <header className="list-head">
        <h2>{TOOLS.length} jobs</h2>
        <input
          className="search"
          type="search"
          aria-label="Search jobs"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="seg" role="radiogroup" aria-label="Who usually buys it">
          {(["Any", "Call", "Both", "Finger"] as const).map((v) => (
            <button key={v} type="button" role="radio" aria-checked={via === v} className={via === v ? "on" : ""} onClick={() => setVia(v)}>
              {v === "Any" ? "All" : v === "Call" ? "Agents" : v === "Finger" ? "People" : "Both"}
            </button>
          ))}
        </div>
        <select className="group-select" aria-label="Drawer" value={group} onChange={(e) => setGroup(e.target.value as Group | "All")}>
          <option value="All">Every drawer</option>
          {GROUPS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </header>
      {list.length === 0 ? (
        <p className="list-empty">Nothing matches. Try a shorter word.</p>
      ) : (
        <ul className="list-items">
          {list.map((t) => (
            <li key={t.tool}>
              <a href={`#jobs/${t.tool}`} className={`item job-item ${t.tool === current ? "on" : ""}`} aria-current={t.tool === current ? "true" : undefined}>
                <span className="item-top">
                  <span className="item-title mono">{t.tool}</span>
                  <span className="item-price">{centsLabel(t.cents)}</span>
                </span>
                <span className="item-row">
                  <span className="item-sub one">
                    {t.body} to {t.result}
                  </span>
                  <ViaMark via={t.via} />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoopingWire() {
  const [caller, setCaller] = useState<Caller>("person");
  const steps = useMemo(() => exchangeSteps("hash.sha256", null, caller), [caller]);
  return (
    <Wire
      steps={steps}
      mode="loop"
      caller={caller}
      onLoop={() => setCaller((c) => (c === "person" ? "agent" : "person"))}
      caption={
        caller === "agent"
          ? "An agent buys the same answer. It reads the price, pays inside its budget, and retries."
          : "A person buys hash.sha256. The passkey is the only button."
      }
    />
  );
}

function JobsEmpty() {
  return (
    <div className="stage-empty-rich">
      <header className="stage-head">
        <h1 className="stage-title">Every job is one endpoint with a price</h1>
        <p className="stage-sub">
          Pick one on the left and pay for it by hand. This is the exchange it runs, for a person or an agent.
        </p>
      </header>
      <LoopingWire />
    </div>
  );
}

function Welcome({ me, gateway, onChange }: { me: Me | null; gateway: GatewayHealth | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const signedIn = Boolean(me?.signedIn);
  const steps = [
    { label: "Sign in", done: signedIn },
    { label: "Add a passkey", done: Boolean(me?.hasPasskey) },
    { label: "Send an agent", done: false },
  ];
  const active = steps.findIndex((s) => !s.done);

  return (
    <div className="welcome">
      <div className="welcome-copy">
        <h1>
          One job.
          <br />
          One finger.
          <br />
          One receipt.
        </h1>
        <p className="welcome-lede">
          {TOOLS.length} small APIs over HTTP 402 — pay per call with a passkey, or buy a <strong>bulk pack</strong>{" "}
          once and run jobs without micro-payments until quota runs out. No merchant account, no subscription.
        </p>

        <ol className="rail-steps" aria-label="Getting started">
          {steps.map((s, i) => (
            <li key={s.label} className={s.done ? "done" : i === active ? "active" : ""}>
              <span className="rail-n">{s.done ? "✓" : i + 1}</span>
              {s.label}
            </li>
          ))}
        </ol>

        <div className="welcome-actions">
          {!signedIn && gateway?.devLogin && (
            <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(() => devLogin(DEMO_EMAIL))}>
              {busy ? "Opening a session" : "Enter demo"}
            </button>
          )}
          {!signedIn && gateway?.oauth && (
            <button type="button" className="btn-ghost" disabled={busy} onClick={() => signInWithGoogle()}>
              Continue with Google
            </button>
          )}
          {!signedIn && gateway === null && <p className="welcome-wait">Connecting to the gateway on :8790</p>}
          {signedIn && !me?.hasPasskey && (
            <>
              <button type="button" className="btn-primary" disabled={busy} onClick={() => void run(registerPasskey)}>
                {busy ? "Waiting for your sensor" : "Add a passkey"}
              </button>
              <p className="welcome-note">
                <PersonGlyph /> One registration. It approves budgets for your agent and single calls by hand.
              </p>
            </>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
      <LoopingWire />
    </div>
  );
}
