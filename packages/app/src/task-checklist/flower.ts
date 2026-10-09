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
}

// Fixed geometry keeps rendering bounded and leaves gaps even at twelve petals.
const SPARSE_PETAL: PetalGeometry = {
  path: "M12 9 C10.8 7.6 10 5.3 10 4 C10 1.33 14 1.33 14 4 C14 5.3 13.2 7.6 12 9 Z",
};
const DENSE_PETAL: PetalGeometry = {
  path: "M12 9 C11.4 7.6 11 5.3 11 4 C11 1.33 13 1.33 13 4 C13 5.3 12.6 7.6 12 9 Z",
};
// Two and three tasks fill more of the icon while retaining a gap between pointed tips.
const SMALL_PETAL: PetalGeometry = {
  path: "M12 11 C10 9.5 8.8 6 8.8 4.4 C8.8 1.2 15.2 1.2 15.2 4.4 C15.2 6 14 9.5 12 11 Z",
};
// A lone petal uses its own centered bounds, not the flower's top radial slot.
const SINGLE_PETAL: PetalGeometry = {
  path: "M12 19 C9.8 16.5 8 11.5 8 8.5 C8 3.833 16 3.833 16 8.5 C16 11.5 14.2 16.5 12 19 Z",
};

export function petalGeometry(count: number): PetalGeometry {
  if (count === 1) return SINGLE_PETAL;
  if (count <= 3) return SMALL_PETAL;
  return count > 8 ? DENSE_PETAL : SPARSE_PETAL;
}
