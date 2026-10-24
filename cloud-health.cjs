const http = require("node:http");

const port = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    res.end(JSON.stringify({
      service: "VeriMash",
      status: "online",
      mode: "hosting-check",
      blockchainConnected: false
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`VeriMash hosting check listening on port ${port}`);
});
