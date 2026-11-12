/**
 * Path confinement that survives symlinks.
 *
 * A lexical check ("does the resolved string start with the repo?") passes a symlink inside the repo that points
 * outside it. `confine` resolves symlinks first, so the answer is about where the bytes actually live, and it
 * works for a file that does not exist yet by resolving its nearest existing ancestor.
 */
import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** True when `rel`, a path relative to the root, stays below it. The root itself is not inside. */
const below = (rel: string) => rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);

/** The lexical check, no filesystem access. Kept for callers that only have strings. */
export function insideLexical(path: string, root: string): boolean {
  const target = isAbsolute(path) ? path : resolve(root, path);
  return below(relative(resolve(root), target));
}

async function realOrLexical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The real path of `path` when it lies inside `root`, otherwise null.
 * A dangling symlink is refused: writing through it would create its target, wherever that is.
 */
export async function confine(path: string, root: string): Promise<string | null> {
  const realRoot = await realOrLexical(root);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rest: string[] = [];
  let existing = target;
  let real: string | undefined;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch {
      try {
        if ((await lstat(existing)).isSymbolicLink()) return null;
      } catch {
        /* nothing there yet */
      }
      const parent = dirname(existing);
      if (parent === existing) return null;
      rest.push(basename(existing));
      existing = parent;
    }
  }
  const full = join(real, ...rest.reverse());
  return below(relative(realRoot, full)) ? full : null;
}
