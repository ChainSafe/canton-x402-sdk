import { createHash } from "node:crypto";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp, listen, TRACE_HEADER } from "./app.ts";
import { signStandIn } from "./stand-in.ts";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close((err) => (err ? reject(err) : resolve(address.port)));
    });
  });
}

describe("one-job api", () => {
  let base = "";
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const port = await freePort();
    const running = await listen(createApp(port), port);
    close = running.close;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await close();
  });

  it("answers hash.sha256 with 402, then 200 and the digest", async () => {
    const unpaid = await fetch(`${base}/v1/hash.sha256`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(unpaid.status).toBe(402);
    expect(unpaid.headers.get("payment-required")).toBeTruthy();

    const challenge = (await unpaid.json()) as { accepts: Parameters<typeof signStandIn>[0] };
    const paid = await fetch(`${base}/v1/hash.sha256`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": signStandIn(challenge.accepts),
      },
      body: JSON.stringify({ text: "hello" }),
    });

    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    expect(paid.headers.get(TRACE_HEADER.toLowerCase())).toBeTruthy();
    const body = (await paid.json()) as { result: { hex: string } };
    expect(body.result.hex).toBe(createHash("sha256").update("hello").digest("hex"));
  });

  it("quotes any catalog job before payment", async () => {
    const res = await fetch(`${base}/v1/text.lang`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello there" }),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });
});
