import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

export async function exportCompactionSummary(text: string, fileName: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is unavailable.");
  const file = new File(Paths.cache, fileName);
  file.write(text);
  await Sharing.shareAsync(file.uri, { mimeType: "text/plain", dialogTitle: fileName });
}
