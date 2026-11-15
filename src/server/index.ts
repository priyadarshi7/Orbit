import { serve } from "@hono/node-server";
import { createApp, startupReport } from "../app";
import { buildServer } from "./build";

const app = createApp();
app.outbox.start();
const server = buildServer(app);

serve({ fetch: server.fetch, port: app.cfg.port }, (info) => {
  console.log(`\nOrbit API on http://localhost:${info.port}`);
  for (const l of startupReport(app.cfg)) console.log(l);
  console.log("");
});

const shutdown = () => {
  void app.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
