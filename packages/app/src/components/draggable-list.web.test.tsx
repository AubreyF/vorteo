/**
 * @vitest-environment jsdom
 */
import React, { memo } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOptimisticReorder } from "./drag-reorder/use-optimistic-reorder";
import type { DraggableListDragHandleProps } from "./draggable-list.types";
import { DraggableList, type DraggableRenderItemInfo } from "./draggable-list.web";

interface Item {
  id: string;
}

const items: Item[] = [{ id: "one" }];

function keyExtractor(item: Item): string {
  return item.id;
}

function onDragEnd() {}

let root: Root | null = null;
let container: HTMLElement | null = null;
let rowRenderCount = 0;

const Row = memo(function Row({
  dragHandleProps: _dragHandleProps,
}: {
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  rowRenderCount += 1;
  return <div>row</div>;
});

function renderRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

function renderReplacementRow(info: DraggableRenderItemInfo<Item>) {
  return <Row dragHandleProps={info.dragHandleProps} />;
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  rowRenderCount = 0;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

describe("DraggableList web row stability", () => {
  it("keeps drag handle props stable when the render callback changes", () => {
    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });
    expect(rowRenderCount).toBe(1);

    act(() => {
      root?.render(
        <DraggableList
          data={items}
          keyExtractor={keyExtractor}
          renderItem={renderReplacementRow}
          onDragEnd={onDragEnd}
          useDragHandle
        />,
      );
    });

    expect(rowRenderCount).toBe(1);
  });
});

describe("asynchronous drop handoff", () => {
  const original = [
    { id: "one", text: "One" },
    { id: "two", text: "Two" },
  ];
  let drop: (items: typeof original) => void;
  function Harness({
    data,
    save,
  }: {
    data: typeof original;
    save: (items: typeof original) => void | Promise<unknown>;
  }) {
    const state = useOptimisticReorder(data, keyExtractor, save);
    drop = state.drop;
    return <div>{state.items.map((item) => item.text).join(",")}</div>;
  }
  function render(
    data: typeof original,
    save: (items: typeof original) => void | Promise<unknown>,
  ) {
    act(() => root?.render(<Harness data={data} save={save} />));
  }

  it("keeps the dropped order through unrelated renders and a response before props", async () => {
    let resolve!: () => void;
    const save = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    render(original, save);
    act(() => drop(original.toReversed()));
    expect(container?.textContent).toBe("Two,One");
    const refreshed = original.map((item) => ({ ...item, text: item.text + " updated" }));
    render(refreshed, save);
    expect(container?.textContent).toBe("Two updated,One updated");
    await act(async () => resolve());
    expect(container?.textContent).toBe("Two updated,One updated");
    render(refreshed.toReversed(), save);
    expect(container?.textContent).toBe("Two updated,One updated");
    // A later remote reorder must not be masked by the acknowledged preview.
    render(refreshed, save);
    expect(container?.textContent).toBe("One updated,Two updated");
  });

  it("rolls a rejected save back to current data", async () => {
    let reject!: (error: Error) => void;
    const save = () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      });
    render(original, save);
    act(() => drop(original.toReversed()));
    expect(container?.textContent).toBe("Two,One");
    await act(async () => reject(new Error("Order conflict")));
    expect(container?.textContent).toBe("One,Two");
  });

  it("accepts remote membership changes while saving", async () => {
    let resolve!: () => void;
    const save = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    render(original, save);
    act(() => drop(original.toReversed()));
    render([original[0]!], save);
    expect(container?.textContent).toBe("One");
    await act(async () => resolve());
    expect(container?.textContent).toBe("One");
  });

  it("does not resurrect a row removed during the gesture", async () => {
    let resolve!: () => void;
    const save = () =>
      new Promise<void>((done) => {
        resolve = done;
      });
    render([original[0]!], save);
    act(() => drop(original.toReversed()));
    expect(container?.textContent).toBe("One");
    await act(async () => resolve());
  });

  it("does not preview rejected gestures or synchronous owners", () => {
    render(original, () => {});
    act(() => drop(original.toReversed()));
    expect(container?.textContent).toBe("One,Two");
  });
});
