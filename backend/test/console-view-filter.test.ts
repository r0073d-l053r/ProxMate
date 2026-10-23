import { describe, it, expect } from 'vitest';
import {
  RfbViewOnlyFilter,
  TermViewOnlyFilter,
  ConsoleFilterError,
  type ConsoleInputFilter,
} from '../src/lib/console-view-filter.js';

// The view-only console filters decide what of a viewer's browser stream reaches
// Proxmox. Every case checks the exact bytes forwarded, and the chunking cases
// check that the result never depends on how the stream was split into frames.

const b = (...bytes: number[]) => Buffer.from(bytes);
const s = (text: string) => Buffer.from(text, 'latin1');
const cat = (...parts: Buffer[]) => Buffer.concat(parts);

function feed(f: ConsoleInputFilter, chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks.map((c) => f.push(c)));
}

/** Every way of cutting `stream` into two frames, plus one byte per frame, plus seeded random frames. */
function chunkings(stream: Buffer): Buffer[][] {
  const out: Buffer[][] = [[stream]];
  for (let i = 1; i < stream.length; i++) out.push([stream.subarray(0, i), stream.subarray(i)]);
  out.push([...stream].map((x) => b(x)));
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let r = 0; r < 25; r++) {
    const frames: Buffer[] = [];
    let off = 0;
    while (off < stream.length) {
      const n = 1 + Math.floor(rand() * 9);
      frames.push(stream.subarray(off, off + n));
      off += n;
    }
    out.push(frames);
  }
  return out;
}

/** Feed `stream` every way `chunkings` cuts it and require the same output each time. */
function expectChunkingInvariant(make: () => ConsoleInputFilter, stream: Buffer, expected: Buffer) {
  for (const frames of chunkings(stream)) {
    expect(feed(make(), frames).equals(expected)).toBe(true);
  }
}

// ─── RFB ─────────────────────────────────────────────────────────────────────

const V38 = s('RFB 003.008\n');
const V37 = s('RFB 003.007\n');
const DES = Buffer.alloc(16, 0x5c);
/** A 3.8 VNC-auth handshake up to and including the ClientInit byte. */
const vncHandshake = (shared: number) => cat(V38, b(2), DES, b(shared));
/** The same handshake as forwarded: ClientInit always shared. */
const vncHandshakeOut = cat(V38, b(2), DES, b(1));

const SET_PIXEL_FORMAT = cat(b(0, 0, 0, 0), b(32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 0, 8, 16, 0, 0, 0));
const setEncodings = (...encs: number[]) => {
  const m = Buffer.alloc(4 + 4 * encs.length);
  m[0] = 2;
  m.writeUInt16BE(encs.length, 2);
  encs.forEach((e, i) => m.writeInt32BE(e, 4 + 4 * i));
  return m;
};
const FBUR = b(3, 1, 0, 0, 0, 0, 4, 0, 3, 0);
const KEY = (keysym: number, down = 1) => {
  const m = Buffer.alloc(8);
  m[0] = 4;
  m[1] = down;
  m.writeUInt32BE(keysym, 4);
  return m;
};
const POINTER = b(5, 1, 0, 50, 0, 60);
const POINTER_EXT = b(5, 0x81, 0, 50, 0, 60, 2);
const cutText = (text: Buffer, extended = false) => {
  const h = Buffer.alloc(8);
  h[0] = 6;
  h.writeInt32BE(extended ? -text.length : text.length, 4);
  return cat(h, text);
};
const CONTINUOUS = b(150, 1, 0, 0, 0, 0, 4, 0, 3, 0);
const fence = (payload: Buffer) => cat(b(248, 0, 0, 0, 0x80, 0, 0, 0x02, payload.length), payload);
const XVP_REBOOT = b(250, 0, 1, 3);
const setDesktopSize = (screens: number) => {
  const m = Buffer.alloc(8 + 16 * screens);
  m[0] = 251;
  m.writeUInt16BE(1920, 2);
  m.writeUInt16BE(1080, 4);
  m[6] = screens;
  return m;
};
const QEMU_KEY = b(255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 0x1e);
const QEMU_AUDIO_ENABLE = b(255, 1, 0, 0);
const QEMU_AUDIO_FORMAT = b(255, 1, 0, 2, 3, 2, 0, 0, 0xac, 0x44);

const rfb = () => new RfbViewOnlyFilter();
/** A filter already past a 3.8 VNC-auth handshake. */
function rfbReady(): RfbViewOnlyFilter {
  const f = rfb();
  expect(f.push(vncHandshake(1)).equals(vncHandshakeOut)).toBe(true);
  return f;
}

