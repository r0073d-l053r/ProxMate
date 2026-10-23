/**
 * Server-side input blocking for view-only console sessions.
 *
 * A view-only session runs the same relay as an interactive one, but every chunk
 * the browser sends passes through one of these filters first. Each filter parses
 * the browser→Proxmox byte stream with that console's own framing and forwards
 * only messages that cannot change the guest: no keyboard, mouse, clipboard,
 * desktop resize or power request ever reaches Proxmox, whatever the browser sends.
 *
 * Both consoles reach Proxmox through `vncwebsocket`, which joins WebSocket frames
 * back into one byte stream. So the filters work on bytes, not frames: a message
 * may be split across frames or several may share one, and what is forwarded is
 * re-framed freely. Anything the filter can't frame — an unknown message type, a
 * bad length, an unsupported handshake — throws {@link ConsoleFilterError}, and the
 * relay closes the session rather than guess.
 *
 * The property that matters: the bytes forwarded are always a sequence of whole
 * messages of the allowed kinds, framed exactly as Proxmox frames them, so Proxmox
 * can only ever read those messages, however the browser framed its own stream.
 */

/** The browser sent something the view-only filter can't frame; the session must close. */
export class ConsoleFilterError extends Error {}

/** A filter over the browser→Proxmox stream: bytes in, bytes to forward out. */
export interface ConsoleInputFilter {
  /** Feed one chunk from the browser; returns the bytes to forward (possibly empty). Throws {@link ConsoleFilterError}. */
  push(chunk: Buffer): Buffer;
}

const EMPTY = Buffer.alloc(0);

/**
 * The shared stream machinery: a current unit is accumulated in `head` until
 * `want()` (which may grow as more of the unit is read) is satisfied, then
 * `complete()` decides what of it to forward. A unit can also leave a body to
 * discard unread (`skip`), so a large dropped message is never buffered.
 */
abstract class StreamFilter implements ConsoleInputFilter {
  protected skip = 0;
  private failed = false;
  // The current unit's bytes: `len` of `store`. Grown by doubling, so a unit
  // dripped in one byte per frame still costs linear time; a fresh store is
  // started per unit because forwarded units are views into it.
  private store: Buffer = EMPTY;
  private len = 0;

  /** The current unit so far (a view, valid until the unit completes). */
  protected get head(): Buffer {
    return this.store.subarray(0, this.len);
  }

  /** Total bytes the current unit needs, judged from what `head` holds so far. */
  protected abstract want(): number;
  /** The current unit is complete in `head`: push what to forward onto `out`. */
  protected abstract complete(out: Buffer[]): void;

  push(chunk: Buffer): Buffer {
    if (this.failed) throw new ConsoleFilterError('console filter already failed');
    try {
      return this.run(chunk);
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  private run(chunk: Buffer): Buffer {
    const out: Buffer[] = [];
    let off = 0;
    while (off < chunk.length) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - off);
        this.skip -= n;
        off += n;
        continue;
      }
      const need = this.want();
      if (this.len < need) {
        const n = Math.min(need - this.len, chunk.length - off);
        if (this.len + n > this.store.length) {
          const grown = Buffer.allocUnsafe(Math.max(need, 2 * this.store.length, 16));
          this.store.copy(grown, 0, 0, this.len);
          this.store = grown;
        }
        chunk.copy(this.store, this.len, off, off + n);
        this.len += n;
        off += n;
      }
      // Reading part of a unit can raise what it needs (a length field, a count).
      if (this.len < this.want()) continue;
      this.complete(out);
      this.store = EMPTY;
      this.len = 0;
    }
    return out.length === 1 ? out[0]! : Buffer.concat(out);
  }
}

// ─── Graphical console (RFB / VNC) ───────────────────────────────────────────

type RfbPhase =
  | 'version'
  | 'security'
  | 'vncauth'
  | 'vencrypt-version'
  | 'vencrypt-subtype'
  | 'plain-auth'
  | 'client-init'
  | 'messages';

