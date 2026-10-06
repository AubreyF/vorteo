import Constants from "expo-constants";
import { useCallback } from "react";
import { useStore } from "zustand";
import { manualUpdateCheck } from "./manual-check";
import { useFetchQuery } from "@/data/query";

import { checkVortonUpdate } from "./check";

const sourceCommit: unknown = Constants.expoConfig?.extra?.vortonBuildCommit;
export const VORTON_BUILD_COMMIT =
  typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit) ? sourceCommit : null;
const CHECK_INTERVAL = 30 * 60 * 1000;

export function useVortonUpdate(poll = false) {
  const feedback = useStore(manualUpdateCheck.store);
  const query = useFetchQuery({
    dataShape: "value",
    queryKey: ["vorton-update", VORTON_BUILD_COMMIT],
    queryFn: ({ signal }) => {
      if (!VORTON_BUILD_COMMIT) throw new Error("This build has no source commit.");
      return checkVortonUpdate(VORTON_BUILD_COMMIT, signal);
    },
    enabled: VORTON_BUILD_COMMIT !== null,
    staleTimeMs: CHECK_INTERVAL,
    refetchInterval: poll ? CHECK_INTERVAL : false,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    retry: false,
  });
  const { refetch } = query;
  const checkNow = useCallback(() => {
    if (!VORTON_BUILD_COMMIT) return;
    void manualUpdateCheck.check(async () => {
      const result = await refetch({ cancelRefetch: false });
      if (result.error) throw result.error;
      if (!result.data) throw new Error("Update check returned no result.");
      return result.data;
    });
  }, [refetch]);
  return { ...query, checkNow, feedback };
}
