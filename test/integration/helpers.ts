import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ApprovalAnswer } from "../../src/copy-guard.ts";
import { runDaemon } from "../../src/daemon.ts";

const binPath = fileURLToPath(new URL("../../bin/patchrome.js", import.meta.url));

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  json: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; hint?: string } };
}

export function makeHome(label: string): string {
  return mkdtempSync(join(tmpdir(), `patchrome-${label}-`));
}

// Every call is a fresh process, as it is for an agent, and always asks for --json to assert on fields.
export function runCli(
  home: string,
  session: string,
  args: string[],
  extraEnv: NodeJS.ProcessEnv = {},
  isJson = true,
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [binPath, ...(isJson ? ["--json"] : []), "--session", session, ...args],
      { env: { ...process.env, PATCHROME_HOME: home, CLAUDE_CODE_SESSION_ID: "", ...extraEnv }, timeout: 110_000 },
      (err, stdout, stderr) => {
        const exitCode = err && typeof err.code === "number" ? err.code : err ? 1 : 0;
        let json: CliResult["json"] = { ok: false };
        try {
          json = JSON.parse(stdout) as CliResult["json"];
        } catch {
          // Non-JSON output leaves json.ok false; the assertion on exitCode or stdout reports it.
        }
        resolve({ exitCode, stdout, stderr, json });
      },
    );
  });
}

// A spawned daemon asks a person to approve every login copy. This one runs inside the test process, where
// the test answers instead; the CLI calls reach it over the socket like any other daemon.
export async function startDaemonAnsweringCopies(home: string, answer: ApprovalAnswer): Promise<{ asked: string[] }> {
  const asked: string[] = [];
  await runDaemon(
    "stealth",
    { ...process.env, PATCHROME_HOME: home },
    {
      prompts: {
        async askApproval(reason) {
          asked.push(reason);
          return { answer, detail: undefined };
        },
        async notify() {},
      },
      exitProcess: () => {},
    },
  );
  return { asked };
}

export async function stopDaemon(home: string): Promise<void> {
  await runCli(home, "teardown", ["daemon", "stop"]);
}

export interface FixtureServer {
  origin: string;
  close: () => Promise<void>;
}

