import type { PluginHostProps } from "@getpaseo/plugin/client";
import { useState, useMemo, useCallback, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { FactorySnapshot } from "../shared/contracts.js";
import type { FactoryDataSource, FactorySetupObservationState } from "./observation.js";
import { FactorySetupStatus } from "./setup.js";
import type { FactoryInstallationState } from "./installation.js";

interface OverviewProps extends PluginHostProps {
  source: FactoryDataSource;
  onOpenAgent?: (agentId: string) => void;
  onOpenWorkspace?: (workspaceId: string) => void;
  onRetryObservation?: () => void;
  observationPending?: boolean;
  setupState?: FactorySetupObservationState;
  onRetrySetup?: () => void;
  setupPending?: boolean;
  installation?: FactoryInstallationState;
  onInstall?: () => void;
  ownerControls?: ReactNode;
}

const statusLabels = {
  scheduled: "Scheduled",
  executing: "Executing",
  awaiting_ci: "Awaiting CI",
  failed: "Failed",
  quota_held: "Quota held",
  disconnected: "Disconnected",
  recovery: "Recovery retained",
  idle: "Idle",
  completed: "Completed",
  paused: "Paused",
  unknown: "Unknown",
  pending: "Pending",
  ready: "Ready",
  held: "Held",
  rejected: "Rejected",
};

function Section({
  title,
  children,
  colors,
}: {
  title: string;
  children: ReactNode;
  colors: PluginHostProps["theme"]["colors"];
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        section: { gap: 8 },
        heading: { color: colors.foreground, fontSize: 14, fontWeight: "500" },
        card: { borderColor: colors.border, borderWidth: 1, borderRadius: 8 },
      }),
    [colors],
  );
  return (
    <View style={styles.section}>
      <Text style={styles.heading}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  );
}

function Row({
  title,
  detail,
  status,
  colors,
  onPress,
  selected = false,
}: {
  title: string;
  detail: string | null;
  status: string | null;
  colors: PluginHostProps["theme"]["colors"];
  onPress?: () => void;
  selected?: boolean;
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        row: {
          gap: 6,
          padding: 14,
          minHeight: 52,
          backgroundColor: selected ? colors.surface2 : colors.surface0,
        },
        headline: { flexDirection: "row", gap: 12, alignItems: "flex-start" },
        title: { color: colors.foreground, fontSize: 14, flex: 1 },
        status: { color: colors.foregroundMuted, fontSize: 12 },
        detail: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      }),
    [colors, selected],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const content = (
    <View style={styles.row}>
      <View style={styles.headline}>
        <Text style={styles.title}>{title}</Text>
        {status ? <Text style={styles.status}>{status}</Text> : null}
      </View>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
    </View>
  );
  if (!onPress) return content;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityState={accessibilityState}
      onPress={onPress}
    >
      {content}
    </Pressable>
  );
}

function Coverage({
  value,
  colors,
}: {
  value: FactorySnapshot["coverage"]["issues"];
  colors: PluginHostProps["theme"]["colors"];
}) {
  const styles = useMemo(
    () =>
      StyleSheet.create({
        warning: { color: colors.statusWarning, fontSize: 13, lineHeight: 19, padding: 14 },
      }),
    [colors],
  );
  if (value.complete) return null;
  return <Text style={styles.warning}>Partial coverage. {value.gaps.join(" ")}</Text>;
}

function EvidenceLink({
  title,
  url,
  colors,
}: {
  title: string;
  url: string;
  colors: PluginHostProps["theme"]["colors"];
}) {
  const action = useMutation({ mutationFn: () => Linking.openURL(url) });
  const { mutate } = action;
  const open = useCallback(() => mutate(), [mutate]);
  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: { paddingHorizontal: 14 },
        target: { minHeight: 44, justifyContent: "center" },
        link: { color: colors.accent, fontSize: 13 },
        error: { color: colors.statusDanger, fontSize: 13 },
      }),
    [colors],
  );
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={title}
        disabled={action.isPending}
        onPress={open}
        style={styles.target}
      >
        <Text style={styles.link}>{title}</Text>
      </Pressable>
      {action.isError ? (
        <Text style={styles.error}>Could not open the evidence link. Select it to retry.</Text>
      ) : null}
    </View>
  );
}

