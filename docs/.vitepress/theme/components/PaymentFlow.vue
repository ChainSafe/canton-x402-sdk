<!--
  The home page's payment flow: a sequence diagram with one column per party
  and one row per message, grouped into phases. To change the flow, edit
  PHASES; the step numbers and arrow directions follow from it.

  Layout: each row is 8 half-columns, so lane i's centre (counting from 1) is
  grid line 2i, and a message from lane a to lane b spans 2a / 2b. The
  lifelines are drawn at those centres: 12.5%, 37.5%, 62.5% and 87.5%.
-->
<script setup lang="ts">
import { ICONS, type IconName } from "../icons";

type LaneId = "user" | "merchant" | "facilitator" | "canton";

const LANES: { id: LaneId; name: string; role: string; icon: IconName }[] = [
  { id: "user", name: "User", role: "the payer", icon: "user" },
  { id: "merchant", name: "Merchant", role: "your API", icon: "server" },
  { id: "facilitator", name: "Facilitator", role: "verifies and settles", icon: "shield" },
  { id: "canton", name: "Canton", role: "the ledger", icon: "ledger" },
];

/**
 * A step: a call (solid), a reply (dashed), the reply that completes the
 * request (`ok`, green), or a note on one party's own lifeline. Labels are
 * HTML, for their inline code.
 */
type Step =
  | { kind: "call" | "reply" | "ok"; from: LaneId; to: LaneId; label: string }
  | { kind: "note"; at: LaneId; label: string };

const PHASES: { name: string; steps: Step[] }[] = [
  {
    name: "Quote",
    steps: [
      { kind: "call", from: "user", to: "merchant", label: "GET /resource" },
      { kind: "reply", from: "merchant", to: "user", label: "<code>402</code> · price and terms" },
    ],
  },
  {
    name: "Sign",
    steps: [
      {
        kind: "call",
        from: "user",
        to: "canton",
        label: "prepare the transfer on its participant",
      },
      { kind: "reply", from: "canton", to: "user", label: "prepared transaction and its hash" },
      { kind: "note", at: "user", label: "signs the hash with its own key" },
      {
        kind: "call",
        from: "user",
        to: "merchant",
        label: "retry with <code>PAYMENT-SIGNATURE</code>",
      },
    ],
  },
  {
    name: "Settle",
    steps: [
      { kind: "call", from: "merchant", to: "facilitator", label: "<code>POST /v2/verify</code>" },
      { kind: "reply", from: "facilitator", to: "merchant", label: "valid: it pays your terms" },
      { kind: "call", from: "merchant", to: "facilitator", label: "<code>POST /v2/settle</code>" },
      {
        kind: "call",
        from: "facilitator",
        to: "canton",
        label: "execute the payer-signed transaction",
      },
      { kind: "reply", from: "canton", to: "facilitator", label: "committed · update id" },
      { kind: "reply", from: "facilitator", to: "merchant", label: "settled" },
    ],
  },
  {
    name: "Deliver",
    steps: [
      {
        kind: "ok",
        from: "merchant",
        to: "user",
        label: "<code>200 OK</code> · <code>PAYMENT-RESPONSE</code>",
      },
    ],
  },
];

/** 1-based lane position. */
const lane = (id: LaneId): number => LANES.findIndex((l) => l.id === id) + 1;

interface Row {
  n: number;
  label: string;
  /** CSS `grid-column` within the row's 8 half-columns. */
  column: string;
  classes: string[];
  note: boolean;
}

let n = 0;
const ROWS = PHASES.map((phase) => ({
  name: phase.name,
  rows: phase.steps.map((step): Row => {
    n += 1;
    if (step.kind === "note") {
      const at = lane(step.at);
      return {
        n,
        label: step.label,
        column: `${2 * at - 1} / ${2 * at + 1}`,
        classes: [],
        note: true,
      };
    }
    const [from, to] = [lane(step.from), lane(step.to)];
    return {
      n,
      label: step.label,
      column: `${2 * Math.min(from, to)} / ${2 * Math.max(from, to)}`,
      classes: [
        to > from ? "right" : "left",
        step.kind === "call" ? "" : "reply",
        step.kind === "ok" ? "ok" : "",
      ],
      note: false,
    };
  }),
}));
</script>

<template>
  <div class="seq-scroll">
    <div
      class="seq"
      role="img"
      aria-label="Sequence of a paid request between the user, the merchant, the facilitator and Canton"
    >
      <div class="seq-lanes">
        <div v-for="l in LANES" :key="l.id" class="seq-lane">
          <svg viewBox="0 0 24 24" aria-hidden="true" v-html="ICONS[l.icon]" />
          <strong>{{ l.name }}</strong>
          <span>{{ l.role }}</span>
        </div>
      </div>
      <div class="seq-body">
        <div v-for="phase in ROWS" :key="phase.name" class="seq-phase">
          <span class="seq-phase-name">{{ phase.name }}</span>
          <div v-for="row in phase.rows" :key="row.n" class="seq-row">
            <div v-if="row.note" class="seq-note" :style="{ gridColumn: row.column }">
              <b class="seq-n">{{ row.n }}</b
              ><span v-html="row.label" />
            </div>
            <div v-else :class="['seq-msg', ...row.classes]" :style="{ gridColumn: row.column }">
              <span
                ><b class="seq-n">{{ row.n }}</b
                ><span v-html="row.label"
              /></span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seq-scroll {
  overflow-x: auto;
  margin: 24px 0;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background-color: var(--vp-c-bg-soft);
}