const SEC_NONE = 1;
const SEC_VNCAUTH = 2;
const SEC_VENCRYPT = 19;
const SEC_PLAIN = 256;

/** Longest VeNCrypt Plain username or password accepted (the ticket is far shorter). */
const MAX_PLAIN_FIELD = 4096;
/** The pseudo-encoding a client lists to use 7-byte extended PointerEvents. */
const ENC_EXTENDED_MOUSE_BUTTONS = -316;
/** Most encodings accepted in one SetEncodings (noVNC lists fewer than 30). */
const MAX_ENCODINGS = 256;

/**
 * View-only filter for the RFB stream (RFC 6143 plus the extensions noVNC uses).
 *
 * Handshake: the client's ProtocolVersion (3.7 or 3.8 only — under 3.3 the server
 * picks the security type, and its choice isn't visible from this side), its
 * security type choice (None, VNC auth, or VeNCrypt 0.2 with a None, VNC auth or
 * Plain subtype — what Proxmox and noVNC use; TLS subtypes can't be inspected and
 * close the session) and the auth reply pass unchanged. ClientInit's shared flag is
 * forced to 1, so a viewer never makes the server drop other people's sessions.
 *
 * After that, SetPixelFormat (0), SetEncodings (2), FramebufferUpdateRequest (3),
 * EnableContinuousUpdates (150) and ClientFence (248) pass. KeyEvent (4),
 * PointerEvent (5), ClientCutText (6, either length sign), xvp power requests
 * (250), SetDesktopSize (251) and QEMU key/audio messages (255) are dropped.
 * Any other type closes the session.
 */
export class RfbViewOnlyFilter extends StreamFilter {
  private phase: RfbPhase = 'version';
  private extendedMouse = false;

  protected want(): number {
    const h = this.head;
    switch (this.phase) {
      case 'version':
        return 12;
      case 'security':
      case 'client-init':
        return 1;
      case 'vncauth':
        return 16;
      case 'vencrypt-version':
        return 2;
      case 'vencrypt-subtype':
        return 4;
      case 'plain-auth': {
        if (h.length < 8) return 8;
        const user = h.readUInt32BE(0);
        const pass = h.readUInt32BE(4);
        if (user > MAX_PLAIN_FIELD || pass > MAX_PLAIN_FIELD) throw new ConsoleFilterError('VeNCrypt Plain credentials too long');
        return 8 + user + pass;
      }
      case 'messages':
        return this.messageLength();
    }
  }

  /** Length of the client message in `head`, as far as it can be told yet. */
  private messageLength(): number {
    const h = this.head;
    if (h.length < 1) return 1;
    const type = h[0]!;
    switch (type) {
      case 0: // SetPixelFormat
        return 20;
      case 2: { // SetEncodings: type, pad, u16 count, s32 × count
        if (h.length < 4) return 4;
        const count = h.readUInt16BE(2);
        if (count > MAX_ENCODINGS) throw new ConsoleFilterError('too many encodings in SetEncodings');
        return 4 + 4 * count;
      }
      case 3: // FramebufferUpdateRequest
        return 10;
      case 4: // KeyEvent
        return 8;
      case 5: // PointerEvent; the marker bit means an extra button byte once negotiated
        if (h.length < 2) return 2;
        return this.extendedMouse && (h[1]! & 0x80) !== 0 ? 7 : 6;
      case 6: // ClientCutText: type, pad×3, s32 length (negative = extended clipboard); body skipped
        return 8;
      case 150: // EnableContinuousUpdates
        return 10;
      case 248: { // ClientFence: type, pad×3, u32 flags, u8 length, payload
        if (h.length < 9) return 9;
        const len = h[8]!;
        if (len > 64) throw new ConsoleFilterError('ClientFence payload too long');
        return 9 + len;
      }
      case 250: // xvp: type, pad, version, op
        return 4;
      case 251: // SetDesktopSize: type, pad, u16 w, u16 h, u8 screens, pad, 16 × screens
        return h.length < 8 ? 8 : 8 + 16 * h[6]!;
      case 255: { // QEMU client message
        if (h.length < 2) return 2;
        const sub = h[1]!;
        if (sub === 0) return 12; // extended key event
        if (sub === 1) { // audio: u16 operation, then a format for "set format"
          if (h.length < 4) return 4;
          const op = h.readUInt16BE(2);
          if (op === 0 || op === 1) return 4;
          if (op === 2) return 10;
          throw new ConsoleFilterError(`unknown QEMU audio operation ${op}`);
        }
        throw new ConsoleFilterError(`unknown QEMU client message ${sub}`);
      }
      default:
        throw new ConsoleFilterError(`unknown RFB client message type ${type}`);
    }
  }