function IssueRow({
  issue,
  colors,
  selected,
  onSelect,
}: {
  issue: FactorySnapshot["issues"][number];
  colors: PluginHostProps["theme"]["colors"];
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  const select = useCallback(() => onSelect(issue.id), [onSelect, issue.id]);
  return (
    <Row
      title={`#${issue.number} ${issue.title}`}
      detail={issue.reason}
      status={statusLabels[issue.qualification]}
      colors={colors}
      selected={selected}
      onPress={select}
    />
  );
}

function WorkRow({
  work,
  colors,
  fixture,
  onOpenAgent,
  onOpenWorkspace,
}: {
  work: FactorySnapshot["work"][number];
  colors: PluginHostProps["theme"]["colors"];
  fixture: boolean;
  onOpenAgent: OverviewProps["onOpenAgent"];
  onOpenWorkspace: OverviewProps["onOpenWorkspace"];
}) {
  const navigate = useCallback(() => {
    if (fixture) return;
    if (work.agentId && onOpenAgent) onOpenAgent(work.agentId);
    else if (work.workspaceId && onOpenWorkspace) onOpenWorkspace(work.workspaceId);
  }, [fixture, work.agentId, work.workspaceId, onOpenAgent, onOpenWorkspace]);
  const canOpenAgent = work.agentId !== null && onOpenAgent !== undefined;
  const canOpenWorkspace = work.workspaceId !== null && onOpenWorkspace !== undefined;
  const navigable = !fixture && (canOpenAgent || canOpenWorkspace);
  return (
    <View>
      <Row
        title={work.title}
        detail={work.blocker}
        status={statusLabels[work.phase]}
        colors={colors}
        onPress={navigable ? navigate : undefined}
      />
      {!fixture && work.issueUrl ? (
        <EvidenceLink title="Open issue" url={work.issueUrl} colors={colors} />
      ) : null}
      {!fixture && work.prUrl ? (
        <EvidenceLink title="Open pull request" url={work.prUrl} colors={colors} />
      ) : null}
      {!fixture && work.ciUrl ? (
        <EvidenceLink title="Open required checks" url={work.ciUrl} colors={colors} />
      ) : null}
    </View>
  );
}

function ObservationHeader({
  source,
  colors,
  onRetry,
  pending,
}: {
  source: FactoryDataSource;
  colors: PluginHostProps["theme"]["colors"];
  onRetry: OverviewProps["onRetryObservation"];
  pending: boolean;
}) {
  const { snapshot } = source;
  const observed =
    snapshot.observedAt === null ? "No live observation" : `Observed ${snapshot.observedAt}`;
  const state = source.kind === "retained" ? "Retained" : snapshot.freshness.state;
  const styles = useMemo(
    () =>
      StyleSheet.create({
        header: { gap: 8 },
        title: { color: colors.foreground, fontSize: 18, fontWeight: "500" },
        banner: { padding: 14, gap: 4, backgroundColor: colors.surface1, borderRadius: 8 },
        warning: { color: colors.statusWarning, fontSize: 14, fontWeight: "500" },
        muted: { color: colors.foregroundMuted, fontSize: 13 },
        retry: { minHeight: 44, justifyContent: "center" },
        retryText: { color: colors.accent, fontSize: 13 },
      }),
    [colors],
  );
  return (
    <View style={styles.header}>
      <Text style={styles.title}>Factory overview</Text>
      {source.kind === "fixture" ? (
        <View style={styles.banner}>
          <Text style={styles.warning}>Fixture mode</Text>
          <Text style={styles.muted}>
            Synthetic examples. No live progress is shown and no operations can be started.
          </Text>
        </View>
      ) : null}
      {source.kind === "retained" ? (
        <View style={styles.banner}>
          <Text style={styles.warning}>Observation unavailable</Text>
          <Text style={styles.muted}>
            Showing the last snapshot from this host and project. Current progress and admission
            could not be verified.
          </Text>
          {onRetry ? (
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              disabled={pending}
              style={styles.retry}
            >
              <Text style={styles.retryText}>
                {pending ? "Retrying observation..." : "Retry observation"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <Text style={styles.muted}>{`${state}. ${observed}`}</Text>
      {snapshot.freshness.reason ? (
        <Text style={styles.muted}>{snapshot.freshness.reason}</Text>
      ) : null}
    </View>
  );
}

function installationControls(
  kind: string,
  installation: OverviewProps["installation"],
  onInstall: OverviewProps["onInstall"],
) {
  return kind === "fixture" ? {} : { installation, onInstall };
}

export function FactoryOverview({
  source,
  theme,
  layout,
  onOpenAgent,
  onOpenWorkspace,
  onRetryObservation,
  observationPending = false,
  setupState,
  onRetrySetup,
  setupPending = false,
  installation,
  onInstall,
  ownerControls,
}: OverviewProps) {
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const { snapshot } = source;
  const { colors } = theme;
  const fixture = source.kind === "fixture";
  const issueDetail = snapshot.issues.find((issue) => issue.id === selectedIssue);
  const number = new Intl.NumberFormat();
  const usage =
    snapshot.account.usagePoints === null ? "Unknown" : number.format(snapshot.account.usagePoints);
  const limit =
    snapshot.account.limitPoints === null ? "Unknown" : number.format(snapshot.account.limitPoints);
  const measured =
    snapshot.account.observedAt === null
      ? "Measurement unavailable"
      : `Measured ${snapshot.account.observedAt}`;
  const workDirection = layout.compact ? "column" : "row";

  const styles = useMemo(
    () =>
      StyleSheet.create({
        scroll: { flex: 1, backgroundColor: colors.surface0 },
        container: {
          padding: layout.compact ? 16 : 24,
          gap: 24,
          maxWidth: 1120,
          width: "100%",
          alignSelf: "center",
        },
        columns: { flexDirection: workDirection, gap: 24 },
        queue: { flex: layout.compact ? undefined : 1, gap: 24 },
        deliveries: { flex: layout.compact ? undefined : 1 },
        notice: { color: colors.foregroundMuted, fontSize: 13, lineHeight: 19 },
      }),
    [colors, layout.compact, workDirection],
  );
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.container}>
      <ObservationHeader
        source={source}
        colors={colors}
        onRetry={onRetryObservation}
        pending={observationPending}
      />

      {setupState ? (
        <FactorySetupStatus
          state={setupState}
          theme={theme}
          onRetry={onRetrySetup}
          pending={setupPending}
          {...installationControls(source.kind, installation, onInstall)}
        />
      ) : null}

      {ownerControls}

      <Section title="Current work and admission" colors={colors}>
        <Row
          title={`Admission: ${snapshot.admission.state}`}
          detail={snapshot.admission.reason}
          status={null}
          colors={colors}
        />
        <Row
          title={`Account usage: ${usage} / ${limit} allowance points`}
          detail={measured}
          status={null}
          colors={colors}
        />
        {snapshot.coordinators.map((coordinator) => {
          let open: (() => void) | undefined;
          if (!fixture && coordinator.agentId && onOpenAgent) {
            const agentId = coordinator.agentId;
            open = () => onOpenAgent(agentId);
          } else if (!fixture && coordinator.workspaceId && onOpenWorkspace) {
            const workspaceId = coordinator.workspaceId;
            open = () => onOpenWorkspace(workspaceId);
          }
          const title =
            coordinator.role === "factory" ? "Factory coordinator" : "Builds coordinator";
          const detail =
            coordinator.workspaceId === null
              ? "Workspace identity unverified"
              : `Workspace ...${coordinator.workspaceId.slice(-8)}`;
          return (
            <Row
              key={coordinator.role}
              title={title}
              detail={detail}
              status={statusLabels[coordinator.status]}
              colors={colors}
              onPress={open}
            />
          );
        })}
      </Section>

      <View style={styles.columns}>
        <View style={styles.queue}>
          <Section title="Issue qualification queue" colors={colors}>
            {snapshot.issues.length === 0 ? (
              <Row
                title="No issues observed"
                detail="Check coverage before treating the queue as empty."
                status={null}
                colors={colors}
              />
            ) : null}
            {snapshot.issues.map((issue) => (
              <IssueRow
                key={issue.id}
                issue={issue}
                colors={colors}
                selected={selectedIssue === issue.id}
                onSelect={setSelectedIssue}
              />
            ))}
            <Coverage value={snapshot.coverage.issues} colors={colors} />
          </Section>
          {issueDetail ? (
            <Section title="Qualification detail" colors={colors}>
              <Row
                title={`#${issueDetail.number} ${issueDetail.title}`}
                detail={issueDetail.reason}
                status={statusLabels[issueDetail.qualification]}
                colors={colors}
              />
              <Row
                title="Admission requires a fresh check"
                detail="Qualification alone does not claim implementation or establish account budget."
                status={null}
                colors={colors}
              />
              {!fixture ? (
                <EvidenceLink title="Open GitHub issue" url={issueDetail.url} colors={colors} />
              ) : null}
            </Section>
          ) : null}
        </View>
        <View style={styles.deliveries}>
          <Section title="Deliveries and CI" colors={colors}>
            {snapshot.work.length === 0 ? (
              <Row title="No work observed" detail={null} status={null} colors={colors} />
            ) : null}
            {snapshot.work.map((work) => (
              <WorkRow
                key={work.id}
                work={work}
                colors={colors}
                fixture={fixture}
                onOpenAgent={onOpenAgent}
                onOpenWorkspace={onOpenWorkspace}
              />
            ))}
            <Coverage value={snapshot.coverage.work} colors={colors} />
          </Section>
        </View>
      </View>

      <Section title="Builds and verified release" colors={colors}>
        {snapshot.builds.active ? (
          <Row
            title={snapshot.builds.active.sourceRef}
            detail="Active build record"
            status={statusLabels[snapshot.builds.active.status]}
            colors={colors}
          />
        ) : (
          <Row title="No active build observed" detail={null} status={null} colors={colors} />
        )}
        {snapshot.builds.pending.map((build) => (
          <Row
            key={build.id}
            title={build.sourceRef}
            detail="Pending build request"
            status={statusLabels[build.status]}
            colors={colors}
          />
        ))}
        {snapshot.builds.latestRelease ? (
          <Row
            title={snapshot.builds.latestRelease.version}
            detail={`Published ${snapshot.builds.latestRelease.publishedAt}. Verified ${snapshot.builds.latestRelease.verifiedAt}.`}
            status="Verified release"
            colors={colors}
          />
        ) : (
          <Row
            title="Verified release unavailable"
            detail="Only verified publication satisfies a build request."
            status={null}
            colors={colors}
          />
        )}
        <Coverage value={snapshot.coverage.builds} colors={colors} />
        {!fixture && snapshot.builds.active?.detailsUrl ? (
          <EvidenceLink
            title="Open build evidence"
            url={snapshot.builds.active.detailsUrl}
            colors={colors}
          />
        ) : null}
        {!fixture && snapshot.builds.latestRelease ? (
          <EvidenceLink
            title="Open verified release"
            url={snapshot.builds.latestRelease.url}
            colors={colors}
          />
        ) : null}
      </Section>

      <Section title="Exceptions" colors={colors}>
        {snapshot.exceptions.length === 0 ? (
          <Row title="No exceptions reported" detail={null} status={null} colors={colors} />
        ) : null}
        {snapshot.exceptions.map((exception) => (
          <Row
            key={exception.id}
            title={exception.title}
            detail={exception.detail}
            status={null}
            colors={colors}
          />
        ))}
      </Section>
      <Text style={styles.notice}>
        Takeover, disable and cleanup require additional reconciled runtime support.
      </Text>
    </ScrollView>
  );
}
