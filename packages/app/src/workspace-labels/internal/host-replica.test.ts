import { expect, test } from "vitest";
import { HostWorkspaceLabelReplica } from "./host-replica";

test("legacy colors become neutral without changing the host payload and explicit choices survive", () => {
  const replica = new HostWorkspaceLabelReplica();
  const labels = [
    { name: "Legacy", color: "red" as const },
    { name: "Chosen", color: "sky" as const, explicitColor: true },
  ];
  replica.applyList({
    requestId: "test",
    labels,
    sync: { mode: "snapshot", generation: "one", headSeq: 0, removals: [] },
  });
  expect(replica.snapshot().labels).toEqual([{ name: "Legacy", color: "neutral" }, labels[1]]);
  expect(labels[0].color).toBe("red");
  expect(
    replica.applyUpdate({
      type: "workspace.label.update",
      payload: {
        kind: "upsert",
        generation: "one",
        seq: 1,
        label: { name: "Chosen", color: "sky", explicitColor: false },
      },
    }),
  ).toBe(true);
  expect(replica.snapshot().labels[1].color).toBe("neutral");
});
