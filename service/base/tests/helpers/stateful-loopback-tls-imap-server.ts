import tls from "node:tls";

import {
  decodePlainSasl,
  formatFetchItem,
  matchesImapSequenceSet,
  parseImapTokens,
  type FakeImapFolderState,
  type FakeImapStoredMessage,
} from "./imap-wire-protocol.js";

export type { FakeImapFolderState, FakeImapStoredMessage } from "./imap-wire-protocol.js";

export interface StatefulLoopbackTlsImapServerOptions {
  certPem: string;
  keyPem: string;
  expectedUsername: string;
  expectedPassword: string;
  folders?: FakeImapFolderState[];
  enableMoveCapability?: boolean;
}

export interface StatefulLoopbackTlsImapServerHandle {
  port: number;
  setFailureMode(mode: "none" | "reject_commands" | "drop_connection"): void;
  getFolder(path: string): FakeImapFolderState | undefined;
  upsertFolder(folder: FakeImapFolderState): void;
  renameFolder(oldPath: string, newPath: string, nextUidValidity?: number): void;
  appendMessage(folderPath: string, message: Omit<FakeImapStoredMessage, "uid"> & { uid?: number }): number;
  resetUidValidity(folderPath: string, nextUidValidity: number, messages: FakeImapStoredMessage[]): void;
  getTelemetry(): {
    connections: number;
    authenticatedCount: number;
    rejectedAuthCount: number;
    commands: string[];
  };
  close(): Promise<void>;
}