export function startFixtureServer(): Promise<FixtureServer> {
  const pages: Record<
    string,
    (url: URL) => {
      status?: number;
      body: string;
      delayMs?: number;
      contentType?: string;
      headers?: Record<string, string>;
    }
  > = {
    "/form": (url) => ({
      body: `<title>form ${url.searchParams.get("name") ?? ""}</title>
        <h1>${url.searchParams.get("name") ?? "form"}</h1>
        <label>Name <input id="name"></label>
        <button onclick="document.querySelector('#out').textContent = 'hello ' + document.querySelector('#name').value">Greet</button>
        <p id="out"></p>`,
    }),
    // Stands in for a bot wall's interstitial that clears by itself.
    "/challenge": () => ({
      body: `<title>Prove your humanity</title><p>checking</p><script>
        setTimeout(() => { document.title = "programming"; document.body.innerHTML = '<ul id="posts"><li>post one</li></ul>'; }, 3000);
      </script>`,
    }),
    // Stands in for a CAPTCHA widget: a cross-site iframe (localhost, not 127.0.0.1) hides its checkbox and
    // input behind a closed shadow root (open with ?shadow=open), and passes a token to the host page when a trusted click lands.
    "/captcha": () => ({
      body: `<title>captcha host</title>
        <form><input type="hidden" name="cf-turnstile-response" value=""></form>
        <p id="typed"></p>
        <script>
          document.body.insertAdjacentHTML("beforeend", '<iframe src="http://localhost:' + location.port + '/captcha-widget' + location.search + '" width="400" height="120"></iframe>');
          addEventListener("message", ({ data }) => {
            if (data.kind === "passed") document.querySelector("[name=cf-turnstile-response]").value = "token-" + data.isTrusted;
            if (data.kind === "typed") document.querySelector("#typed").textContent = data.value + " " + data.isTrusted;
          });
        </script>`,
    }),
    "/captcha-widget": () => ({
      body: `<title>widget</title><div id="host"></div><script>
        const root = document.querySelector("#host").attachShadow({ mode: location.search === "?shadow=open" ? "open" : "closed" });
        root.innerHTML = '<label><input type="checkbox" id="cb"> Verify you are human</label> <input id="code" aria-label="code">';
        root.querySelector("#cb").addEventListener("click", (event) => parent.postMessage({ kind: "passed", isTrusted: event.isTrusted }, "*"));
        const code = root.querySelector("#code");
        code.addEventListener("input", (event) => parent.postMessage({ kind: "typed", value: code.value, isTrusted: event.isTrusted }, "*"));
      </script>`,
    }),
    "/popup": () => ({ body: `<title>opener</title><a href="/form?name=popup" target="_blank">Open popup</a>` }),
    "/slow": () => ({ body: "<title>slow</title>finally", delayMs: 5_000 }),
    "/long": () => ({ body: `<title>long</title><pre>${"lorem ipsum ".repeat(600)}</pre>` }),
    "/api/items": () => ({
      contentType: "application/json",
      body: JSON.stringify({
        items: [
          { sku: "a1", price: 10 },
          { sku: "b2", price: 25 },
        ],
      }),
    }),
    // The page renders whatever /api/items returns, so a mock shows up in the DOM.
    "/shop": () => ({
      body: `<title>shop</title>
        <ul id="items"></ul>
        <a class="more" href="/form?name=more">More</a>
        <script>
          fetch("/api/items").then((res) => res.json()).then(({ items }) => {
            document.querySelector("#items").innerHTML = items.map((item) =>
              '<li class="item"><h2>' + item.sku + '</h2><span class="price">' + item.price + '</span><a href="/form?name=' + item.sku + '">view</a></li>').join("");
            document.title = "shop loaded";
          }).catch(() => { document.title = "shop failed"; });
          fetch("/api/missing");
        </script>`,
    }),
    "/noisy": () => ({
      body: `<title>noisy</title><script>
        console.log("hello", 42);
        console.warn("careful");
        console.error("broken thing");
        setTimeout(() => { throw new Error("boom from fixture"); }, 50);
      </script>`,
    }),
    "/ticker": () => ({
      body: `<title>ticker</title><script>let n = 0; setInterval(() => console.log("tick " + n++), 200);</script>`,
    }),
    "/login": () => ({
      headers: { "set-cookie": "sid=signed-in; Path=/" },
      body: `<title>login</title><script>localStorage.setItem("token", "t-123"); setTimeout(() => location.href = "/form?name=home", 300);</script>`,
    }),
    // Signs in the way apps that keep tokens in IndexedDB do, with values JSON cannot carry.
    "/auth-seed": () => ({
      headers: { "set-cookie": "sid=from-chrome; Path=/; Max-Age=86400" },
      body: `<title>seeding</title><script>
        localStorage.setItem("token", "ls-token");
        const opening = indexedDB.open("auth", 3);
        opening.onupgradeneeded = () => {
          opening.result.createObjectStore("users", { keyPath: "id" }).createIndex("byEmail", "email", { unique: true });
          opening.result.createObjectStore("tokens");
        };
        opening.onsuccess = () => {
          const tx = opening.result.transaction(["users", "tokens"], "readwrite");
          tx.objectStore("users").put({ id: "u1", email: "ada@example.test", signedInAt: new Date(1700000000000), key: new Uint8Array([7, 8, 9]) });
          tx.objectStore("tokens").put("refresh-token", "firebase:authUser");
          tx.oncomplete = () => { document.title = "seeded"; };
        };
      </script>`,
    }),
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const page = pages[url.pathname];
    if (!page) {
      res.writeHead(404).end("not found");
      return;
    }
    const { status = 200, body, delayMs = 0, contentType = "text/html", headers = {} } = page(url);
    setTimeout(() => {
      res.writeHead(status, { "content-type": contentType, ...headers });
      res.end(contentType === "text/html" ? `<!doctype html>${body}` : body);
    }, delayMs);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
