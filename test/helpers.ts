/** The shared store fixture: mkdtemp dir + injected tick clock. Tests
 * never sleep (AGENTS.md); the clock advances 1ms per call so ULIDs and
 * timestamps are strictly ordered. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/index.ts";

export const T0 = Date.parse("2026-07-05T12:00:00.000Z");

export function freshStore(prefix: string): {
  store: Store;
  dir: string;
  now: () => Date;
  dispose: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  let t = T0;
  const now = () => new Date(++t);
  const store = Store.open({ dir, now });
  return {
    store,
    dir,
    now,
    dispose: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
