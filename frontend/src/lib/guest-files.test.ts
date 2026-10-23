import { describe, it, expect } from "vitest";
import { cleanLogText, guestPathError, isValidFileMode, suggestedPath } from "./guest-files";

describe("guestPathError", () => {
  it.each(["/etc/motd", "/home/ubuntu/a b.txt", "/srv/x;$(id).sh", "/devices/notes"])("accepts %s", (p) => {
    expect(guestPathError(p)).toBeNull();
  });

  it.each([
    "",
    "etc/motd",
    "/",
    "/etc/",
    "/etc//motd",
    "/etc/./motd",
    "/etc/../shadow",
    "/etc/mo\0td",
    "/etc/mo\ntd",
    "/proc/1/mem",
    "/sys/x",
    "/dev",
    "/dev/sda",
    `/${"a".repeat(231)}`,
  ])("rejects %j", (p) => {
    expect(guestPathError(p)).not.toBeNull();
  });
});

describe("isValidFileMode", () => {
  it.each(["", "644", "0644", "0600", "755"])("accepts %j", (m) => expect(isValidFileMode(m)).toBe(true));
  it.each(["4755", "888", "0o644", "rw-r--r--", "64"])("rejects %j", (m) => expect(isValidFileMode(m)).toBe(false));
});

describe("suggestedPath", () => {
  it("puts the file's name in /root", () => {
    expect(suggestedPath("app.conf")).toBe("/root/app.conf");
  });
  it("replaces characters that aren't plain filename characters", () => {
    expect(suggestedPath("my notes (1).txt")).toBe("/root/my_notes__1_.txt");
    expect(suggestedPath("..")).toBe("/root/file");
    expect(suggestedPath("C:\\Users\\me\\x.sh")).toBe("/root/x.sh");
  });
});

describe("cleanLogText", () => {
  it("strips ANSI escapes and control characters", () => {
    expect(cleanLogText("\x1b[1;31merror\x1b[0m\x07: \x1b]0;t\x07done\x00")).toBe("error: done");
  });
  it("keeps the last state of carriage-return progress lines", () => {
    expect(cleanLogText("  0%\r 50%\r100%\r\nnext")).toBe("100%\nnext");
  });
  it("strips bidirectional overrides and marks", () => {
    expect(cleanLogText("a\u202eb\u200ec\u200fd\u061ce")).toBe("abcde");
  });
  it("keeps markup as text", () => {
    expect(cleanLogText("<img src=x onerror=alert(1)>")).toBe("<img src=x onerror=alert(1)>");
  });
});
