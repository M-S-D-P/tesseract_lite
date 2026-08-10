// Production entrypoint.
//
// `next start` speaks HTTP only. This deployment is reached directly at
// https://<host>:<port> with no reverse proxy in front, so TLS is terminated
// here. Set TLS_CERT_PATH and TLS_KEY_PATH and the server listens on HTTPS;
// leave them unset and it falls back to plain HTTP, which is what you want
// when something else (Apache, a load balancer) is doing TLS instead.

import fs from "fs";
import http from "http";
import https from "https";
import next from "next";

const port = Number(process.env.PORT || 3005);
const hostname = process.env.HOSTNAME || "0.0.0.0";
const certPath = process.env.TLS_CERT_PATH;
const keyPath = process.env.TLS_KEY_PATH;

const app = next({ dev: false, hostname, port });
const handle = app.getRequestHandler();

await app.prepare();

let server;
let scheme;

if (certPath && keyPath) {
  for (const [label, file] of [
    ["TLS_CERT_PATH", certPath],
    ["TLS_KEY_PATH", keyPath],
  ]) {
    if (!fs.existsSync(file)) {
      console.error(`${label} points at ${file}, which does not exist.`);
      process.exit(1);
    }
  }
  const options = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
  // A chain file is only needed when a real CA issued the certificate.
  if (process.env.TLS_CA_PATH && fs.existsSync(process.env.TLS_CA_PATH)) {
    options.ca = fs.readFileSync(process.env.TLS_CA_PATH);
  }
  server = https.createServer(options, (req, res) => handle(req, res));
  scheme = "https";
} else {
  server = http.createServer((req, res) => handle(req, res));
  scheme = "http";
}

// Streaming answers and large repository uploads both outlive the Node
// default of five minutes.
server.requestTimeout = 0;
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;
server.setTimeout(0);

server.listen(port, hostname, () => {
  console.log(`Tesseract Lite ready on ${scheme}://${hostname}:${port}`);
  if (scheme === "http") {
    console.log(
      "TLS_CERT_PATH/TLS_KEY_PATH are not set — serving plain HTTP. Fine behind a proxy that terminates TLS; not fine if this port is reached directly."
    );
  }
});
