import { useCallback } from "react";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Copy } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { PaneContentToolbar } from "@/components/ui/pane-content-toolbar";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { Theme } from "@/styles/theme";
import { FileConflictAlert, type FileConflictAlertState } from "./conflict-alert";
import type { FileEditorStatus } from "./editor/model";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export function FilePanelBar({
  size,
  lineCount,
  mode,
  onModeChange,
  editorStatus,
  cursor,
  vimMode,
  conflict,
  textContent,
}: {
  size: number;
  lineCount?: number;
  mode?: "preview" | "source";
  onModeChange?(mode: "preview" | "source"): void;
  editorStatus?: FileEditorStatus;
  cursor?: { line: number; column: number };
  vimMode?: string | null;
  conflict?: FileConflictAlertState;
  textContent?: string;
}) {
  const { t } = useTranslation();
  const toast = useToast();

  const handleCopyAll = useCallback(async () => {
    if (textContent === undefined) return;
    try {
      await copyToClipboard(textContent);
      toast.copied();
    } catch {
      toast.error(t("common.errors.unableToCopy"));
    }
  }, [textContent, toast, t]);
  const previewModes = [
    {
      value: "preview" as const,
      label: t("panels.file.editor.preview"),
      testID: "file-mode-preview",
    },
    { value: "source" as const, label: t("panels.file.editor.source"), testID: "file-mode-source" },
  ];
  return (
    <View style={styles.chrome}>
      <PaneContentToolbar testID="file-panel-bar" style={styles.toolbar}>
        <View style={styles.row}>
          <View style={styles.metadata}>
            <Text
              style={styles.whisper}
              accessibilityLabel={t("panels.file.editor.fileSize", { size: formatFileSize(size) })}
            >
              {formatFileSize(size)}
            </Text>
            {lineCount !== undefined ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.lines", { count: lineCount })}
              >
                {t("panels.file.editor.lines", { count: lineCount })}
              </Text>
            ) : null}
          </View>
          <View
            style={styles.status}
            accessibilityLabel={
              editorStatus
                ? t("panels.file.editor.editorStatus", { status: editorStatus })
                : undefined
            }
          >
            {editorStatus === "dirty" ? (
              <View
                style={styles.dirtyDot}
                accessibilityLabel={t("panels.file.editor.unsavedChanges")}
              />
            ) : null}
            {editorStatus === "saving" ? (
              <>
                <ThemedSpinner size={14} uniProps={spinnerMapping} />
                <Text style={styles.secondary}>{t("panels.file.editor.saving")}</Text>
              </>
            ) : null}
            {editorStatus === "error" ? (
              <Text style={styles.error}>{t("panels.file.editor.saveFailed")}</Text>
            ) : null}
            {vimMode ? (
              <Text
                style={styles.vim}
                accessibilityLabel={t("panels.file.editor.vimMode", { mode: vimMode })}
              >
                {vimMode}
              </Text>
            ) : null}
            {cursor ? (
              <Text
                style={styles.whisper}
                accessibilityLabel={t("panels.file.editor.cursor", cursor)}
              >
                Ln {cursor.line}, Col {cursor.column}
              </Text>
            ) : null}
          </View>
          <View style={styles.actions}>
            {mode && onModeChange ? (
              <SegmentedControl
                size="xs"
                value={mode}
                onValueChange={onModeChange}
                testID="file-preview-mode"
                options={previewModes}
              />
            ) : null}
            {textContent !== undefined ? (
              <Button
                size="xs"
                variant="ghost"
                leftIcon={Copy}
                onPress={handleCopyAll}
                testID="file-copy-all"
              >
                {t("panels.file.editor.copyAll")}
              </Button>
            ) : null}
          </View>
        </View>
      </PaneContentToolbar>
      {conflict ? <FileConflictAlert state={conflict} /> : null}
    </View>
  );
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create((theme) => ({
  chrome: {
    flexShrink: 0,
  },
  toolbar: {
    height: "auto",
  },
  row: {
    minHeight: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    flexWrap: "wrap",
    paddingVertical: theme.spacing[1],
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
  },
  actions: {
    maxWidth: "100%",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginLeft: "auto",
  },
  metadata: {
    flexGrow: 1,
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  secondary: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  whisper: { color: theme.colors.foregroundExtraMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.palette.red[300], fontSize: theme.fontSize.sm },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.foregroundExtraMuted,
  },
  status: {
    flexShrink: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  vim: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
