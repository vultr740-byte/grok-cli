import type { OutboundAttachment } from "./outbound-attachments.js";

const MANIFEST_BLOCK_PATTERN = /```codex-weixin-attachments\s*([\s\S]*?)```/giu;

export function extractOutboundAttachmentManifest(text: string): {
  text: string;
  attachments: OutboundAttachment[];
  errors: string[];
} {
  const attachments: OutboundAttachment[] = [];
  const errors: string[] = [];
  const cleaned = text.replace(MANIFEST_BLOCK_PATTERN, (_match, rawJson: string) => {
    try {
      const parsed = JSON.parse(rawJson) as unknown;
      attachments.push(...normalizeManifestAttachments(parsed));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    return "";
  });

  return {
    text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
    attachments,
    errors,
  };
}

function normalizeManifestAttachments(value: unknown): OutboundAttachment[] {
  const rawAttachments = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { attachments?: unknown }).attachments)
      ? (value as { attachments: unknown[] }).attachments
      : null;
  if (!rawAttachments) {
    throw new Error("Attachment manifest must be an array or an object with attachments array.");
  }

  return rawAttachments.flatMap((item): OutboundAttachment[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as { path?: unknown; caption?: unknown };
    if (typeof record.path !== "string" || !record.path.trim()) {
      return [];
    }
    return [
      {
        path: record.path.trim(),
        caption: typeof record.caption === "string" && record.caption.trim() ? record.caption.trim() : null,
      },
    ];
  });
}
