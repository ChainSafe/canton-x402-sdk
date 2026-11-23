<!--
  The home page's two integration paths, merchant and buyer, side by side and
  stacked on a phone. Each card is a column, so its button sits at the bottom
  and the two cards' buttons line up whatever their text above.

  The text is data below; `body` and `steps` are HTML, for their inline code.
-->
<script setup lang="ts">
import { withBase } from "vitepress";

import { ICONS, type IconName } from "../icons";

interface Path {
  icon: IconName;
  tag: string;
  title: string;
  body: string;
  steps: string[];
  action: { text: string; link: string };
}

const PATHS: Path[] = [
  {
    icon: "server",
    tag: "For merchants",
    title: "Accept payments",
    body:
      "Gate your API behind HTTP 402, quote a price, and settle each payment through " +
      "the facilitator — straight to your Canton party. Pricing, settlements and API " +
      "keys are managed on the merchant dashboard.",
    steps: [
      "Create your account and link the Canton party you get paid at",
      "Create an API key",
      "Gate your routes with <code>@chainsafe/x402-express</code>",
    ],
    action: { text: "Merchant quickstart", link: "/get-started/accept-payments" },
  },
  {
    icon: "user",
    tag: "For buyers",
    title: "Pay for an API",
    body:
      "Run the payer SDK on your own infrastructure: it finds your holdings, prepares " +
      "the transfer on your participant and signs it with your key, which never " +
      "leaves you. A <code>402</code> is paid and the request retried for you.",
    steps: [
      "Install <code>@chainsafe/x402-server-sdk</code>",
      "Connect it to your Ledger API and signing key",
      "Call paid endpoints through the wrapped <code>fetch</code>",
    ],
    action: { text: "Buyer quickstart", link: "/get-started/pay-for-an-api" },
  },
];
</script>

<template>
  <div class="home-paths">
    <div v-for="path in PATHS" :key="path.title" class="home-path">
      <div class="home-path-head">
        <span class="home-path-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true" v-html="ICONS[path.icon]" />
        </span>
        <div>
          <span class="home-path-tag">{{ path.tag }}</span>
          <h3>{{ path.title }}</h3>
        </div>
      </div>
      <p class="home-path-body" v-html="path.body" />
      <ol class="home-path-steps">
        <li v-for="step in path.steps" :key="step" v-html="step" />
      </ol>
      <div class="home-path-actions">
        <a class="home-path-action" :href="withBase(path.action.link)">{{ path.action.text }}</a>
      </div>
    </div>
  </div>
</template>

<style scoped>
.home-paths {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  margin-top: 20px;
}

.home-path {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--vp-c-divider);
  border-radius: 16px;
  background-color: var(--vp-c-bg-soft);
  padding: 24px;
  transition: border-color 0.25s;
}

.home-path:hover {
  border-color: var(--vp-c-brand-1);
}

.home-path-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.home-path-icon {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background-color: var(--vp-c-brand-soft);
}

.home-path-icon svg {
  width: 24px;
  height: 24px;
  fill: none;
  stroke: var(--vp-c-brand-1);
  stroke-width: 1.75;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.home-path-tag {
  color: var(--vp-c-brand-1);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.home-path h3 {
  margin: 0;
  border: none;
  padding: 0;
  font-size: 20px;
  line-height: 1.3;
}

.home-path-body {
  margin: 16px 0 0;
  color: var(--vp-c-text-2);
  font-size: 15px;
}

/* The steps: numbered circles joined by a line. */
.home-path-steps {
  counter-reset: home-step;
  list-style: none;
  margin: 20px 0 0;
  padding: 0;
}

.home-path-steps li {
  position: relative;
  counter-increment: home-step;
  margin: 0;
  padding: 0 0 14px 40px;
  min-height: 26px;
  line-height: 26px;
}

.home-path-steps li:last-child {
  padding-bottom: 0;
}

.home-path-steps li::before {
  content: counter(home-step);
  position: absolute;
  top: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: 1px solid var(--vp-c-brand-1);
  border-radius: 50%;
  background-color: var(--vp-c-bg);
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}

.home-path-steps li:not(:last-child)::after {
  content: "";
  position: absolute;
  top: 28px;
  bottom: 2px;
  left: 13px;
  border-left: 1px solid var(--vp-c-divider);
}

/* The button, centred at the foot of the card. */
.home-path-actions {
  display: flex;
  justify-content: center;
  margin-top: auto;
  padding-top: 24px;
}

.home-path-action {
  display: inline-block;
  border: 1px solid var(--vp-button-brand-border);
  border-radius: 20px;
  background-color: var(--vp-button-brand-bg);
  padding: 0 18px;
  color: var(--vp-button-brand-text);
  font-size: 14px;
  font-weight: 600;
  line-height: 38px;
  text-decoration: none;
  transition:
    background-color 0.25s,
    border-color 0.25s;
}

.home-path-action:hover {
  border-color: var(--vp-button-brand-hover-border);
  background-color: var(--vp-button-brand-hover-bg);
  color: var(--vp-button-brand-hover-text);
}
</style>
