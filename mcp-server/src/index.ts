// No shebang here — this is never executed directly as a script, only
// bundled; esbuild.config.js adds the shebang to the built dist/index.js.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GitHubClient } from "./github.js";
import { createServer } from "./server.js";

const { GITHUB_TOKEN, REPO_OWNER, REPO_NAME, PR_NUMBER, GITHUB_API_URL } =
  process.env;

if (!GITHUB_TOKEN || !REPO_OWNER || !REPO_NAME || !PR_NUMBER) {
  console.error(
    "Error: GITHUB_TOKEN, REPO_OWNER, REPO_NAME, and PR_NUMBER environment " +
      "variables are required",
  );
  process.exit(1);
}

const github = new GitHubClient({
  token: GITHUB_TOKEN,
  owner: REPO_OWNER,
  repo: REPO_NAME,
  pullNumber: Number(PR_NUMBER),
  ...(GITHUB_API_URL ? { baseUrl: GITHUB_API_URL } : {}),
});

const server = createServer(github);
const transport = new StdioServerTransport();
await server.connect(transport);
