/** @vitest-environment jsdom */
import React, { act, useEffect, useMemo, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PortalHost, PortalProvider, usePortal } from "@gorhom/portal";
import {
  FocusedAgentCards,
  SupportingCardsContext,
  WorkspaceCardsPortal,
} from "./supporting-cards-context";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

const HOST = "workspace-cards";
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Workspace({ focused, children }: { focused: string; children?: ReactNode }) {
  const cards = useMemo(() => ({ agentId: focused, hostName: HOST }), [focused]);
  return (
    <PortalProvider>
      <SupportingCardsContext.Provider value={cards}>
        {children}
        <PortalHost name={HOST} />
      </SupportingCardsContext.Provider>
    </PortalProvider>
  );
}

/** Reproduces an entry the portal transport kept after its source conversation stopped sending it. */
function LeftoverEntry({ agentId }: { agentId: string }) {
  const { addPortal } = usePortal(HOST);
  useEffect(() => {
    addPortal(
      "leftover",
      <FocusedAgentCards agentId={agentId}>
        <span>{agentId} cards</span>
      </FocusedAgentCards>,
    );
  }, [addPortal, agentId]);
  return null;
}

it("shows the focused conversation's cards in the shared column", () => {
  act(() =>
    root.render(
      <Workspace focused="current">
        <WorkspaceCardsPortal hostName={HOST} agentId="current">
          <span>current cards</span>
        </WorkspaceCardsPortal>
      </Workspace>,
    ),
  );
  expect(container.textContent).toBe("current cards");
});

it("hides a leftover entry from another tab", () => {
  act(() =>
    root.render(
      <Workspace focused="current">
        <LeftoverEntry agentId="previous" />
        <WorkspaceCardsPortal hostName={HOST} agentId="current">
          <span>current cards</span>
        </WorkspaceCardsPortal>
      </Workspace>,
    ),
  );
  expect(container.textContent).toBe("current cards");
});

it("hides a conversation's entry as soon as another tab takes focus", () => {
  const tree = (focused: string) => (
    <Workspace focused={focused}>
      <LeftoverEntry agentId="first" />
    </Workspace>
  );
  act(() => root.render(tree("first")));
  expect(container.textContent).toBe("first cards");
  act(() => root.render(tree("second")));
  expect(container.textContent).toBe("");
});
