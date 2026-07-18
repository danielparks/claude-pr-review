import { createServer, type Server } from "node:http";

export type MockRoute = {
  method: string;
  pattern: RegExp;
  status?: number;
  body: unknown;
};

export type CapturedRequest = { method: string; url: string; body: unknown };

export interface MockGitHub {
  server: Server;
  baseUrl: string;
  requests: CapturedRequest[];
  close: () => Promise<void>;
}

export function startMockGitHub(routes: MockRoute[]): Promise<MockGitHub> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => (raw += chunk));
    req.on("end", () => {
      const body: unknown = raw ? JSON.parse(raw) : null;
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
