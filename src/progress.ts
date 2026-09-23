type Sink = { isTTY?: boolean; write(s: string): unknown };

export interface Progress {
  tick(msg: string, pct?: number, force?: boolean): void;
  clear(): void;
}

// A terminal repaints one line with \r; piped, every frame would pile into a single line.
export function progress(sink: Sink = process.stderr, everyMs = 5_000, width = 96): Progress {
  let drew = false, lastAt = -Infinity, lastBucket = -1;
  return {
    tick(msg, pct, force = false) {
      if (sink.isTTY) { sink.write("\r" + msg); drew = true; return; }
      const now = Date.now();
      const bucket = pct === undefined ? lastBucket : Math.floor(pct / 10);
      if (!force && now - lastAt < everyMs && bucket === lastBucket) return;
      lastAt = now;
      lastBucket = bucket;
      sink.write(msg.trimEnd() + "\n");
    },
    clear() {
      if (sink.isTTY && drew) sink.write("\r" + " ".repeat(width) + "\r");
      drew = false;
    },
  };
}

export function clearLine(sink: Sink = process.stderr, width = 96): void {
  if (sink.isTTY) sink.write("\r" + " ".repeat(width) + "\r");
}