export async function startStatefulLoopbackTlsImapServer(
  options: StatefulLoopbackTlsImapServerOptions,
): Promise<StatefulLoopbackTlsImapServerHandle> {
  const folderMap = new Map<string, FakeImapFolderState>();
  const initialFolders: FakeImapFolderState[] = options.folders ?? [
    { path: "INBOX", delimiter: "/", flags: ["\\HasNoChildren"], uidValidity: 100, uidNext: 1, messages: [] },
    { path: "Archive", delimiter: "/", flags: ["\\HasNoChildren", "\\Archive"], uidValidity: 200, uidNext: 1, messages: [] },
    { path: "Spam", delimiter: "/", flags: ["\\HasNoChildren", "\\Junk"], uidValidity: 300, uidNext: 1, messages: [] },
    { path: "Trash", delimiter: "/", flags: ["\\HasNoChildren", "\\Trash"], uidValidity: 400, uidNext: 1, messages: [] },
  ];
  for (const folder of initialFolders) {
    folderMap.set(folder.path, {
      ...folder,
      messages: folder.messages.map((m) => ({ ...m, flags: [...m.flags] })),
    });
  }

  let failureMode: "none" | "reject_commands" | "drop_connection" = "none";
  const telemetry = {
    connections: 0,
    authenticatedCount: 0,
    rejectedAuthCount: 0,
    commands: [] as string[],
  };
  const caps = [
    "IMAP4rev1",
    "IDLE",
    "NAMESPACE",
    "SPECIAL-USE",
    "UIDPLUS",
    ...(options.enableMoveCapability !== false ? ["MOVE"] : []),
  ];
  const preAuthCaps = ["IMAP4rev1", "AUTH=PLAIN", ...caps.slice(1)].join(" ");
  const postAuthCaps = caps.join(" ");
  const sockets = new Set<tls.TLSSocket>();

  const server = tls.createServer(
    { cert: options.certPem, key: options.keyPem, minVersion: "TLSv1.2" },
    (socket) => {
      sockets.add(socket);
      telemetry.connections += 1;
      socket.setEncoding("utf8");
      if (failureMode === "drop_connection") {
        socket.destroy();
        return;
      }
      socket.write(`* OK [CAPABILITY ${preAuthCaps}] EasyEmail Stateful Loopback IMAP Ready\r\n`);

      let buffer = "";
      let pendingAuthTag: string | null = null;
      let authenticated = false;
      let selectedFolder: FakeImapFolderState | null = null;

      const finishAuth = (tag: string, username: string, password: string) => {
        if (username === options.expectedUsername && password === options.expectedPassword) {
          authenticated = true;
          telemetry.authenticatedCount += 1;
          socket.write(`* CAPABILITY ${postAuthCaps}\r\n${tag} OK Authenticated\r\n`);
        } else {
          telemetry.rejectedAuthCount += 1;
          socket.write(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        }
      };

      const copyOrMoveByUid = (
        tag: string,
        uidSet: string,
        targetPath: string,
        removeSource: boolean,
      ) => {
        if (!selectedFolder) {
          socket.write(`${tag} BAD No mailbox selected\r\n`);
          return;
        }
        const target = folderMap.get(targetPath);
        if (!target) {
          socket.write(`${tag} NO [TRYCREATE] Target mailbox does not exist\r\n`);
          return;
        }
        const maxUid = selectedFolder.messages.reduce((max, item) => Math.max(max, item.uid), 0);
        const matched = selectedFolder.messages.filter((item) => matchesImapSequenceSet(uidSet, item.uid, maxUid));
        const sourceUids: number[] = [];
        const destUids: number[] = [];
        const expungedSeqs: number[] = [];
        for (const msg of matched) {
          const newUid = target.uidNext++;
          target.messages.push({
            ...msg,
            uid: newUid,
            flags: msg.flags.filter((flag) => flag.toLowerCase() !== "\\deleted"),
          });
          sourceUids.push(msg.uid);
          destUids.push(newUid);
        }
        if (removeSource) {
          for (const uid of sourceUids) {
            const idx = selectedFolder.messages.findIndex((item) => item.uid === uid);
            if (idx >= 0) {
              selectedFolder.messages.splice(idx, 1);
              expungedSeqs.push(idx + 1);
            }
          }
        }
        const copyUidSuffix = sourceUids.length > 0
          ? `[COPYUID ${target.uidValidity} ${sourceUids.join(",")} ${destUids.join(",")}] `
          : "";
        if (removeSource && copyUidSuffix) {
          socket.write(`* OK ${copyUidSuffix.trim()}\r\n`);
        }
        for (const seq of expungedSeqs) {
          socket.write(`* ${seq} EXPUNGE\r\n`);
        }
        socket.write(`${tag} OK ${copyUidSuffix}${removeSource ? "UID MOVE" : "UID COPY"} completed\r\n`);
      };

      socket.on("data", (chunk: string) => {
        buffer += chunk;
        while (true) {
          const lineEnd = buffer.indexOf("\r\n");
          if (lineEnd < 0) break;
          const line = buffer.slice(0, lineEnd);
          buffer = buffer.slice(lineEnd + 2);

          if (failureMode === "drop_connection") {
            socket.destroy();
            return;
          }

          if (pendingAuthTag !== null) {
            const tag = pendingAuthTag;
            pendingAuthTag = null;
            const parsed = decodePlainSasl(line);
            if (!parsed) {
              telemetry.rejectedAuthCount += 1;
              socket.write(`${tag} NO [AUTHENTICATIONFAILED] Malformed SASL\r\n`);
            } else {
              finishAuth(tag, parsed.username, parsed.password);
            }
            continue;
          }

          const tokens = parseImapTokens(line);
          const tag = tokens[0];
          const command = (tokens[1] ?? "").toUpperCase();
          if (!tag || !command) {
            socket.write("* BAD Empty command\r\n");
            continue;
          }
          telemetry.commands.push(command === "UID" ? `UID ${(tokens[2] ?? "").toUpperCase()}` : command);

          if (command === "CAPABILITY") {
            socket.write(`* CAPABILITY ${authenticated ? postAuthCaps : preAuthCaps}\r\n${tag} OK CAPABILITY completed\r\n`);
            continue;
          }
          if (command === "NOOP") {
            socket.write(`${tag} OK NOOP completed\r\n`);
            continue;
          }
          if (command === "LOGOUT") {
            socket.write(`* BYE Logging out\r\n${tag} OK LOGOUT completed\r\n`);
            socket.end();
            continue;
          }
          if (command === "LOGIN") {
            finishAuth(tag, tokens[2] ?? "", tokens[3] ?? "");
            continue;
          }
          if (command === "AUTHENTICATE" && (tokens[2] ?? "").toUpperCase() === "PLAIN") {
            if (tokens[3]) {
              const parsed = decodePlainSasl(tokens[3]);
              if (!parsed) {
                telemetry.rejectedAuthCount += 1;
                socket.write(`${tag} NO [AUTHENTICATIONFAILED] Malformed SASL\r\n`);
              } else {
                finishAuth(tag, parsed.username, parsed.password);
              }
            } else {
              pendingAuthTag = tag;
              socket.write("+ \r\n");
            }
            continue;
          }

          if (!authenticated) {
            socket.write(`${tag} NO Authentication required\r\n`);
            continue;
          }
          if (failureMode === "reject_commands") {
            socket.write(`${tag} NO [UNAVAILABLE] Temporary server failure\r\n`);
            continue;
          }

          if (command === "NAMESPACE") {
            socket.write(`* NAMESPACE (("" "/")) NIL NIL\r\n${tag} OK NAMESPACE completed\r\n`);
          } else if (command === "LIST") {
            const pattern = tokens[3] ?? "*";
            if (pattern === "") {
              socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`);
            } else {
              for (const folder of folderMap.values()) {
                const flags = (folder.flags ?? ["\\HasNoChildren"]).join(" ");
                socket.write(`* LIST (${flags}) "${folder.delimiter ?? "/"}" "${folder.path}"\r\n`);
              }
              socket.write(`${tag} OK LIST completed\r\n`);
            }
          } else if (command === "SELECT" || command === "EXAMINE") {
            const folderPath = tokens[2] ?? "";
            const folder = folderMap.get(folderPath);
            if (!folder) {
              socket.write(`${tag} NO [NONEXISTENT] Unknown mailbox\r\n`);
              continue;
            }
            selectedFolder = folder;
            socket.write(
              [
                `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`,
                `* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted`,
                `* ${folder.messages.length} EXISTS`,
                `* 0 RECENT`,
                `* OK [UIDVALIDITY ${folder.uidValidity}] UIDs valid`,
                `* OK [UIDNEXT ${folder.uidNext}] Predicted next UID`,
                `${tag} OK [${command === "EXAMINE" ? "READ-ONLY" : "READ-WRITE"}] ${command} completed\r\n`,
              ].join("\r\n"),
            );
          } else if (command === "CLOSE" || command === "UNSELECT") {
            selectedFolder = null;
            socket.write(`${tag} OK ${command} completed\r\n`);
          } else if (command === "EXPUNGE") {
            if (selectedFolder) {
              for (let idx = selectedFolder.messages.length - 1; idx >= 0; idx -= 1) {
                const item = selectedFolder.messages[idx];
                if (item && item.flags.some((f) => f.toLowerCase() === "\\deleted")) {
                  selectedFolder.messages.splice(idx, 1);
                  socket.write(`* ${idx + 1} EXPUNGE\r\n`);
                }
              }
            }
            socket.write(`${tag} OK EXPUNGE completed\r\n`);
          } else if (command === "FETCH") {
            if (!selectedFolder) {
              socket.write(`${tag} BAD No mailbox selected\r\n`);
              continue;
            }
            const seqSet = tokens[2] ?? "1:*";
            const maxSeq = selectedFolder.messages.length;
            selectedFolder.messages.forEach((msg, index) => {
              const seq = index + 1;
              if (matchesImapSequenceSet(seqSet, seq, maxSeq)) {
                socket.write(formatFetchItem(seq, msg, line));
              }
            });
            socket.write(`${tag} OK FETCH completed\r\n`);
          } else if (command === "UID") {
            const sub = (tokens[2] ?? "").toUpperCase();
            if (!selectedFolder) {
              socket.write(`${tag} BAD No mailbox selected\r\n`);
              continue;
            }
            const maxUid = selectedFolder.messages.reduce((max, item) => Math.max(max, item.uid), 0);
            if (sub === "FETCH") {
              const uidSet = tokens[3] ?? "1:*";
              selectedFolder.messages.forEach((msg, index) => {
                if (maxUid > 0 && matchesImapSequenceSet(uidSet, msg.uid, maxUid)) {
                  socket.write(formatFetchItem(index + 1, msg, line));
                }
              });
              socket.write(`${tag} OK UID FETCH completed\r\n`);
            } else if (sub === "STORE") {
              const uidSet = tokens[3] ?? "";
              const mode = (tokens[4] ?? "").toUpperCase();
              const rawFlags = (tokens[5] ?? "").replace(/^\(|\)$/gu, "").split(/\s+/u).filter(Boolean);
              for (const msg of selectedFolder.messages) {
                if (!matchesImapSequenceSet(uidSet, msg.uid, maxUid)) continue;
                if (mode.startsWith("+FLAGS")) {
                  for (const flag of rawFlags) {
                    if (!msg.flags.some((existing) => existing.toLowerCase() === flag.toLowerCase())) {
                      msg.flags.push(flag);
                    }
                  }
                } else if (mode.startsWith("-FLAGS")) {
                  msg.flags = msg.flags.filter(
                    (existing) => !rawFlags.some((flag) => flag.toLowerCase() === existing.toLowerCase()),
                  );
                }
              }
              socket.write(`${tag} OK UID STORE completed\r\n`);
            } else if (sub === "EXPUNGE") {
              const uidSet = tokens[3] ?? "";
              for (let idx = selectedFolder.messages.length - 1; idx >= 0; idx -= 1) {
                const msg = selectedFolder.messages[idx];
                if (
                  msg
                  && matchesImapSequenceSet(uidSet, msg.uid, maxUid)
                  && msg.flags.some((f) => f.toLowerCase() === "\\deleted")
                ) {
                  selectedFolder.messages.splice(idx, 1);
                  socket.write(`* ${idx + 1} EXPUNGE\r\n`);
                }
              }
              socket.write(`${tag} OK UID EXPUNGE completed\r\n`);
            } else if (sub === "MOVE") {
              copyOrMoveByUid(tag, tokens[3] ?? "", tokens[4] ?? "", true);
            } else if (sub === "COPY") {
              copyOrMoveByUid(tag, tokens[3] ?? "", tokens[4] ?? "", false);
            } else {
              socket.write(`${tag} BAD Unsupported UID subcommand\r\n`);
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

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    port,
    setFailureMode(mode) {
      failureMode = mode;
    },
    getFolder(folderPath) {
      const folder = folderMap.get(folderPath);
      if (!folder) return undefined;
      return {
        ...folder,
        messages: folder.messages.map((m) => ({ ...m, flags: [...m.flags] })),
      };
    },
    upsertFolder(folder) {
      folderMap.set(folder.path, {
        ...folder,
        messages: folder.messages.map((m) => ({ ...m, flags: [...m.flags] })),
      });
    },
    renameFolder(oldPath, newPath, nextUidValidity) {
      const existing = folderMap.get(oldPath);
      if (!existing) return;
      folderMap.delete(oldPath);
      folderMap.set(newPath, {
        ...existing,
        path: newPath,
        ...(nextUidValidity !== undefined ? { uidValidity: nextUidValidity } : {}),
      });
    },
    appendMessage(folderPath, message) {
      const folder = folderMap.get(folderPath);
      if (!folder) {
        throw new Error(`Unknown fake IMAP folder: ${folderPath}`);
      }
      const uid = message.uid ?? folder.uidNext;
      folder.uidNext = Math.max(folder.uidNext, uid + 1);
      folder.messages.push({
        ...message,
        uid,
        flags: [...message.flags],
      });
      return uid;
    },
    resetUidValidity(folderPath, nextUidValidity, messages) {
      const folder = folderMap.get(folderPath);
      if (!folder) return;
      folder.uidValidity = nextUidValidity;
      const highest = messages.reduce((max, item) => Math.max(max, item.uid), 0);
      folder.uidNext = highest + 1;
      folder.messages = messages.map((m) => ({ ...m, flags: [...m.flags] }));
    },
    getTelemetry() {
      return {
        connections: telemetry.connections,
        authenticatedCount: telemetry.authenticatedCount,
        rejectedAuthCount: telemetry.rejectedAuthCount,
        commands: [...telemetry.commands],
      };
    },
    close() {
      return new Promise((resolvePromise) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolvePromise());
      });
    },
  };
}
