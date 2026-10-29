// A gzip file written as a stream, in constant memory.
//
// Rows are appended as text; every ~256 KB they are compressed and written, with backpressure honoured, while the
// SHA-256 and size of the uncompressed and compressed bytes are tracked on the way through. Nothing close to the
// whole file is ever held. (The first version built each 64 MB part as one string, then a buffer, then a compressed
// copy, and kept doing so file after file; Bun's GC did not return those buffers fast enough and the machine
// ran out of memory.)
import { createHash } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import { createGzip, type Gzip } from "node:zlib";

export interface Written {
  bytes_raw: number;
  bytes_gz: number;
  sha256_raw: string;
  sha256_gz: string;
}

const BATCH_BYTES = 256 * 1024;

export class GzFile {
  private gz: Gzip = createGzip({ level: 9 });
  private file: WriteStream;
  private rawHash = createHash("sha256");
  private gzHash = createHash("sha256");
  private rawBytes = 0;
  private gzBytes = 0;
  private pending: string[] = [];
  private pendingLen = 0;
  private done: Promise<void>;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.file = createWriteStream(path, { flags: "wx" }); // write-once: never open an existing file
    this.gz.on("data", (c: Buffer) => {
      this.gzHash.update(c);
      this.gzBytes += c.length;
    });
    this.gz.pipe(this.file);
    this.done = new Promise<void>((resolve, reject) => {
      this.file.on("finish", () => resolve());
      this.file.on("error", reject);
      this.gz.on("error", reject);
    });
  }

  async write(s: string): Promise<void> {
    this.pending.push(s);
    this.pendingLen += s.length;
    if (this.pendingLen >= BATCH_BYTES) await this.drain();
  }

  private async drain(): Promise<void> {
    if (this.pending.length === 0) return;
    const b = Buffer.from(this.pending.join(""), "utf8");
    this.pending = [];
    this.pendingLen = 0;
    this.rawHash.update(b);
    this.rawBytes += b.length;
    if (!this.gz.write(b)) await new Promise<void>((r) => this.gz.once("drain", () => r()));
  }

  async close(): Promise<Written> {
    await this.drain();
    this.gz.end();
    await this.done;
    return { bytes_raw: this.rawBytes, bytes_gz: this.gzBytes, sha256_raw: this.rawHash.digest("hex"), sha256_gz: this.gzHash.digest("hex") };
  }
}
