// SPDX-License-Identifier: Apache-2.0

import { createApp, listen } from "./app.ts";

const port = Number(process.env["PORT"] ?? 8787);
const app = createApp(port);

listen(app, port)
  .then(() => {
    console.log(`[one-job] http://127.0.0.1:${port}`);
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