describe('RfbViewOnlyFilter — handshake', () => {
  it('passes a 3.8 VNC-auth handshake and forces ClientInit shared', () => {
    expect(rfb().push(vncHandshake(0)).equals(vncHandshakeOut)).toBe(true);
    expect(rfb().push(vncHandshake(1)).equals(vncHandshakeOut)).toBe(true);
    // Any non-zero byte is "shared" too, and is normalized to exactly 1.
    expect(rfb().push(vncHandshake(0xff)).equals(vncHandshakeOut)).toBe(true);
  });

  it('accepts protocol 3.7', () => {
    expect(rfb().push(cat(V37, b(1), b(0))).equals(cat(V37, b(1), b(1)))).toBe(true);
  });

  it('passes security None straight to ClientInit', () => {
    const f = rfb();
    expect(f.push(cat(V38, b(1), b(0), FBUR)).equals(cat(V38, b(1), b(1), FBUR))).toBe(true);
  });

  it('passes VeNCrypt 0.2 with the Plain subtype and its credentials', () => {
    const user = s('root@pam');
    const pass = s('PVEVNC:ticket');
    const lens = Buffer.alloc(8);
    lens.writeUInt32BE(user.length, 0);
    lens.writeUInt32BE(pass.length, 4);
    const sub = Buffer.alloc(4);
    sub.writeUInt32BE(256, 0);
    const pre = cat(V38, b(19), b(0, 2), sub, lens, user, pass);
    expectChunkingInvariant(rfb, cat(pre, b(0), KEY(0x61), FBUR), cat(pre, b(1), FBUR));
  });

  it('passes VeNCrypt with the VNC-auth and None subtypes', () => {
    const vnc = cat(V38, b(19), b(0, 2), b(0, 0, 0, 2), DES);
    expect(rfb().push(cat(vnc, b(0), KEY(1))).equals(cat(vnc, b(1)))).toBe(true);
    const none = cat(V38, b(19), b(0, 2), b(0, 0, 0, 1));
    expect(rfb().push(cat(none, b(0), POINTER)).equals(cat(none, b(1)))).toBe(true);
  });

  it('holds back nothing it has not seen whole: a partial version is not forwarded', () => {
    const f = rfb();
    expect(f.push(V38.subarray(0, 11)).length).toBe(0);
    expect(f.push(V38.subarray(11)).equals(V38)).toBe(true);
  });

  it.each([
    ['protocol 3.3 (server-chosen security)', s('RFB 003.003\n')],
    ['an unknown version', s('RFB 004.001\n')],
    ['garbage in place of a version', s('GET / HTTP/1.')],
  ])('closes on %s', (_l, version) => {
    expect(() => rfb().push(version)).toThrow(ConsoleFilterError);
  });

  it.each([0, 5, 6, 16, 22, 30, 113, 129, 255])('closes on security type %i', (t) => {
    expect(() => rfb().push(cat(V38, b(t)))).toThrow(ConsoleFilterError);
  });

  it('closes on VeNCrypt 0.1 and on TLS / X509 subtypes it cannot inspect', () => {
    expect(() => rfb().push(cat(V38, b(19), b(0, 1)))).toThrow(ConsoleFilterError);
    for (const sub of [257, 258, 259, 260, 261, 262, 19, 0]) {
      const st = Buffer.alloc(4);
      st.writeUInt32BE(sub, 0);
      expect(() => rfb().push(cat(V38, b(19), b(0, 2), st))).toThrow(ConsoleFilterError);
    }
  });

  it('closes on oversized VeNCrypt Plain credentials', () => {
    const lens = Buffer.alloc(8);
    lens.writeUInt32BE(5000, 0);
    expect(() => rfb().push(cat(V38, b(19), b(0, 2), b(0, 0, 1, 0), lens))).toThrow(ConsoleFilterError);
  });

  it('does not take bytes of the auth reply as messages (a KeyEvent-shaped DES response passes as auth)', () => {
    const keyShaped = cat(KEY(0x61), KEY(0x62));
    const stream = cat(V38, b(2), keyShaped, b(0));
    expect(rfb().push(stream).equals(cat(V38, b(2), keyShaped, b(1)))).toBe(true);
  });
});

