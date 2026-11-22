import { describe, expect, it } from "vitest";

import {
  isPublicDnsName,
  isPublicIpAddress,
  isSafeAvatarHttpsUrl,
  parseAndValidateAvatarDataUrl,
  validateSafeSvgBytes,
} from "../../src/service/avatar-network.js";

describe("M7C avatar SSRF, DNS/IP, and SVG safety guards", () => {
  it("accepts only multi-label public DNS names and rejects localhost, internal suffixes, and IP literals", () => {
    expect(isPublicDnsName("github.com")).toBe(true);
    expect(isPublicDnsName("res.wx.qq.com")).toBe(true);
    expect(isPublicDnsName("localhost")).toBe(false);
    expect(isPublicDnsName("api.localhost")).toBe(false);
    expect(isPublicDnsName("printer.local")).toBe(false);
    expect(isPublicDnsName("vault.internal")).toBe(false);
    expect(isPublicDnsName("router.home.arpa")).toBe(false);
    expect(isPublicDnsName("intranet")).toBe(false);
    expect(isPublicDnsName("127.0.0.1")).toBe(false);
    expect(isPublicDnsName("::1")).toBe(false);
  });

  it("rejects private, loopback, link-local, CGNAT, documentation, and mapped IPv4/IPv6 addresses", () => {
    expect(isPublicIpAddress("93.184.216.34")).toBe(true);
    expect(isPublicIpAddress("1.1.1.1")).toBe(true);
    expect(isPublicIpAddress("2606:4700:4700::1111")).toBe(true);

    expect(isPublicIpAddress("127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("10.0.0.5")).toBe(false);
    expect(isPublicIpAddress("172.16.10.2")).toBe(false);
    expect(isPublicIpAddress("192.168.1.1")).toBe(false);
    expect(isPublicIpAddress("169.254.169.254")).toBe(false);
    expect(isPublicIpAddress("100.64.0.1")).toBe(false);
    expect(isPublicIpAddress("0.0.0.0")).toBe(false);
    expect(isPublicIpAddress("192.0.2.1")).toBe(false);
    expect(isPublicIpAddress("224.0.0.1")).toBe(false);

    expect(isPublicIpAddress("::1")).toBe(false);
    expect(isPublicIpAddress("::")).toBe(false);
    expect(isPublicIpAddress("fe80::1")).toBe(false);
    expect(isPublicIpAddress("fc00::1")).toBe(false);
    expect(isPublicIpAddress("fd12:3456::1")).toBe(false);
    expect(isPublicIpAddress("2001:db8::1")).toBe(false);
    expect(isPublicIpAddress("::ffff:127.0.0.1")).toBe(false);
    expect(isPublicIpAddress("::ffff:10.1.2.3")).toBe(false);
    expect(isPublicIpAddress("2002:7f00:0001::1")).toBe(false);
  });

  it("enforces HTTPS without embedded credentials and sanitizes/rejects active SVG content", () => {
    expect(isSafeAvatarHttpsUrl("https://github.com/fluidicon.png")).toBe(true);
    expect(isSafeAvatarHttpsUrl("http://github.com/fluidicon.png")).toBe(false);
    expect(isSafeAvatarHttpsUrl("https://user:pass@github.com/fluidicon.png")).toBe(false);
    expect(isSafeAvatarHttpsUrl("https://127.0.0.1/favicon.ico")).toBe(false);
    expect(isSafeAvatarHttpsUrl("https://service.local/favicon.ico")).toBe(false);

    const cleanSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6"/></svg>');
    expect(() => validateSafeSvgBytes(cleanSvg)).not.toThrow();

    const scriptSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(() => validateSafeSvgBytes(scriptSvg)).toThrow(/unsafe/i);

    const handlerSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
    expect(() => validateSafeSvgBytes(handlerSvg)).toThrow(/unsafe/i);

    const badDataUrl = `data:image/svg+xml;base64,${scriptSvg.toString("base64")}`;
    expect(() => parseAndValidateAvatarDataUrl(badDataUrl)).toThrow();
  });
});
