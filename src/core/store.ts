import { createHash } from "node:crypto";
import { applyHunks, computeHunks, type Hunk } from "./hunks";

export const sha = (text: string | null): string => (text === null ? "absent" : createHash("sha1").update(text).digest("hex"));

/** Disk access is injected so the same logic runs in VS Code (WorkspaceEdit) and in tests (node:fs). */
export interface FileIO {
  /** Returns null when the file does not exist. */
  read(abs: string): Promise<string | null>;
  write(abs: string, text: string): Promise<void>;
  remove(abs: string): Promise<void>;
}

export type Decision = "pending" | "accepted" | "rejected";
export type ProposalStatus = "pending" | "applied" | "rejected" | "stale" | "discarded";

export interface Proposal {
  id: string;
  /** Stable key derived from the tool-call arguments, used to pair a TrueForge approval with the MCP call. */
  key: string;
  turnId: string;
  path: string;
  abs: string;
  /** null means the file does not exist yet. */
  original: string | null;
  originalHash: string;
  proposed: string;
  hunks: Hunk[];
  decisions: Decision[];
  status: ProposalStatus;
  rationale: string;
  source: "agent" | "inline";
  createdAt: number;
}

export interface AppliedChange {
  id: string;
  proposalId: string;
  turnId: string;
  path: string;
  abs: string;
  before: string | null;
  after: string;
  afterHash: string;
  hunksApplied: number;
  hunksTotal: number;
  undone: boolean;
  appliedAt: number;
}

export interface ApplyResult {
  ok: boolean;
  message: string;
  change?: AppliedChange;
}

/**
 * Holds every edit the agent proposes. Nothing here touches disk until the
 * user has decided hunk by hunk and `apply` is called; every applied change is
 * recorded so it can be undone, and a cancelled turn can be rolled back whole.
 */
