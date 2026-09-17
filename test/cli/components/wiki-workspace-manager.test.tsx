import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, test, vi } from "vitest";
import { WikiWorkspaceManager } from "../../../src/cli/components/wiki-workspace-manager.tsx";
import { stripAnsi } from "./ansi.ts";

/**
 * Lets Ink attach or process one input listener.
 *
 * @returns Promise settled on the next event-loop turn.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Sends one or more down-arrow key presses to a rendered manager.
 *
 * @param write - Ink stdin writer.
 * @param count - Number of rows to move.
 */
async function moveDown(
  write: (value: string) => void,
  count: number,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    write("\u001b[B");
    await flush();
  }
}

describe("WikiWorkspaceManager", () => {
  test("creates, names, selects, and finishes one workspace", async () => {
    const onSubmit = vi.fn();
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[]}
        initialCandidates={[
          { root: "/workspace/control", name: "control", path: "control" },
          { root: "/workspace/data", name: "data", path: "data" },
          { root: "/workspace/infra", name: "infra", path: "infra" },
        ]}
        discoverLocation={vi.fn()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    await flush();

    view.stdin.write("\r");
    await flush();
    view.stdin.write("Payments");
    await flush();
    view.stdin.write("\r");
    await flush();
    view.stdin.write(" ");
    await flush();
    await moveDown(view.stdin.write, 1);
    view.stdin.write(" ");
    await flush();
    await moveDown(view.stdin.write, 3);
    view.stdin.write("\r");
    await flush();
    await moveDown(view.stdin.write, 3);
    view.stdin.write("\r");
    await flush();
    await moveDown(view.stdin.write, 2);
    view.stdin.write("\r");
    await flush();

    expect(onSubmit).toHaveBeenCalledWith([
      {
        name: "Payments",
        roots: ["/workspace/control", "/workspace/data"],
      },
    ]);
    view.unmount();
  });

  test("shows clean actions without a plus-prefixed create label", async () => {
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[
          {
            id: "payments",
            name: "Payments",
            roots: ["/workspace/control", "/workspace/data"],
          },
        ]}
        initialCandidates={[]}
        discoverLocation={vi.fn()}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await flush();

    const frame = stripAnsi(view.lastFrame());
    expect(frame).toContain("Payments 2 wikis");
    expect(frame).toContain("Create workspace");
    expect(frame).not.toContain("+ Create workspace");

    view.stdin.write("\r");
    await flush();
    expect(stripAnsi(view.lastFrame())).toContain("Edit wikis");
    expect(stripAnsi(view.lastFrame())).toContain("Rename");
    expect(stripAnsi(view.lastFrame())).toContain("Delete");
    view.unmount();
  });

  test("adds one direct repository path to the current selection", async () => {
    const discoverLocation = vi.fn().mockResolvedValue([
      {
        root: "/elsewhere/infra",
        name: "infra",
        path: "/elsewhere/infra",
      },
    ]);
    const view = render(
      <WikiWorkspaceManager
        initialWorkspaces={[
          {
            id: "payments",
            name: "Payments",
            roots: ["/workspace/control", "/workspace/data"],
          },
        ]}
        initialCandidates={[]}
        discoverLocation={discoverLocation}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    await flush();

    view.stdin.write("\r");
    await flush();
    view.stdin.write("\r");
    await flush();
    await moveDown(view.stdin.write, 2);
    view.stdin.write("\r");
    await flush();
    view.stdin.write("/elsewhere/infra");
    await flush();
    view.stdin.write("\r");
    await flush();
    await flush();

    expect(discoverLocation).toHaveBeenCalledWith("/elsewhere/infra");
    expect(stripAnsi(view.lastFrame())).toContain("[x] infra");
    view.unmount();
  });
});
