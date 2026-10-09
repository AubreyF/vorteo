import { TaskCardIcon } from "@/agent-stream/task-card-icon";
import { TaskCard, TaskCardHeader } from "@/agent-stream/task-card";
import { CardDisclosure } from "@/agent-stream/card-disclosure";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { type ASTNode } from "react-native-markdown-display";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { getMarkdownListMarker } from "@/utils/markdown-list";
import { createMarkdownParser } from "@/utils/markdown-parser";

// Without this prop react-native-markdown-display builds its own parser with
// `typographer: true`, which would render a plan's literal `(c)` as ©. Its
// default also leaves linkify off, so this one keeps bare URLs as plain text.
const planMarkdownParser = createMarkdownParser({ linkify: false });

type MarkdownRuleStyles = Record<string, TextStyle & ViewStyle & { [key: string]: unknown }>;

function MarkdownInlineText({
  inheritedStyle,
  ruleStyle,
  children,
}: {
  inheritedStyle: StyleProp<TextStyle>;
  ruleStyle: StyleProp<TextStyle>;
  children: ReactNode;
}) {
  const style = useMemo(() => [inheritedStyle, ruleStyle], [inheritedStyle, ruleStyle]);
  return <Text style={style}>{children}</Text>;
}

function MarkdownListItemContent({
  contentStyle,
  children,
}: {
  contentStyle: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const style = useMemo(() => [contentStyle, LIST_ITEM_CONTENT_INNER], [contentStyle]);
  return <View style={style}>{children}</View>;
}

function MarkdownParagraph({
  paragraphStyle,
  isLastChild,
  children,
}: {
  paragraphStyle: StyleProp<ViewStyle>;
  isLastChild: boolean;
  children: ReactNode;
}) {
  const style = useMemo<StyleProp<ViewStyle>>(
    () => [paragraphStyle, isLastChild ? PARAGRAPH_LAST_CHILD : null],
    [paragraphStyle, isLastChild],
  );
  return <View style={style}>{children}</View>;
}

function createPlanMarkdownRules() {
  return {
    text: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText key={node.key} inheritedStyle={inheritedStyles} ruleStyle={styles.text}>
        {node.content}
      </MarkdownInlineText>
    ),
    textgroup: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.textgroup}
      >
        {children}
      </MarkdownInlineText>
    ),
    code_block: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_block}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    fence: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText key={node.key} inheritedStyle={inheritedStyles} ruleStyle={styles.fence}>
        {node.content}
      </MarkdownInlineText>
    ),
    code_inline: (
      node: ASTNode,
      _children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
      inheritedStyles: TextStyle = {},
    ) => (
      <MarkdownInlineText
        key={node.key}
        inheritedStyle={inheritedStyles}
        ruleStyle={styles.code_inline}
      >
        {node.content}
      </MarkdownInlineText>
    ),
    bullet_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.bullet_list}>
        {children}
      </View>
    ),
    ordered_list: (
      node: ASTNode,
      children: ReactNode[],
      _parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => (
      <View key={node.key} style={styles.ordered_list}>
        {children}
      </View>
    ),
    list_item: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const { isOrdered, marker } = getMarkdownListMarker(node, parent);
      const iconStyle = isOrdered ? styles.ordered_list_icon : styles.bullet_list_icon;
      const contentStyle = isOrdered ? styles.ordered_list_content : styles.bullet_list_content;

      return (
        <View key={node.key} style={styles.list_item}>
          <Text style={iconStyle}>{marker}</Text>
          <MarkdownListItemContent contentStyle={contentStyle}>{children}</MarkdownListItemContent>
        </View>
      );
    },
    paragraph: (
      node: ASTNode,
      children: ReactNode[],
      parent: ASTNode[],
      styles: MarkdownRuleStyles,
    ) => {
      const isLastChild = parent[0]?.children?.at(-1)?.key === node.key;
      return (
        <MarkdownParagraph
          key={node.key}
          paragraphStyle={styles.paragraph}
          isLastChild={isLastChild}
        >
          {children}
        </MarkdownParagraph>
      );
    },
  };
}

export type PlanOutcome = "pending" | "approved" | "rejected" | "canceled";

interface PlanCardProps {
  title?: string;
  description?: string;
  text: string;
  outcome?: PlanOutcome;
  footer?: ReactNode;
  disableOuterSpacing?: boolean;
  testID?: string;
}

const markdownRules = createPlanMarkdownRules();

export function PlanCard(props: PlanCardProps) {
  // A resolution starts its own presentation state; subsequent taps stay local.
  return <PlanCardContent key={props.outcome ?? "proposed"} {...props} />;
}

function PlanCardContent({
  title,
  description,
  text,
  outcome,
  footer,
  disableOuterSpacing = false,
  testID,
}: PlanCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(outcome !== "rejected" && outcome !== "canceled");
  const labels = {
    pending: title ?? t("agentStream.permission.plan"),
    rejected: t("agentStream.permission.rejectedPlan"),
    approved: t("agentStream.permission.approvedPlan"),
    canceled: t("agentStream.permission.canceledPlan"),
  };
  const resolvedTitle = labels[outcome ?? "pending"];
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  return (
    <TaskCard
      testID={testID}
      bodyVisible={expanded || !!footer}
      style={!disableOuterSpacing && styles.outerSpacing}
    >
      <TaskCardHeader>
        <TaskCardIcon kind="plan" />
        <CardDisclosure
          title={resolvedTitle}
          expanded={expanded}
          onPress={toggleExpanded}
          testID={`${testID ?? "plan-card"}-toggle`}
        />
      </TaskCardHeader>

      {expanded ? (
        <View style={styles.body}>
          {description ? <Text style={styles.description}>{description}</Text> : null}
          <MarkdownRenderer text={text} rules={markdownRules} markdownit={planMarkdownParser} />
        </View>
      ) : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </TaskCard>
  );
}

const styles = StyleSheet.create((theme) => ({
  outerSpacing: { marginVertical: theme.spacing[3] },
  body: { gap: theme.spacing[2] },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    lineHeight: 20,
  },
  footer: {
    gap: theme.spacing[2],
  },
}));

const LIST_ITEM_CONTENT_INNER = { flex: 1, flexShrink: 1, minWidth: 0 };
const PARAGRAPH_LAST_CHILD = { marginBottom: 0 };
