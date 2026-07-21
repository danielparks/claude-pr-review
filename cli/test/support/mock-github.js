import { createServer } from "node:http";

export function startMockGitHub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url ?? "";
      requests.push({ method: req.method ?? "", url, body });

      const route = routes.find(
        (r) => r.method === req.method && r.pattern.test(url),
      );
      res.setHeader("Content-Type", "application/json");
      if (!route) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `no mock route for ${url}` }));
        return;
      }

      // `responses` lets a route return a different reply each time it's
      // matched (e.g. reject the first attempt, succeed on a retry) --
      // the last entry repeats once the list is exhausted.
      if (route.responses) {
        const i = Math.min(route._calls ?? 0, route.responses.length - 1);
        route._calls = (route._calls ?? 0) + 1;
        const response = route.responses[i];
        res.statusCode = response.status ?? 200;
        res.end(JSON.stringify(response.body));
        return;
      }

      res.statusCode = route.status ?? 200;
      res.end(JSON.stringify(route.body));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
