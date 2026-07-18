// Minimal HTTP server so Railway has a health endpoint to probe. The Telegram
// bridge itself uses long-polling and binds no port, so this runs alongside it.
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  hostname: "0.0.0.0",
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/healthz" || pathname === "/") {
      return Response.json({
        ok: true,
        service: "grok-telegram-bridge",
        authMode: process.env.GROK_AUTH_MODE ?? "static",
        // Report presence (never the values) to make misconfig obvious in the probe.
        telegramBot: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[health] listening on :${port}`);