describe('RfbViewOnlyFilter — client messages', () => {
  it.each([
    ['SetPixelFormat', SET_PIXEL_FORMAT],
    ['SetEncodings (several)', setEncodings(7, 16, 0, -223, -224, -258, -316)],
    ['SetEncodings (none)', setEncodings()],
    ['FramebufferUpdateRequest', FBUR],
    ['EnableContinuousUpdates', CONTINUOUS],
    ['ClientFence (empty)', fence(Buffer.alloc(0))],
    ['ClientFence (64-byte payload)', fence(Buffer.alloc(64, 7))],
  ])('passes %s whole', (_l, msg) => {
    expect(rfbReady().push(msg).equals(msg)).toBe(true);
  });

  it.each([
    ['KeyEvent down', KEY(0x61, 1)],
    ['KeyEvent up', KEY(0xffe1, 0)],
    ['PointerEvent', POINTER],
    ['ClientCutText', cutText(s('rm -rf /\n'))],
    ['ClientCutText (empty)', cutText(Buffer.alloc(0))],
    ['extended ClientCutText (negative length)', cutText(Buffer.alloc(40, 9), true)],
    ['xvp reboot', XVP_REBOOT],
    ['SetDesktopSize (1 screen)', setDesktopSize(1)],
    ['SetDesktopSize (0 screens)', setDesktopSize(0)],
    ['SetDesktopSize (255 screens)', setDesktopSize(255)],
    ['QEMU extended key event', QEMU_KEY],
    ['QEMU audio enable', QEMU_AUDIO_ENABLE],
    ['QEMU audio disable', b(255, 1, 0, 1)],
    ['QEMU audio set format', QEMU_AUDIO_FORMAT],
  ])('drops %s entirely, and the next message still frames', (_l, msg) => {
    expect(rfbReady().push(cat(msg, FBUR)).equals(FBUR)).toBe(true);
  });

  it('frames a PointerEvent as 7 bytes only once extended mouse buttons were requested', () => {
    // Without -316 the marker bit is just a button: 6 bytes, then the FBUR.
    expect(rfbReady().push(cat(b(5, 0x81, 0, 1, 0, 1), FBUR)).equals(FBUR)).toBe(true);
    const encs = setEncodings(7, -316);
    expect(rfbReady().push(cat(encs, POINTER_EXT, POINTER, FBUR)).equals(cat(encs, FBUR))).toBe(true);
  });

  it('discards ClientCutText text without reading it as messages, even when it looks like them', () => {
    const lookalike = cat(KEY(0x61), FBUR, setEncodings(1));
    expect(rfbReady().push(cat(cutText(lookalike), FBUR)).equals(FBUR)).toBe(true);
    expect(rfbReady().push(cat(cutText(lookalike, true), FBUR)).equals(FBUR)).toBe(true);
  });

  it('streams past a large ClientCutText across many frames without forwarding any of it', () => {
    const f = rfbReady();
    const text = Buffer.alloc(1_000_000, 0x41);
    const msg = cutText(text);
    let forwarded = 0;
    for (let off = 0; off < msg.length; off += 4096) forwarded += f.push(msg.subarray(off, off + 4096)).length;
    expect(forwarded).toBe(0);
    expect(f.push(FBUR).equals(FBUR)).toBe(true);
  });

  it('treats the most negative ClientCutText length as 2^31 bytes to discard', () => {
    const f = rfbReady();
    expect(f.push(b(6, 0, 0, 0, 0x80, 0, 0, 0)).length).toBe(0);
    // Whatever follows within that length is discarded, including a would-be FBUR.
    expect(f.push(FBUR).length).toBe(0);
  });

  it.each([1, 7, 8, 127, 149, 151, 200, 247, 249, 252, 253, 254])('closes on unknown message type %i', (t) => {
    expect(() => rfbReady().push(b(t, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow(ConsoleFilterError);
  });

  it('closes on an unknown QEMU submessage or audio operation, and an over-long fence', () => {
    expect(() => rfbReady().push(b(255, 2, 0, 0))).toThrow(ConsoleFilterError);
    expect(() => rfbReady().push(b(255, 1, 0, 3))).toThrow(ConsoleFilterError);
    expect(() => rfbReady().push(cat(b(248, 0, 0, 0, 0, 0, 0, 0, 65), Buffer.alloc(65)))).toThrow(ConsoleFilterError);
  });

  it('forwards nothing from the frame that held a bad message, and stays closed after', () => {
    const f = rfbReady();
    expect(() => f.push(cat(FBUR, b(99)))).toThrow(ConsoleFilterError);
    expect(() => f.push(FBUR)).toThrow(ConsoleFilterError);
  });

  it('gives the same output however a mixed session is split into frames', () => {
    const encs = setEncodings(7, 0, -316, -258);
    const stream = cat(
      vncHandshake(0),
      SET_PIXEL_FORMAT,
      encs,
      FBUR,
      KEY(0x61),
      KEY(0x61, 0),
      POINTER,
      POINTER_EXT,
      cutText(s('secret')),
      cutText(cat(KEY(1), FBUR), true),
      CONTINUOUS,
      fence(s('abc')),
      XVP_REBOOT,
      setDesktopSize(2),
      QEMU_KEY,
      QEMU_AUDIO_FORMAT,
      FBUR,
    );
    const expected = cat(vncHandshakeOut, SET_PIXEL_FORMAT, encs, FBUR, CONTINUOUS, fence(s('abc')), FBUR);
    expectChunkingInvariant(rfb, stream, expected);
  });
});

// ─── termproxy ───────────────────────────────────────────────────────────────

const AUTH = s('root@pam:PVEVNC:ABCDEF==\n');
const term = () => new TermViewOnlyFilter();
function termReady(): TermViewOnlyFilter {
  const f = term();
  expect(f.push(AUTH).equals(AUTH)).toBe(true);
  return f;
}
const input = (data: Buffer) => cat(s(`0:${data.length}:`), data);

describe('TermViewOnlyFilter', () => {
  it('passes the auth line, split or not', () => {
    expect(feed(term(), [AUTH.subarray(0, 4), AUTH.subarray(4, 9), AUTH.subarray(9)]).equals(AUTH)).toBe(true);
  });

  it('a partial auth line forwards nothing yet', () => {
    expect(term().push(AUTH.subarray(0, AUTH.length - 1)).length).toBe(0);
  });

  it('closes on an auth line with no newline within 4096 bytes', () => {
    const f = term();
    expect(f.push(Buffer.alloc(4095, 0x61)).length).toBe(0);
    expect(() => f.push(Buffer.alloc(2, 0x61))).toThrow(ConsoleFilterError);
  });

  it('passes resize and keepalive messages', () => {
    expect(termReady().push(s('1:80:24:')).equals(s('1:80:24:'))).toBe(true);
    expect(termReady().push(s('1:99999:1:')).equals(s('1:99999:1:'))).toBe(true);
    expect(termReady().push(s('2')).equals(s('2'))).toBe(true);
  });

  it.each([
    ['plain keystrokes', s('ls\r')],
    ['a newline', s('\n')],
    ['an empty input', Buffer.alloc(0)],
    ['data that looks like a resize', s('1:80:24:')],
    ['data that looks like a keepalive and auth', s('2root@pam:x\n')],
    ['multi-byte UTF-8', Buffer.from('héllo ☃', 'utf8')],
    ['control characters', b(3, 4, 0x1b, 0x5b, 0x41)],
  ])('drops input of %s, and the next message still frames', (_l, data) => {
    expect(termReady().push(cat(input(data), s('2'))).equals(s('2'))).toBe(true);
  });

  it('discards large input data streamed over many frames', () => {
    const f = termReady();
    const msg = input(Buffer.alloc(200_000, 0x61));
    let forwarded = 0;
    for (let off = 0; off < msg.length; off += 1000) forwarded += f.push(msg.subarray(off, off + 1000)).length;
    expect(forwarded).toBe(0);
    expect(f.push(s('1:80:24:')).equals(s('1:80:24:'))).toBe(true);
  });

  it.each([
    ['a bare keystroke', 'l'],
    ['an unknown type', '3'],
    ['a type without its colon', '0x'],
    ['a non-numeric length', '0:a:'],
    ['an empty length', '0::'],
    ['an over-long length', '0:12345678901:'],
    ['an empty resize field', '1::24:'],
    ['an over-long resize field', '1:123456:24:'],
    ['a signed resize field', '1:-1:24:'],
    ['a resize with a stray byte', '1:80:24x'],
  ])('closes on %s', (_l, text) => {
    expect(() => termReady().push(s(text))).toThrow(ConsoleFilterError);
  });

  it('does not pass the auth line twice: a second line after auth is malformed', () => {
    expect(() => termReady().push(AUTH)).toThrow(ConsoleFilterError);
  });

  it('gives the same output however a session is split into frames', () => {
    const stream = cat(
      AUTH,
      s('1:80:24:'),
      input(s('whoami\r')),
      s('2'),
      input(Buffer.from('çé', 'utf8')),
      input(s('1:1:1:')),
      s('1:120:40:'),
      input(Buffer.alloc(0)),
      s('2'),
    );
    expectChunkingInvariant(term, stream, cat(AUTH, s('1:80:24:'), s('2'), s('1:120:40:'), s('2')));
  });
});
