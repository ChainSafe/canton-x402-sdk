import type { CSSProperties } from "react";

import { TOOLS } from "@chainsafe/x402-example-one-job-catalog";

const PILL_TOOLS = TOOLS.filter((t) => t.live)
  .slice(0, 14)
  .map((t) => t.tool);

const PILL_OFFSETS: Array<{ rot: number; x: string; y: string; delay: string }> = [
  { rot: -8, x: "8%", y: "12%", delay: "0s" },
  { rot: 6, x: "78%", y: "8%", delay: "-12s" },
  { rot: -4, x: "62%", y: "22%", delay: "-24s" },
  { rot: 10, x: "4%", y: "38%", delay: "-8s" },
  { rot: -12, x: "88%", y: "42%", delay: "-18s" },
  { rot: 5, x: "28%", y: "6%", delay: "-30s" },
  { rot: -6, x: "45%", y: "48%", delay: "-4s" },
  { rot: 8, x: "72%", y: "52%", delay: "-22s" },
  { rot: -3, x: "18%", y: "28%", delay: "-14s" },
  { rot: 7, x: "52%", y: "14%", delay: "-26s" },
  { rot: -9, x: "92%", y: "28%", delay: "-6s" },
  { rot: 4, x: "36%", y: "44%", delay: "-20s" },
  { rot: -5, x: "58%", y: "36%", delay: "-10s" },
  { rot: 11, x: "14%", y: "52%", delay: "-28s" },
];

export function FloatingToolPills() {
  return (
    <div className="tool-pills" aria-hidden>
      {PILL_TOOLS.map((name, i) => {
        const o = PILL_OFFSETS[i % PILL_OFFSETS.length]!;
        return (
          <span
            key={name}
            className="tool-pill"
            style={
              {
                "--pill-rot": `${o.rot}deg`,
                "--pill-x": o.x,
                "--pill-y": o.y,
                "--pill-delay": o.delay,
              } as CSSProperties
            }
          >
            {name}
          </span>
        );
      })}
    </div>
  );
}