  protected complete(out: Buffer[]): void {
    const h = this.head;
    switch (this.phase) {
      case 'version': {
        const v = h.toString('latin1');
        if (v !== 'RFB 003.008\n' && v !== 'RFB 003.007\n') throw new ConsoleFilterError('unsupported RFB protocol version');
        out.push(h);
        this.phase = 'security';
        return;
      }
      case 'security': {
        const t = h[0]!;
        if (t === SEC_NONE) this.phase = 'client-init';
        else if (t === SEC_VNCAUTH) this.phase = 'vncauth';
        else if (t === SEC_VENCRYPT) this.phase = 'vencrypt-version';
        else throw new ConsoleFilterError(`unsupported RFB security type ${t}`);
        out.push(h);
        return;
      }
      case 'vncauth':
        out.push(h);
        this.phase = 'client-init';
        return;
      case 'vencrypt-version':
        if (h[0] !== 0 || h[1] !== 2) throw new ConsoleFilterError('unsupported VeNCrypt version');
        out.push(h);
        this.phase = 'vencrypt-subtype';
        return;
      case 'vencrypt-subtype': {
        const sub = h.readUInt32BE(0);
        if (sub === SEC_NONE) this.phase = 'client-init';
        else if (sub === SEC_VNCAUTH) this.phase = 'vncauth';
        else if (sub === SEC_PLAIN) this.phase = 'plain-auth';
        else throw new ConsoleFilterError(`unsupported VeNCrypt subtype ${sub}`);
        out.push(h);
        return;
      }
      case 'plain-auth':
        out.push(h);
        this.phase = 'client-init';
        return;
      case 'client-init':
        // Always shared: an exclusive ClientInit would disconnect every other viewer.
        out.push(Buffer.from([1]));
        this.phase = 'messages';
        return;
      case 'messages':
        this.completeMessage(out);
        return;
    }
  }

  private completeMessage(out: Buffer[]): void {
    const h = this.head;
    switch (h[0]!) {
      case 2:
        for (let i = 4; i < h.length; i += 4) {
          if (h.readInt32BE(i) === ENC_EXTENDED_MOUSE_BUTTONS) this.extendedMouse = true;
        }
        out.push(h);
        return;
      case 0:
      case 3:
      case 150:
      case 248:
        out.push(h);
        return;
      case 6: {
        // Drop the header and discard the text without buffering it.
        const len = h.readInt32BE(4);
        this.skip = Math.abs(len);
        return;
      }
      default:
        // 4, 5, 250, 251, 255: input, power or resize — dropped.
        return;
    }
  }
}

// ─── Text console (Proxmox termproxy) ────────────────────────────────────────

type TermPhase = 'auth' | 'messages';

/** Longest `user:ticket` line accepted before the first newline. */
const MAX_AUTH_LINE = 4096;
/** Longest decimal field accepted in a termproxy message header. */
const MAX_LEN_DIGITS = 10;
const MAX_SIZE_DIGITS = 5;

const COLON = 0x3a;
const NEWLINE = 0x0a;
const isDigit = (b: number) => b >= 0x30 && b <= 0x39;

/** Fewest milliseconds between two keepalives forwarded (the browser sends one every 30 s). */
const KEEPALIVE_INTERVAL_MS = 1000;

