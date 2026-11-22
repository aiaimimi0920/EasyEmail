import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

function parseImapTokens(input) {
  const tokens = [];
  let index = 0;
  while (index < input.length) {
    while (index < input.length && input[index] === " ") index += 1;
    if (index >= input.length) break;
    if (input[index] === '"') {
      index += 1;
      let value = "";
      while (index < input.length && input[index] !== '"') {
        if (input[index] === "\\" && index + 1 < input.length) {
          index += 1;
        }
        value += input[index];
        index += 1;
      }
      index += 1;
      tokens.push(value);
    } else {
      let end = index;
      while (end < input.length && input[end] !== " ") end += 1;
      tokens.push(input.slice(index, end));
      index = end;
    }
  }
  return tokens;
}

function decodePlainSasl(encoded) {
  try {
    const decoded = Buffer.from(encoded.trim(), "base64").toString("utf8");
    const parts = decoded.split("\u0000");
    if (parts.length < 3) return null;
    return {
      username: parts[1] ?? "",
      password: parts.slice(2).join("\u0000"),
    };
  } catch {
    return null;
  }
}

function writeTelemetry(stateFile, state) {
  if (!stateFile) return;
  const resolved = path.resolve(stateFile);
  const tempPath = `${resolved}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(tempPath, resolved);
}

export async function startLoopbackTlsImapServer(options) {
  const {
    certPem,
    keyPem,
    expectedUsername,
    expectedPassword,
    stateFile = null,
    extraCapability = null,
  } = options;
  if (!certPem || !keyPem || !expectedUsername || !expectedPassword) {
    throw new Error("certPem, keyPem, expectedUsername, and expectedPassword are required.");
  }

  const capabilities = ["IMAP4rev1", "IDLE", "NAMESPACE"];
  if (extraCapability) capabilities.push(extraCapability);
  const preAuthCaps = ["IMAP4rev1", "AUTH=PLAIN", "IDLE", "NAMESPACE"].join(" ");
  const postAuthCaps = capabilities.join(" ");

  const state = {
    port: 0,
    connections: 0,
    authenticatedCount: 0,
    rejectedCount: 0,
  };
  const sockets = new Set();

  const server = tls.createServer(
    {
      cert: certPem,
      key: keyPem,
      minVersion: "TLSv1.2",
    },
    (socket) => {
      sockets.add(socket);
      state.connections += 1;
      writeTelemetry(stateFile, state);
      socket.setEncoding("utf8");
      socket.write(`* OK [CAPABILITY ${preAuthCaps}] EasyEmail Loopback TLS IMAP Ready\r\n`);

      let buffer = "";
      let pendingAuthTag = null;

      const finishAuth = (tag, username, password) => {
        if (username === expectedUsername && password === expectedPassword) {
          state.authenticatedCount += 1;
          writeTelemetry(stateFile, state);
          socket.write(`* CAPABILITY ${postAuthCaps}\r\n${tag} OK Authenticated\r\n`);
        } else {
          state.rejectedCount += 1;
          writeTelemetry(stateFile, state);
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
      };

      socket.on("data", (chunk) => {
        buffer += chunk;
        while (true) {
          const lineEnd = buffer.indexOf("\r\n");
          if (lineEnd < 0) break;
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);

          if (pendingAuthTag !== null) {
            const tag = pendingAuthTag;
            pendingAuthTag = null;
            if (line.trim() === "*") {
              socket.write(`${tag} BAD Authentication cancelled\r\n`);
              continue;
            }
            const parsed = decodePlainSasl(line);
            if (!parsed) {
              state.rejectedCount += 1;
              writeTelemetry(stateFile, state);
              socket.write(`${tag} NO [AUTHENTICATIONFAILED] Malformed SASL payload\r\n`);
              continue;
            }
            finishAuth(tag, parsed.username, parsed.password);
            continue;
          }

          const tokens = parseImapTokens(line);
          const tag = tokens[0];
          const command = (tokens[1] ?? "").toUpperCase();
          if (!tag || !command) {
            socket.write("* BAD Empty command\r\n");
            continue;
          }

          if (command === "CAPABILITY") {
            socket.write(`* CAPABILITY ${preAuthCaps}\r\n${tag} OK CAPABILITY completed\r\n`);
          } else if (command === "NOOP") {
            socket.write(`${tag} OK NOOP completed\r\n`);
          } else if (command === "NAMESPACE") {
            socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
          } else if (command === "LOGOUT") {
            socket.write(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
            socket.end();
          } else if (command === "LOGIN") {
            finishAuth(tag, tokens[2] ?? "", tokens[3] ?? "");
          } else if (command === "AUTHENTICATE" && (tokens[2] ?? "").toUpperCase() === "PLAIN") {
            if (tokens[3]) {
              const parsed = decodePlainSasl(tokens[3]);
              if (!parsed) {
                state.rejectedCount += 1;
                writeTelemetry(stateFile, state);
                socket.write(`${tag} NO [AUTHENTICATIONFAILED] Malformed SASL payload\r\n`);
              } else {
                finishAuth(tag, parsed.username, parsed.password);
              }
            } else {
              pendingAuthTag = tag;
              socket.write("+ \r\n");
            }
          } else {
            socket.write(`${tag} BAD Unsupported command\r\n`);
          }
        }
      });

      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => sockets.delete(socket));
    },
  );

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  state.port = typeof address === "object" && address ? address.port : 0;
  writeTelemetry(stateFile, state);

  return {
    port: state.port,
    getState: () => ({ ...state }),
    close: () => new Promise((resolvePromise) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolvePromise());
    }),
  };
}

function cliArgument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const certPath = cliArgument("--cert");
  const keyPath = cliArgument("--key");
  const expectedUsername = cliArgument("--expected-user");
  const expectedPassEnv = cliArgument("--expected-pass-env");
  const stateFile = cliArgument("--state-file");
  const expectedPassword = expectedPassEnv ? process.env[expectedPassEnv] : null;
  if (!certPath || !keyPath || !expectedUsername || !expectedPassword) {
    throw new Error(
      "Usage: node loopback-tls-imap-server.mjs --cert PATH --key PATH --expected-user USER --expected-pass-env ENV [--state-file PATH]",
    );
  }
  const started = await startLoopbackTlsImapServer({
    certPem: fs.readFileSync(certPath, "utf8"),
    keyPem: fs.readFileSync(keyPath, "utf8"),
    expectedUsername,
    expectedPassword,
    stateFile,
  });
  const shutdown = async () => {
    await started.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}