.seq {
  --seq-lifeline: linear-gradient(var(--vp-c-divider), var(--vp-c-divider));
  --seq-call: var(--vp-c-brand-1);
  --seq-reply: var(--vp-c-text-3);
  --seq-ok: var(--vp-c-green-1);
  min-width: 680px;
  padding: 12px 12px 10px;
}

/* No gap: each box is spaced by its own margin, so its centre stays on its
   lifeline. */
.seq-lanes {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
}

/* Icon beside the name, the role under it: one compact box per party. */
.seq-lane {
  display: grid;
  grid-template-columns: auto auto;
  justify-content: center;
  align-items: center;
  column-gap: 8px;
  margin: 0 8px;
  border: 1px solid var(--vp-c-divider);
  border-radius: 10px;
  background-color: var(--vp-c-bg);
  padding: 6px 8px;
  line-height: 1.3;
}

.seq-lane svg {
  grid-row: span 2;
  width: 22px;
  height: 22px;
  fill: none;
  stroke: var(--vp-c-brand-1);
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.seq-lane strong {
  font-size: 14px;
}

.seq-lane span {
  color: var(--vp-c-text-2);
  font-size: 12px;
}

.seq-body,
.seq-phase {
  background-image:
    var(--seq-lifeline), var(--seq-lifeline), var(--seq-lifeline), var(--seq-lifeline);
  background-size: 1px 100%;
  background-repeat: no-repeat;
  background-position:
    12.5% 0,
    37.5% 0,
    62.5% 0,
    87.5% 0;
}

.seq-body {
  padding-top: 4px;
}

/* A phase: a tinted band behind its rows, named in the margin left of the
   User lifeline, which no message crosses. */
.seq-phase {
  position: relative;
  margin-top: 6px;
  border-radius: 10px;
  background-color: var(--vp-c-default-soft);
  padding: 4px 0;
}

.seq-phase:nth-child(even) {
  background-color: transparent;
}

.seq-phase-name {
  position: absolute;
  top: 8px;
  left: 10px;
  color: var(--vp-c-text-2);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.seq-row {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  padding: 2px 0;
}

.seq-msg {
  position: relative;
  padding-bottom: 10px;
  font-size: 12.5px;
  line-height: 1.35;
  text-align: center;
}

/* The label sits on its own background, so a lifeline it crosses does not run
   through the text. */
.seq-msg > span {
  display: inline-block;
  max-width: 100%;
  border-radius: 6px;
  background-color: var(--vp-c-bg-soft);
  padding: 0 6px;
  color: var(--vp-c-text-1);
}

.seq-phase:nth-child(odd) .seq-msg > span {
  background-color: var(--vp-c-bg-alt);
}

.seq-msg.reply > span {
  color: var(--vp-c-text-2);
}

.seq-msg::before {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 4px;
  border-top: 2px solid var(--seq-call);
}

.seq-msg.reply::before {
  border-top: 2px dashed var(--seq-reply);
}

.seq-msg.ok::before {
  border-top-color: var(--seq-ok);
}

.seq-msg::after {
  content: "";
  position: absolute;
  bottom: 0;
  border-top: 5px solid transparent;
  border-bottom: 5px solid transparent;
}

.seq-msg.right::after {
  right: -1px;
  border-left: 9px solid var(--seq-call);
}

.seq-msg.left::after {
  left: -1px;
  border-right: 9px solid var(--seq-call);
}

.seq-msg.reply.right::after {
  border-left-color: var(--seq-reply);
}

.seq-msg.reply.left::after {
  border-right-color: var(--seq-reply);
}

.seq-msg.ok.left::after {
  border-right-color: var(--seq-ok);
}

/* Labels are v-html, which scoped styles do not reach without :deep. */
.seq-msg :deep(code),
.seq-note :deep(code) {
  padding: 1px 4px;
  font-size: 11.5px;
  white-space: nowrap;
}

/* The step number on each message. */
.seq-n {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 5px;
  border-radius: 50%;
  background-color: var(--vp-c-brand-soft);
  color: var(--vp-c-brand-1);
  font-size: 10px;
  font-weight: 600;
  vertical-align: 1px;
}

.seq-msg.reply .seq-n {
  background-color: var(--vp-c-default-soft);
  color: var(--vp-c-text-2);
}

.seq-msg.ok .seq-n {
  background-color: var(--vp-c-green-soft);
  color: var(--vp-c-green-1);
}

/* An action a party takes on its own, on its lifeline. */
.seq-note {
  justify-self: center;
  max-width: calc(100% - 8px);
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 8px;
  background-color: var(--vp-c-bg);
  padding: 1px 8px;
  color: var(--vp-c-text-1);
  font-size: 12.5px;
  text-align: center;
}
</style>
