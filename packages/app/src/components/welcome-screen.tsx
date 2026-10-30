import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Link2, ExternalLink, Settings, Plus, Play } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { HostProfile } from "@/types/host-connection";
import { getHostRuntimeStore, isHostRuntimeConnected, useHosts } from "@/runtime/host-runtime";
import { AddHostModal } from "./add-host-modal";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";
import { enterDemo } from "@/demo/mode";
import { WelcomeRain } from "./welcome-rain";
import { Button } from "@/components/ui/button";
import { resolveAppVersion } from "@/utils/app-version";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { VorteoLogo } from "@/components/icons/paseo-logo";
import { openExternalUrl } from "@/utils/open-external-url";
import { InstallationWelcome } from "@/execution-installation/panel";
import { InstallCommand } from "@/execution-installation/install-command";
import { readExecutionInstallation } from "@/execution-installation/policy";
import { useInstallationName } from "@/execution-installation/installation-name";
import { isNative } from "@/constants/platform";
import { toErrorMessage } from "@/utils/error-messages";
const SETUP_HEADER = { title: "Create New installation" };

interface WelcomeAction {
  key: "new-installation" | "direct-connection";
  label: string;
  testID: string;
  primary: boolean;
  icon: typeof Link2;
  onPress: () => void;
}

const styles = StyleSheet.create((theme) => ({
  root: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scrollView: {
    flex: 1,
  },
  container: {
    flexGrow: 1,
    padding: theme.spacing[6],
    paddingBottom: 0,
    alignItems: "center",
  },
  content: {
    width: "100%",
    flexGrow: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    textAlign: "center",
  },
  subtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  copyBlock: {
    alignItems: "center",
    maxWidth: 420,
    gap: theme.spacing[2],
    marginBottom: theme.spacing[12],
  },
  actions: {
    width: "100%",
    maxWidth: 420,
    gap: theme.spacing[3],
  },
  actionButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actionButtonPrimary: {
    backgroundColor: theme.colors.accent,
    borderColor: theme.colors.accent,
  },
  actionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  actionTextPrimary: {
    color: theme.colors.accentForeground,
  },
  setupLink: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  setupLinkText: {
    color: theme.colors.accent,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  versionLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    marginTop: theme.spacing[6],
  },
  footerActions: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: theme.spacing[1],
    marginTop: theme.spacing[6],
  },
  footerSeparator: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
}));

function useAnyHostOnline(serverIds: string[]): string | null {
  const runtime = getHostRuntimeStore();
  return useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
    () => {
      let firstOnlineServerId: string | null = null;
      let firstOnlineAt: string | null = null;
      for (const serverId of serverIds) {
        const snapshot = runtime.getSnapshot(serverId);
        const lastOnlineAt = snapshot?.lastOnlineAt ?? null;
        if (!isHostRuntimeConnected(snapshot) || !lastOnlineAt) {
          continue;
        }
        if (!firstOnlineAt || lastOnlineAt < firstOnlineAt) {
          firstOnlineAt = lastOnlineAt;
          firstOnlineServerId = serverId;
        }
      }
      return firstOnlineServerId;
    },
  );
}

export interface WelcomeScreenProps {
  onHostAdded?: (profile: HostProfile) => void;
}

