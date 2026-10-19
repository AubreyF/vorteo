import AsyncStorage from "@/storage/app-storage";

const LEGACY_STORAGE_KEY = "@paseo:replica-cache";

export async function clearLegacyReplicaCache(): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_STORAGE_KEY);
}
