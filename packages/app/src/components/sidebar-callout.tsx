import { X } from "lucide-react-native";
import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import { Pressable, Text, View, type PressableStateCallbackType } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import { useTranslation } from "react-i18next";

const DismissIcon = withUnistyles(X);
const normalIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const hoveredIcon = (theme: Theme) => ({ color: theme.colors.foreground });

const FloatingCalloutContext = createContext(false);
export function FloatingCalloutPresentation({ children }: { children: ReactNode }) {
  return <FloatingCalloutContext.Provider value={true}>{children}</FloatingCalloutContext.Provider>;
}

export type SidebarCalloutActionVariant = "primary" | "secondary";

export interface SidebarCalloutAction {
  label: string;
  onPress: () => void;
  variant?: SidebarCalloutActionVariant;
  disabled?: boolean;
  testID?: string;
}

export type SidebarCalloutVariant = "default" | "success" | "error";

export interface SidebarCalloutProps {
  title?: string;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: SidebarCalloutVariant;
  showTopBorder?: boolean;
  actions?: readonly SidebarCalloutAction[];
  onDismiss?: () => void;
  testID?: string;
}

export function SidebarCalloutDescriptionText({ children }: { children: ReactNode }) {
  return <Text style={styles.description}>{children}</Text>;
}

export function SidebarCallout({
  title,
  description,
  icon,
  variant = "default",
  showTopBorder = true,
  actions,
  onDismiss,
  testID,
}: SidebarCalloutProps) {
  const { t } = useTranslation();
  const floating = useContext(FloatingCalloutContext);
  const visibleActions = (actions ?? []).slice(0, 2);
  const hasHeader = title != null || icon != null;

  const containerStyle = useMemo(
    () => [
      styles.container,
      variant === "error" ? styles.containerError : null,
      !showTopBorder ? styles.withoutTopBorder : null,
      floating ? styles.floatingContainer : null,
      floating && variant === "error" ? styles.floatingError : null,
    ],
    [variant, showTopBorder, floating],
  );

  return (
    <View style={containerStyle} testID={testID} accessibilityRole="alert">
      <View style={[styles.body, floating && styles.floatingBody]}>
        {hasHeader || onDismiss ? (
          <View style={styles.topRow}>
            {hasHeader ? (
              <View style={styles.header}>
                {icon ? <View style={styles.iconSlot}>{icon}</View> : null}
                {title ? (
                  <Text style={styles.title} numberOfLines={2}>
                    {title}
                  </Text>
                ) : null}
              </View>
            ) : null}
            {onDismiss ? (
              <Pressable
                onPress={onDismiss}
                hitSlop={8}
                style={[styles.dismissButton, floating && styles.floatingDismissButton]}
                testID={testID ? `${testID}-dismiss` : undefined}
                accessibilityLabel={t("sidebarCallout.dismiss")}
                accessibilityRole="button"
              >
                {({ hovered }) => (
                  <DismissIcon size={14} uniProps={hovered ? hoveredIcon : normalIcon} />
                )}
              </Pressable>
            ) : null}
          </View>
        ) : null}

        <CalloutContent description={description} actions={visibleActions} testID={testID} />
      </View>
    </View>
  );
}

function CalloutContent({
  description,
  actions,
  testID,
}: Pick<SidebarCalloutProps, "description" | "testID"> & {
  actions: readonly SidebarCalloutAction[];
}) {
  const floating = useContext(FloatingCalloutContext);
  const hasDescription = description != null && description !== "";
  const inlineAction = floating && typeof description === "string" && actions.length === 1;
  return (
    <View style={inlineAction ? styles.inlineContent : styles.body}>
      {hasDescription && typeof description === "string" ? (
        <View style={inlineAction && styles.inlineDescription}>
          <SidebarCalloutDescriptionText>{description}</SidebarCalloutDescriptionText>
        </View>
      ) : null}
      {hasDescription && typeof description !== "string" ? (
        <View style={styles.descriptionSlot}>{description}</View>
      ) : null}

      {actions.length > 0 ? (
        <View
          style={[styles.actionRow, inlineAction && styles.inlineActions]}
          testID={testID ? `${testID}-actions` : undefined}
        >
          {actions.map((action, index) => (
            <SidebarCalloutActionButton
              key={action.label}
              action={action}
              testID={action.testID ?? (testID ? `${testID}-action-${index}` : undefined)}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function SidebarCalloutActionButton({
  action,
  testID,
}: {
  action: SidebarCalloutAction;
  testID?: string;
}) {
  const isPrimary = action.variant === "primary";
  const labelStyle = useMemo(
    () => [styles.actionLabel, isPrimary ? styles.actionLabelPrimary : styles.actionLabelSecondary],
    [isPrimary],
  );
  const pressableStyle = useCallback(
    ({ pressed }: PressableStateCallbackType) => [
      styles.actionButton,
      isPrimary ? styles.actionButtonPrimary : styles.actionButtonSecondary,
      pressed ? styles.actionButtonPressed : null,
      action.disabled ? styles.actionButtonDisabled : null,
    ],
    [action.disabled, isPrimary],
  );
  return (
    <Pressable
      onPress={action.onPress}
      disabled={action.disabled}
      testID={testID}
      accessibilityRole="button"
      style={pressableStyle}
    >
      <Text style={labelStyle} numberOfLines={1}>
        {action.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  floatingContainer: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.borderAccent,
    borderRadius: 12,
    marginBottom: 8,
    ...theme.shadow.md,
  },
  floatingError: { borderColor: theme.colors.destructive },
  container: {
    flexShrink: 0,
    width: "100%",
    paddingVertical: theme.spacing[4],
    paddingHorizontal: theme.spacing[4],
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    gap: theme.spacing[2],
  },
  withoutTopBorder: {
    borderTopWidth: 0,
  },
  containerError: {
    borderTopColor: theme.colors.destructive,
  },
  dismissButton: {
    width: 14,
    height: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  floatingDismissButton: { width: 32, height: 32 },
  body: {
    gap: theme.spacing[2],
  },
  floatingBody: { gap: theme.spacing[1] },
  inlineContent: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inlineDescription: { flexGrow: 1, flexShrink: 1, flexBasis: 120 },
  inlineActions: { marginLeft: "auto" },
  topRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  header: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  iconSlot: {
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    flexShrink: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  descriptionSlot: {
    flexShrink: 1,
    minWidth: 0,
    gap: theme.spacing[2],
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    justifyContent: "flex-end",
    alignItems: "center",
  },
  actionButton: {
    minHeight: 44,
    maxWidth: "100%",
    flexShrink: 0,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    alignItems: "center",
    justifyContent: "center",
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.foreground,
    borderColor: theme.colors.foreground,
  },
  actionButtonSecondary: {
    backgroundColor: "transparent",
    borderColor: theme.colors.border,
  },
  actionButtonPressed: {
    opacity: 0.8,
  },
  actionButtonDisabled: {
    opacity: 0.5,
  },
  actionLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  actionLabelPrimary: {
    color: theme.colors.surface0,
  },
  actionLabelSecondary: {
    color: theme.colors.foreground,
  },
}));