/**
 * View-only filter for the termproxy stream. The first line (`user:ticket\n`)
 * authenticates and passes. After it, messages are `0:<len>:<data>` (input — the
 * header is dropped and the `len` data bytes discarded unread), `1:<cols>:<rows>:`
 * (resize — also dropped) and `2` (keepalive — passes, at most one a second).
 * Anything else closes the session.
 *
 * Why resizes are dropped too: termproxy does not parse a stream, it parses
 * whatever its fixed buffer holds after each read. A message cut at the buffer's
 * end is half consumed, and the rest is parsed again as new messages — so the
 * digits of a resize can land at the head of the buffer, and a `0` there starts
 * the input path (`0:<n>:` then n bytes written to the terminal). What reaches
 * termproxy after the auth line must therefore hold no `0` byte at all, however
 * it is split. Only `2` bytes are forwarded, so it can't:
 *
 * - termproxy reads until its buffer holds a `\n`, takes everything before the
 *   first `\n` as `user:ticket` and discards the newline; none of that line is
 *   ever parsed as a message, whatever bytes (a `0` included) it contains. This
 *   filter forwards exactly the bytes up to and including that first `\n` as the
 *   auth line, so the two agree on where it ends.
 * - after it, termproxy's message loop looks only at the first byte of what is
 *   buffered: `0` → input, `1` → resize, anything else (`2` among them) consumes
 *   one byte. A buffer of nothing but `2` bytes is consumed one byte at a time and
 *   never reaches the input or resize path.
 */
export class TermViewOnlyFilter extends StreamFilter {
  private phase: TermPhase = 'auth';
  private lastKeepalive = -Infinity;

  /** `now` is injectable for tests. */
  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  protected want(): number {
    const h = this.head;
    if (this.phase === 'auth') {
      if (h.length > 0 && h[h.length - 1] === NEWLINE) return h.length;
      if (h.length >= MAX_AUTH_LINE) throw new ConsoleFilterError('termproxy auth line too long');
      return h.length + 1;
    }
    if (h.length < 1) return 1;
    switch (h[0]) {
      case 0x32: // '2' keepalive
        return 1;
      case 0x30: // '0:<len>:'
        return this.fieldsWant(1, MAX_LEN_DIGITS);
      case 0x31: // '1:<cols>:<rows>:'
        return this.fieldsWant(2, MAX_SIZE_DIGITS);
      default:
        throw new ConsoleFilterError('unknown termproxy message type');
    }
  }

  /**
   * Bytes needed for a header of `fields` colon-terminated decimal fields after
   * the type byte and its colon. Reads one byte at a time until the last colon.
   */
  private fieldsWant(fields: number, maxDigits: number): number {
    const h = this.head;
    if (h.length < 2) return 2;
    if (h[1] !== COLON) throw new ConsoleFilterError('malformed termproxy message');
    let seen = 0;
    let digits = 0;
    for (let i = 2; i < h.length; i++) {
      const b = h[i]!;
      if (b === COLON) {
        if (digits === 0) throw new ConsoleFilterError('empty termproxy message field');
        seen++;
        digits = 0;
        if (seen === fields) return i + 1;
      } else if (isDigit(b)) {
        if (++digits > maxDigits) throw new ConsoleFilterError('termproxy message field too long');
      } else {
        throw new ConsoleFilterError('malformed termproxy message');
      }
    }
    return h.length + 1;
  }

  protected complete(out: Buffer[]): void {
    const h = this.head;
    if (this.phase === 'auth') {
      out.push(h);
      this.phase = 'messages';
      return;
    }
    if (h[0] === 0x30) {
      // Input: drop the header, discard the data unread.
      this.skip = Number(h.subarray(2, h.length - 1).toString('latin1'));
      return;
    }
    if (h[0] === 0x32) {
      const t = this.now();
      if (t - this.lastKeepalive >= KEEPALIVE_INTERVAL_MS) {
        this.lastKeepalive = t;
        out.push(h);
      }
    }
    // Resize: dropped (see the class comment).
  }
}
