import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import { EasyEmailService } from "../../src/service/easy-email-service.js";

describe("HTTP listen errors", () => {
  it("rejects startup on an occupied port without an uncaught server error", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const started = createEasyEmailHttpServer(new EasyEmailHttpHandler(new EasyEmailService()), {
        port: address.port,
      });
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("listen failure did not reject startup")), 1000);
      });
      await expect(Promise.race([started, deadline])).rejects.toMatchObject({ code: "EADDRINUSE" });
    } finally {
      clearTimeout(timeout);
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  });
});