export class ProposalStore {
  private proposals = new Map<string, Proposal>();
  private applied: AppliedChange[] = [];
  private waiters = new Map<string, Array<() => void>>();
  private listeners = new Set<() => void>();
  private seq = 0;

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        /* listener errors must not break the store */
      }
    }
  }

  create(input: { key: string; turnId: string; path: string; abs: string; original: string | null; proposed: string; rationale?: string; source?: "agent" | "inline" }): Proposal {
    const hunks = computeHunks(input.original ?? "", input.proposed);
    const p: Proposal = {
      id: `p${++this.seq}`,
      key: input.key,
      turnId: input.turnId,
      path: input.path,
      abs: input.abs,
      original: input.original,
      originalHash: sha(input.original),
      proposed: input.proposed,
      hunks,
      decisions: hunks.map(() => "pending"),
      status: "pending",
      rationale: input.rationale ?? "",
      source: input.source ?? "agent",
      createdAt: Date.now(),
    };
    this.proposals.set(p.id, p);
    this.emit();
    return p;
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id);
  }
  /** Most recent live proposal created from the same tool-call arguments. */
  findByKey(key: string): Proposal | undefined {
    const all = [...this.proposals.values()].filter((p) => p.key === key && (p.status === "pending" || p.status === "rejected"));
    return all.at(-1);
  }
  pending(): Proposal[] {
    return [...this.proposals.values()].filter((p) => p.status === "pending");
  }
  /** Proposals that still have at least one hunk waiting for the user's decision. */
  awaiting(): Proposal[] {
    return this.pending().filter((p) => !this.isDecided(p));
  }
  all(): Proposal[] {
    return [...this.proposals.values()];
  }
  appliedChanges(): AppliedChange[] {
    return [...this.applied];
  }

  decide(id: string, hunkId: number, decision: "accepted" | "rejected"): void {
    const p = this.proposals.get(id);
    if (!p || p.status !== "pending" || hunkId < 0 || hunkId >= p.decisions.length) return;
    p.decisions[hunkId] = decision;
    this.emit();
    this.settleIfDecided(p);
  }
  decideAll(id: string, decision: "accepted" | "rejected"): void {
    const p = this.proposals.get(id);
    if (!p || p.status !== "pending") return;
    p.decisions = p.decisions.map((d) => (d === "pending" ? decision : d));
    this.emit();
    this.settleIfDecided(p);
  }
  isDecided(p: Proposal): boolean {
    return p.decisions.every((d) => d !== "pending");
  }
  acceptedIds(p: Proposal): number[] {
    return p.decisions.map((d, i) => (d === "accepted" ? i : -1)).filter((i) => i >= 0);
  }
  private settleIfDecided(p: Proposal): void {
    if (!this.isDecided(p)) return;
    // Every hunk rejected: the proposal is over right now, nothing will be written.
    if (this.acceptedIds(p).length === 0) {
      p.status = "rejected";
      this.emit();
    }
    const w = this.waiters.get(p.id) ?? [];
    this.waiters.delete(p.id);
    for (const fn of w) fn();
  }

  /** Resolves once every hunk has a decision, or the proposal is discarded (e.g. the run was cancelled). */
  waitForDecision(id: string): Promise<Proposal | undefined> {
    const p = this.proposals.get(id);
    if (!p) return Promise.resolve(undefined);
    if (p.status !== "pending" || this.isDecided(p)) return Promise.resolve(p);
    return new Promise((resolve) => {
      const list = this.waiters.get(id) ?? [];
      list.push(() => resolve(this.proposals.get(id)));
      this.waiters.set(id, list);
    });
  }

  /** Text that would be written given the current per-hunk decisions. */
  preview(p: Proposal): string {
    return applyHunks(p.original ?? "", p.hunks, this.acceptedIds(p));
  }

  /** Write only the accepted hunks. Refuses if the file changed on disk since it was proposed. */
  async apply(id: string, io: FileIO): Promise<ApplyResult> {
    const p = this.proposals.get(id);
    if (!p) return { ok: false, message: "unknown proposal" };
    const accepted = this.acceptedIds(p);
    if (p.status === "rejected" || (p.status === "pending" && accepted.length === 0)) {
      p.status = "rejected";
      this.emit();
      return { ok: false, message: `The user rejected every hunk of the proposed change to ${p.path}. Nothing was written.` };
    }
    if (p.status !== "pending") return { ok: false, message: `proposal is already ${p.status}` };
    const current = await io.read(p.abs);
    // A cancel can land while the read above is in flight: rollbackTurn then marks this
    // proposal discarded but has nothing applied to revert yet, so do not write at all.
    if ((p.status as Proposal["status"]) !== "pending") {
      return { ok: false, message: `The run was cancelled before the change to ${p.path} was written. Nothing was written.` };
    }
    if (sha(current) !== p.originalHash) {
      p.status = "stale";
      this.emit();
      return { ok: false, message: `${p.path} changed on disk after this edit was proposed, so nothing was written. Read the file again and propose a fresh edit.` };
    }
    const intended = this.preview(p);
    await io.write(p.abs, intended);
    // Record what actually landed (an editor may normalise line endings), so undo's
    // "has the file changed since?" check compares against reality.
    const after = (await io.read(p.abs)) ?? intended;
    const change: AppliedChange = {
      id: `c${++this.seq}`,
      proposalId: p.id,
      turnId: p.turnId,
      path: p.path,
      abs: p.abs,
      before: p.original,
      after,
      afterHash: sha(after),
      hunksApplied: accepted.length,
      hunksTotal: p.hunks.length,
      undone: false,
      appliedAt: Date.now(),
    };
    this.applied.push(change);
    if ((p.status as Proposal["status"]) === "discarded") {
      // Cancelled while the write was in flight: rollbackTurn already ran without seeing this
      // change, so revert it here rather than leave it on disk.
      const r = await this.revert(change, io);
      this.emit();
      return {
        ok: false,
        message: r.ok
          ? `The run was cancelled while ${p.path} was being written, so the change was rolled back. Nothing was kept.`
          : `The run was cancelled while ${p.path} was being written, and the file was edited again before it could be rolled back; it was left alone.`,
      };
    }
    p.status = "applied";
    this.emit();
    const rejected = p.hunks.length - accepted.length;
    return {
      ok: true,
      change,
      message:
        `Applied ${accepted.length} of ${p.hunks.length} hunk(s) to ${p.path} after user review.` +
        (rejected > 0 ? ` The user rejected ${rejected} hunk(s); those lines are unchanged. Read the file before editing it again.` : ""),
    };
  }

  private async revert(c: AppliedChange, io: FileIO): Promise<ApplyResult> {
    if (c.undone) return { ok: false, message: `${c.path}: already undone` };
    const current = await io.read(c.abs);
    if (sha(current) !== c.afterHash) {
      return { ok: false, message: `${c.path} was modified after cIAo Forge applied its change, so it was left alone.` };
    }
    if (c.before === null) await io.remove(c.abs);
    else await io.write(c.abs, c.before);
    c.undone = true;
    this.emit();
    return { ok: true, change: c, message: `Restored ${c.path} to its content before the change.` };
  }

  /** Undo the most recent applied change that has not been undone. */
  async undoLast(io: FileIO): Promise<ApplyResult> {
    const c = [...this.applied].reverse().find((x) => !x.undone);
    if (!c) return { ok: false, message: "Nothing to undo." };
    return this.revert(c, io);
  }
  async undo(changeId: string, io: FileIO): Promise<ApplyResult> {
    const c = this.applied.find((x) => x.id === changeId);
    if (!c) return { ok: false, message: "Unknown change." };
    // A file edited twice must be unwound newest first.
    const later = this.applied.find((x) => !x.undone && x.abs === c.abs && x.appliedAt >= c.appliedAt && x !== c && this.applied.indexOf(x) > this.applied.indexOf(c));
    if (later) return { ok: false, message: `${c.path} has a later change; undo that one first.` };
    return this.revert(c, io);
  }

  /**
   * Cancellation: discard every undecided proposal of the turn and revert every
   * change the turn already applied, newest first, so no half-finished
   * multi-file edit is left behind.
   */
  async rollbackTurn(turnId: string, io: FileIO): Promise<{ reverted: string[]; skipped: string[]; discarded: number }> {
    let discarded = 0;
    for (const p of this.proposals.values()) {
      if (p.turnId === turnId && p.status === "pending") {
        p.status = "discarded";
        discarded++;
        const w = this.waiters.get(p.id) ?? [];
        this.waiters.delete(p.id);
        for (const fn of w) fn();
      }
    }
    const reverted: string[] = [];
    const skipped: string[] = [];
    for (const c of [...this.applied].reverse()) {
      if (c.turnId !== turnId || c.undone) continue;
      const r = await this.revert(c, io);
      (r.ok ? reverted : skipped).push(c.path);
    }
    this.emit();
    return { reverted, skipped, discarded };
  }

  /** Changes applied by a turn that are still in place. */
  turnChanges(turnId: string): AppliedChange[] {
    return this.applied.filter((c) => c.turnId === turnId && !c.undone);
  }
}

/** Key shared by the approval handler and the MCP tool so both see the same proposal. */
export function editKey(args: { path?: unknown; new_content?: unknown; edits?: unknown }): string {
  return sha(JSON.stringify([args.path ?? "", args.new_content ?? null, args.edits ?? null]));
}
