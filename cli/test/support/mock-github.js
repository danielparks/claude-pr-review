import { createServer } from "node:http";

/**
 * Run func with a mock GitHub.
 *
 * This takes routes as arguments, followed by the function to run.
 */
export async function withMockGitHub(...routes /*, func*/) {
  const func = routes.pop();
  const oldEnv = {
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
    for (const name in oldEnv) {
      if (oldEnv[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = oldEnv[name];
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
      if (!route || !route.responses?.length) {
        const missing = route ? "responses" : "route";
        res.statusCode = 404;
        res.end(JSON.stringify({ message: `no mock ${missing} for ${url}` }));
        return;
      }

      // `responses` lets a route return a different reply each time it's
      // matched (e.g. reject the first attempt, succeed on a retry) --
      // the last entry repeats once the list is exhausted.
      const i = Math.min(route._calls ?? 0, route.responses.length - 1);
      route._calls = (route._calls ?? 0) + 1;
      const response = route.responses[i];
      res.statusCode = response.status ?? 200;
      res.end(JSON.stringify(response.body));
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

/**
 * Produce a route for the mock GitHub.
 *
 * If maybeMatch is a function, it will be used to match the request body.
 * Otherwise, it will be prepended to the responses.
 */
export function route(method, pattern, maybeMatch, ...responses) {
  let match;
  if (typeof maybeMatch === "function") {
    match = maybeMatch;
  } else if (maybeMatch) {
    responses.unshift(maybeMatch);
  }
  return { method, pattern: new RegExp(pattern), match, responses };
}

export const responses = {
  graphql: (...args) => route("POST", "/graphql$", ...args),
  GET_pull: (pr, sha) =>
    route("GET", `/pulls/${pr}$`, { body: { head: { sha } } }),
  POST_review: (pr, new_id) =>
    route("POST", `/pulls/${pr}/reviews$`, {
      body: { id: new_id, html_url: `https://example/review/${new_id}` },
    }),
  GET_pull_review: (pr, review_id, node_id, login) =>
    route("GET", `/pulls/${pr}/reviews/${review_id}$`, {
      body: { node_id, user: { login } },
    }),
  POST_pull_comment_reply: (pr, comment_id, new_id) =>
    route("POST", `/pulls/${pr}/comments/${comment_id}/replies$`, {
      body: {
        id: new_id,
        html_url: `https://example/pulls/${pr}/comments/${new_id}`,
      },
    }),
  GET_issue_comments: (pr, comments) =>
    route("GET", `/issues/${pr}/comments`, { body: comments }),
  POST_issue_comment: (pr, new_id) =>
    route("POST", `/issues/${pr}/comments$`, {
      body: {
        id: new_id,
        html_url: `https://example/issues/${pr}/comments/${new_id}`,
      },
    }),
  PATCH_issue_comment: (comment_id) =>
    route("PATCH", `/issues/comments/${comment_id}$`, {
      body: {
        id: comment_id,
        html_url: `https://example/issues/comments/${comment_id}`,
      },
    }),
  GET_repo_labels: (labels) =>
    route("GET", `/labels\\?`, {
      body: labels ?? [
        { name: "bug", description: "A bug" },
        { name: "enhancement", description: "" },
      ],
    }),
  POST_issue_labels: (pr, response) =>
    route(
      "POST",
      `/issues/${pr}/labels$`,
      response ?? {
        body: [{ id: 1, name: "bug", color: "d73a4a", description: "A bug" }],
      },
    ),
  DELETE_issue_label: (pr, label, response) =>
    route(
      "DELETE",
      `/issues/${pr}/labels/${encodeURIComponent(label)}$`,
      response ?? {
        body: [{ id: 2, name: "other", color: "0075ca", description: "" }],
      },
    ),
};
