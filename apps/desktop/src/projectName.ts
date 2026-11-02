/** Last path segment of a Windows or POSIX folder path; "" when there is none. */
export function folderName(path: string): string {
  const parts = path
    .trim()
    .split(/[\\/]+/)
    .filter(Boolean);
  const last = parts.at(-1) ?? "";
  return /^[A-Za-z]:$/.test(last) ? "" : last; // a bare drive like "C:" is not a name
}
