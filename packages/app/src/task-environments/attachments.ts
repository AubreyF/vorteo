import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { AgentAttachmentSchema } from "@getpaseo/protocol/messages";

interface AttachmentTransfer {
  attachments: unknown;
  source: Pick<DaemonClient, "readFile">;
  destination: Pick<DaemonClient, "uploadFile">;
}

/** The source draft remains intact until creation succeeds, including on upload failure. */
export async function transferTaskAttachments(input: AttachmentTransfer) {
  if (!Array.isArray(input.attachments)) return undefined;
  const attachments = AgentAttachmentSchema.array().parse(input.attachments);
  const transferred = [];
  for (const attachment of attachments) {
    if (attachment.type !== "uploaded_file") {
      transferred.push(attachment);
      continue;
    }
    try {
      const path = attachment.path.replace(/\\/g, "/");
      const separator = path.lastIndexOf("/");
      if (separator < 0) throw new Error("The attachment has no absolute storage path");
      const directory = path.slice(0, separator) || "/";
      const file = await input.source.readFile(directory, path.slice(separator + 1));
      if (file.bytes.byteLength !== attachment.size)
        throw new Error("The attachment changed or could not be read completely");
      const uploaded = await input.destination.uploadFile({
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        bytes: file.bytes,
      });
      if (uploaded.error || !uploaded.file) throw new Error(uploaded.error ?? "Upload failed");
      transferred.push(uploaded.file);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not transfer ${attachment.fileName}. Retry or remove this attachment. ${reason}`,
        { cause: error },
      );
    }
  }
  return transferred;
}
