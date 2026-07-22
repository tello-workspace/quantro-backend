require("@next/env").loadEnvConfig(process.cwd());

const { createServer } = require("http");
const { parse } = require("url");
const next = require("next");
const { initializeSocket } = require("./src/server/socket");

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "localhost";
const port = parseInt(process.env.PORT || "4000", 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

app.prepare().then(() => {
  const httpServer = createServer((req: import("http").IncomingMessage, res: import("http").ServerResponse) => {
    const parsedUrl = parse(req.url!, true);
    handle(req, res, parsedUrl).catch((err: unknown) => {
      console.error("Error occurred handling", req.url, err);
      res.statusCode = 500;
      res.end("internal server error");
    });
  });

  initializeSocket(httpServer);

  httpServer.listen(port, () => {
    console.log(`> Ready on http://${hostname}:${port}`);
  });
});
