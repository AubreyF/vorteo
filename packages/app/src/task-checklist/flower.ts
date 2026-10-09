import type { ChecklistProgress } from "./progress";

export type PetalStatus = "completed" | "active" | "pending";
export const MAX_TASK_PETALS = 12;

/** Above the cap, blue signals activity rather than counting active tasks. */
export function taskPetals({ completed, active, total }: ChecklistProgress): PetalStatus[] {
  const count = Math.min(total, MAX_TASK_PETALS);
  const summarized = total > MAX_TASK_PETALS;
  const completeCount = summarized ? Math.floor((completed / total) * count) : completed;
  const activeCount = summarized ? Number(active > 0) : active;
  return Array.from({ length: count }, (_, index) => {
    if (index < completeCount) return "completed";
    if (index < completeCount + activeCount) return "active";
    return "pending";
  });
}

export interface PetalGeometry {
  path: string;
  halo: string;
}

// Fixed geometry keeps rendering bounded and leaves gaps even at twelve petals.
const SPARSE_PETAL: PetalGeometry = {
  path: "M12 9 C10.8 7.6 10 5.3 10 4 C10 1.33 14 1.33 14 4 C14 5.3 13.2 7.6 12 9 Z",
  halo: "M12 9.7 C10.6 8.2 9.5 5.5 9.5 4 C9.5 0.67 14.5 0.67 14.5 4 C14.5 5.5 13.4 8.2 12 9.7 Z",
};
const DENSE_PETAL: PetalGeometry = {
  path: "M12 9 C11.4 7.6 11 5.3 11 4 C11 1.33 13 1.33 13 4 C13 5.3 12.6 7.6 12 9 Z",
  halo: "M12 9.7 C11.2 8.2 10.5 5.5 10.5 4 C10.5 0.67 13.5 0.67 13.5 4 C13.5 5.5 12.8 8.2 12 9.7 Z",
};
// A lone petal uses its own centered bounds, not the flower's top radial slot.
const SINGLE_PETAL: PetalGeometry = {
  path: "M12 18 C10.6 15.8 9.3 11.8 9.3 9 C9.3 5 14.7 5 14.7 9 C14.7 11.8 13.4 15.8 12 18 Z",
  halo: "M12 18.8 C10.4 16.4 8.8 12 8.8 9 C8.8 4.33 15.2 4.33 15.2 9 C15.2 12 13.6 16.4 12 18.8 Z",
};

export function petalGeometry(count: number): PetalGeometry {
  if (count === 1) return SINGLE_PETAL;
  return count > 8 ? DENSE_PETAL : SPARSE_PETAL;
}
