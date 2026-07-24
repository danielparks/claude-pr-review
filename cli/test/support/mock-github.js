import { createServer } from "node:http";

export async function withMockGitHub(...routes /*, func*/) {
  const func = routes.pop();
  const old_env = {
    GITHUB_API_URL: process.env.GITHUB_API_URL,
    GITHUB_GRAPHQL_URL: process.env.GITHUB_GRAPHQL_URL,
  };
  const mock = await startMockGitHub(routes);
  process.env.GITHUB_API_URL = mock.baseUrl;
  process.env.GITHUB_GRAPHQL_URL = `${mock.baseUrl}/graphql`;

  try {
    return await func(mock);
  } finally {
    await mock?.close();
    for (const name in old_env) {
      if (old_env[name] === undefined) {
        delete process[name];
      } else {
        process[name] = old_env[name];
      }
    }
  }
}

export function startMockGitHub(routes) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = req.url ?? "";
      requests.push({ method: req.method ?? "", url, body });

      // `match` lets a route additionally check the request body, so
      // concurrent requests to the same method+URL (e.g. two different
      // GraphQL queries, both POSTed to /graphql) can be told apart without
      // depending on which one the server happens to receive first.
      const route = routes.find(
        (r) =>
          r.method === req.method &&
          r.pattern.test(url) &&
          (!r.match || r.match(body)),
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

export function filterByUrlEnd(requests, suffix) {
  return requests.filter((r) => r.url.endsWith(suffix));
}
