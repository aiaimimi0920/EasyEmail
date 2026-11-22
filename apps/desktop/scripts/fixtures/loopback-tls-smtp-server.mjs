import net from "node:net";
import tls from "node:tls";

export function startLoopbackTlsSmtpServer({
  certPem,
  keyPem,
  expectedUsername,
  expectedPassword,
  mode = "tls",
  authMethods = "PLAIN LOGIN",
  dataResponseCode = 250,
  dataResponseMessage = "2.0.0 OK queued as fake-smtp-msg-1",
  stallOnDataMs = 0,
}) {
  const receivedMessages = [];
  let connections = 0;
  let authenticatedCount = 0;
  let rejectedCount = 0;

  function attachProtocol(initialSocket, isImplicitTls) {
    connections += 1;
    let activeSocket = initialSocket;
    let tlsActive = isImplicitTls;
    let authenticated = false;
    let inData = false;
    let loginStage = null;
    let pendingLoginUser = "";
    let mailFrom = "";
    let rcptTo = [];
    let buffer = "";

    const sendLine = (line) => {
      if (!activeSocket.destroyed) {
        activeSocket.write(`${line}\r\n`);
      }
    };

    const handleCommand = (line) => {
      if (loginStage === "username") {
        pendingLoginUser = Buffer.from(line.trim(), "base64").toString("utf8");
        loginStage = "password";
        sendLine("334 UGFzc3dvcmQ6");
        return;
      }
      if (loginStage === "password") {
        const pass = Buffer.from(line.trim(), "base64").toString("utf8");
        loginStage = null;
        if (tlsActive && pendingLoginUser === expectedUsername && pass === expectedPassword) {
          authenticated = true;
          authenticatedCount += 1;
          sendLine("235 2.7.0 Authentication successful");
        } else {
          rejectedCount += 1;
          sendLine(`535 5.7.8 Authentication credentials invalid (${pass})`);
        }
        return;
      }

      const upper = line.toUpperCase();
      if (upper.startsWith("EHLO ") || upper.startsWith("HELO ")) {
        sendLine("250-127.0.0.1 greets easyemail");
        if (!tlsActive && mode === "starttls") {
          sendLine("250-STARTTLS");
          sendLine("250 8BITMIME");
        } else {
          sendLine(`250-AUTH ${authMethods}`);
          sendLine("250 8BITMIME");
        }
        return;
      }

      if (upper === "STARTTLS" && !tlsActive && mode === "starttls") {
        sendLine("220 2.0.0 Ready to start TLS");
        activeSocket.removeAllListeners("data");
        const tlsSocket = new tls.TLSSocket(activeSocket, {
          isServer: true,
          cert: certPem,
          key: keyPem,
          minVersion: "TLSv1.2",
        });
        activeSocket = tlsSocket;
        tlsActive = true;
        buffer = "";
        tlsSocket.on("data", onData);
        return;
      }

      if (upper === "AUTH LOGIN") {
        if (!tlsActive) {
          sendLine("530 5.7.0 Must issue a STARTTLS command first");
          return;
        }
        loginStage = "username";
        sendLine("334 VXNlcm5hbWU6");
        return;
      }

      if (upper.startsWith("AUTH PLAIN ")) {
        if (!tlsActive) {
          sendLine("530 5.7.0 Must issue a STARTTLS command first");
          return;
        }
        const rawToken = line.slice("AUTH PLAIN ".length).trim();
        const decoded = Buffer.from(rawToken, "base64").toString("utf8");
        const parts = decoded.split("\u0000");
        const user = parts[1] ?? "";
        const pass = parts[2] ?? "";
        if (user === expectedUsername && pass === expectedPassword) {
          authenticated = true;
          authenticatedCount += 1;
          sendLine("235 2.7.0 Authentication successful");
        } else {
          rejectedCount += 1;
          sendLine(`535 5.7.8 Authentication credentials invalid (${pass})`);
        }
        return;
      }

      if (upper.startsWith("MAIL FROM:")) {
        if (!authenticated) {
          sendLine("530 5.7.0 Authentication required");
          return;
        }
        mailFrom = line.slice("MAIL FROM:".length).trim();
        rcptTo = [];
        sendLine("250 2.1.0 Sender OK");
        return;
      }

      if (upper.startsWith("RCPT TO:")) {
        if (!authenticated) {
          sendLine("530 5.7.0 Authentication required");
          return;
        }
        rcptTo.push(line.slice("RCPT TO:".length).trim());
        sendLine("250 2.1.5 Recipient OK");
        return;
      }

      if (upper === "DATA") {
        if (!authenticated || rcptTo.length === 0) {
          sendLine("503 5.5.1 Bad sequence of commands");
          return;
        }
        inData = true;
        sendLine("354 End data with <CR><LF>.<CR><LF>");
        return;
      }

      if (upper === "QUIT") {
        sendLine("221 2.0.0 Bye");
        activeSocket.end();
        return;
      }

      sendLine("500 5.5.2 Command unrecognized");
    };

    const onData = (chunk) => {
      buffer += chunk.toString("utf8");
      while (true) {
        if (inData) {
          const endMarker = buffer.indexOf("\r\n.\r\n");
          if (endMarker < 0) return;
          const rawData = buffer
            .slice(0, endMarker)
            .split("\r\n")
            .map((dataLine) => (dataLine.startsWith("..") ? dataLine.slice(1) : dataLine))
            .join("\r\n");
          buffer = buffer.slice(endMarker + 5);
          inData = false;
          if (stallOnDataMs > 0) {
            setTimeout(() => {
              sendLine(`${dataResponseCode} ${dataResponseMessage}`);
            }, stallOnDataMs);
          } else {
            if (dataResponseCode >= 200 && dataResponseCode < 300) {
              receivedMessages.push({ mailFrom, rcptTo: [...rcptTo], rawData });
            }
            sendLine(`${dataResponseCode} ${dataResponseMessage}`);
          }
          continue;
        }
        const newlineIndex = buffer.indexOf("\r\n");
        if (newlineIndex < 0) return;
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 2);
        handleCommand(line);
      }
    };

    activeSocket.on("data", onData);
    activeSocket.on("error", () => {});
    sendLine("220 127.0.0.1 ESMTP LoopbackFakeSmtp");
  }

  const server = mode === "tls"
    ? tls.createServer({ cert: certPem, key: keyPem, minVersion: "TLSv1.2" }, (socket) => {
        attachProtocol(socket, true);
      })
    : net.createServer((socket) => {
        attachProtocol(socket, false);
      });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        port,
        getState() {
          return {
            port,
            connections,
            authenticatedCount,
            rejectedCount,
            receivedMessages: [...receivedMessages],
          };
        },
        close() {
          return new Promise((res) => server.close(() => res()));
        },
      });
    });
  });
}