export function WelcomeScreen({ onHostAdded }: WelcomeScreenProps) {
  const { theme } = useUnistyles();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const appVersion = resolveAppVersion();
  const appVersionText = formatVersionWithPrefix(appVersion);
  const [isDirectOpen, setIsDirectOpen] = useState(false);
  const [isSetupOpen, setIsSetupOpen] = useState(false);
  const [demoError, setDemoError] = useState<string | null>(null);
  const installation = readExecutionInstallation();
  const installationName = useInstallationName();
  const hosts = useHosts();
  const anyOnlineServerId = useAnyHostOnline(hosts.map((h) => h.serverId));

  useEffect(() => {
    if (!anyOnlineServerId) return;
    router.replace(buildOpenProjectRoute());
  }, [anyOnlineServerId, router]);

  const finishOnboarding = useCallback(() => {
    router.replace(buildOpenProjectRoute());
  }, [router]);

  const handleOpenPaseoSite = useCallback(() => {
    void openExternalUrl("https://paseo.sh");
  }, []);

  const handleOpenSettings = useCallback(() => {
    router.push("/settings");
  }, [router]);

  const handleOpenDirect = useCallback(() => setIsDirectOpen(true), []);
  const handleCloseDirect = useCallback(() => setIsDirectOpen(false), []);
  const handleOpenSetup = useCallback(() => setIsSetupOpen(true), []);
  const handleCloseSetup = useCallback(() => setIsSetupOpen(false), []);
  const handleDemo = useCallback(() => {
    try {
      enterDemo();
    } catch (error) {
      setDemoError(toErrorMessage(error));
    }
  }, []);

  const handleHostSaved = useCallback(
    ({ profile }: { profile: HostProfile; serverId: string }) => {
      onHostAdded?.(profile);
      finishOnboarding();
    },
    [onHostAdded, finishOnboarding],
  );

  // A page served by a running installation shows its owner sign-in inline
  // instead (below): offering to create an installation there is a dead end.
  const actions: WelcomeAction[] = [
    {
      key: "new-installation",
      label: "Create New installation",
      testID: "welcome-create-installation",
      primary: true,
      icon: Plus,
      onPress: handleOpenSetup,
    },
    {
      key: "direct-connection",
      label: "Connect to Host",
      testID: "welcome-direct-connection",
      primary: false,
      icon: Link2,
      onPress: handleOpenDirect,
    },
  ];

  const scrollContentContainerStyle = useMemo(
    () => [styles.container, { paddingBottom: theme.spacing[6] + insets.bottom }],
    [theme.spacing, insets.bottom],
  );

  return (
    <View style={styles.root}>
      <WelcomeRain />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={scrollContentContainerStyle}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        testID="welcome-screen"
      >
        <View style={styles.content}>
          <VorteoLogo size={96} />
          <View style={styles.copyBlock}>
            <Text style={styles.title}>
              {installation ? `Welcome to ${installationName}` : t("onboarding.title")}
            </Text>
            {isNative ? (
              <Pressable style={styles.setupLink} onPress={handleOpenPaseoSite}>
                <Text style={styles.setupLinkText}>paseo.sh</Text>
                <ExternalLink size={14} color={theme.colors.accent} />
              </Pressable>
            ) : null}
          </View>

          <View style={styles.actions}>
            {installation ? (
              <InstallationWelcome />
            ) : (
              actions.map((action) => <WelcomeActionButton key={action.key} action={action} />)
            )}
            {demoError ? (
              <Text accessibilityRole="alert" style={styles.subtitle}>
                {demoError}
              </Text>
            ) : null}
          </View>

          <View style={styles.footerActions}>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Play}
              onPress={handleDemo}
              testID="welcome-demo"
            >
              Demo
            </Button>
            <Text style={styles.footerSeparator} aria-hidden>
              |
            </Text>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={Settings}
              onPress={handleOpenSettings}
              testID="welcome-open-settings"
            >
              {t("onboarding.actions.settings")}
            </Button>
          </View>
        </View>
        <Text style={styles.versionLabel}>{appVersionText}</Text>

        {installation ? null : (
          <AddHostModal
            visible={isDirectOpen}
            onClose={handleCloseDirect}
            onSaved={handleHostSaved}
          />
        )}
        <AdaptiveModalSheet
          visible={isSetupOpen}
          onClose={handleCloseSetup}
          header={SETUP_HEADER}
          testID="create-installation-modal"
        >
          <Text style={styles.subtitle}>
            Run this command on the Mac or Linux computer that will host your installation, or give
            it to your agent. It asks a few questions, then sets up the Host, an optional Dev
            container and optional Tailscale.
          </Text>
          <InstallCommand testID="installation-command" />
          <Text style={styles.subtitle}>
            When it finishes, open the address it prints and sign in with the owner password it
            copies to your clipboard. Every later change happens in the interface.
          </Text>
        </AdaptiveModalSheet>
      </ScrollView>
    </View>
  );
}

interface WelcomeActionButtonProps {
  action: WelcomeAction;
}

function WelcomeActionButton({ action }: WelcomeActionButtonProps) {
  const { theme } = useUnistyles();
  const Icon = action.icon;
  const buttonStyle = useMemo(
    () => [styles.actionButton, action.primary ? styles.actionButtonPrimary : null],
    [action.primary],
  );
  const textStyle = useMemo(
    () => [styles.actionText, action.primary ? styles.actionTextPrimary : null],
    [action.primary],
  );
  return (
    <Pressable
      accessibilityRole="button"
      style={buttonStyle}
      onPress={action.onPress}
      testID={action.testID}
    >
      <Icon
        size={18}
        color={action.primary ? theme.colors.accentForeground : theme.colors.foreground}
      />
      <Text style={textStyle}>{action.label}</Text>
    </Pressable>
  );
}
