// Local fixture server shared by spikes: /set-cookie, /whoami, /busy (N subresource requests), /blob/:n
import { createServer } from "node:http";

export function startFixtureServer() {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/set-cookie") {
      res.writeHead(200, { "set-cookie": "who=persistent; Path=/", "content-type": "text/html" });
      return res.end("<title>set</title>cookie set");
    }
    if (url.pathname === "/whoami") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<title>whoami</title><pre id="c">${req.headers.cookie ?? "no-cookie"}</pre>`);
    }
    if (url.pathname === "/busy") {
      const count = Number(url.searchParams.get("n") ?? 2000);
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<title>busy</title><script>
        window.done = 0;
        for (let i = 0; i < ${count}; i++) fetch('/blob/' + i).then(r => r.text()).then(() => window.ok = (window.ok ?? 0) + 1, e => window.failed = (window.failed ?? 0) + 1).finally(() => window.done++);
      </script>`);
    }
    if (url.pathname.startsWith("/blob/")) {
      const n = url.pathname.split("/")[2];
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ n, pad: "x".repeat(2000) }));
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })),
  );
}
