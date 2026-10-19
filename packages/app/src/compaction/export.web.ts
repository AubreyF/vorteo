export async function exportCompactionSummary(text: string, fileName: string): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser time to start reading the download before releasing its URL.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
