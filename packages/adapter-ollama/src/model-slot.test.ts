import { describe, expect, it } from "vitest";
import { ModelSlot } from "./model-slot.js";

const never = new AbortController().signal;
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("ModelSlot", () => {
  it("lets runs of the same model share the slot", async () => {
    const s = new ModelSlot();
    const a = await s.acquire("m", never);
    const b = await s.acquire("m", never);
    expect(s.state()).toEqual({ model: "m", active: 2, waiting: 0 });
    a();
    b();
    expect(s.state()).toEqual({ model: undefined, active: 0, waiting: 0 });
  });

  it("makes another model wait until every active run is done", async () => {
    const s = new ModelSlot();
    const a1 = await s.acquire("a", never);
    const a2 = await s.acquire("a", never);
    let got = false;
    const pb = s.acquire("b", never).then((r) => {
      got = true;
      return r;
    });
    await tick();
    expect(got).toBe(false);
    a1();
    await tick();
    expect(got).toBe(false); // one run of "a" is still active
    a2();
    const rb = await pb;
    expect(s.state()).toMatchObject({ model: "b", active: 1 });
    rb();
  });

  it("is first-come: a later run of the current model does not overtake a waiting other model", async () => {
    const s = new ModelSlot();
    const a1 = await s.acquire("a", never);
    const order: string[] = [];
    const pb = s.acquire("b", never).then((r) => (order.push("b"), r));
    await tick();
    const pa2 = s.acquire("a", never).then((r) => (order.push("a2"), r));
    await tick();
    expect(order).toEqual([]); // a2 waits behind b although "a" is the loaded model
    a1();
    const rb = await pb;
    await tick();
    expect(order).toEqual(["b"]);
    rb();
    (await pa2)();
    expect(order).toEqual(["b", "a2"]);
    expect(s.state().active).toBe(0);
  });

  it("an aborted waiter leaves the queue and unblocks those behind it", async () => {
    const s = new ModelSlot();
    const a1 = await s.acquire("a", never);
    const ac = new AbortController();
    const pb = s.acquire("b", ac.signal);
    const pa2 = s.acquire("a", never); // stuck behind b
    await tick();
    expect(s.state().waiting).toBe(2);
    ac.abort();
    await expect(pb).rejects.toThrow(/aborted/);
    const a2 = await pa2; // the head is "a" again, which may share with the loaded model
    expect(s.state()).toEqual({ model: "a", active: 2, waiting: 0 });
    a2();
    a1();
    expect(s.state().active).toBe(0);
  });

  it("refuses an already aborted signal, and a release is idempotent", async () => {
    const s = new ModelSlot();
    const ac = new AbortController();
    ac.abort();
    await expect(s.acquire("a", ac.signal)).rejects.toThrow(/aborted/);
    const r = await s.acquire("a", never);
    r();
    r();
    expect(s.state().active).toBe(0);
  });
});
