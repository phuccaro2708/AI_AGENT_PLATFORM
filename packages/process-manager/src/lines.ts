import { StringDecoder } from "node:string_decoder";

/** Splits a byte stream into lines (LF or CRLF); flushes a trailing partial line on `end()`. */
export function createLineSplitter(onLine: (line: string) => void): {
  write(chunk: Buffer | string): void;
  end(): void;
} {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  const drain = () => {
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, "");
      buf = buf.slice(i + 1);
      onLine(line);
    }
  };
  return {
    write(chunk) {
      buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
      drain();
    },
    end() {
      buf += decoder.end();
      drain();
      if (buf.length > 0) onLine(buf.replace(/\r$/, ""));
      buf = "";
    },
  };
}
