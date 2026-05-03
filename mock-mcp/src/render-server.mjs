import http from "node:http";
import { handleHttpRequest } from "./mock-core.mjs";

const port = Number(process.env.PORT || 8787);

const server = http.createServer(async (incoming, outgoing) => {
  const url = `http://${incoming.headers.host}${incoming.url}`;
  const chunks = [];

  incoming.on("data", (chunk) => chunks.push(chunk));
  incoming.on("end", async () => {
    try {
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(url, {
        method: incoming.method,
        headers: incoming.headers,
        body: body && !["GET", "HEAD"].includes(incoming.method) ? body : undefined
      });
      const response = await handleHttpRequest(request, process.env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "internal_error", message: error.message }));
    }
  });
});

server.listen(port, () => {
  console.log(`Capacity Risk mock MCP listening on http://localhost:${port}`);
});
