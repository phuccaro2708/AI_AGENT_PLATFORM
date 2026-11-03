import type { AgentAdapter } from "./adapter.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Adapter already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  /** Swaps the adapter with the same id (new launch settings). Tasks already running keep the old one. */
  replace(adapter: AgentAdapter): void {
    if (!this.adapters.has(adapter.id)) throw new Error(`Adapter not registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  /** Adapters whose detect() reports availability. */
  async detectAvailable(): Promise<AgentAdapter[]> {
    const checks = await Promise.all(
      this.list().map(async (a) => ((await a.detect().catch(() => false)) ? a : undefined)),
    );
    return checks.filter((a): a is AgentAdapter => a !== undefined);
  }
}
