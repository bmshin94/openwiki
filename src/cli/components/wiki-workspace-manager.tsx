import { randomUUID } from "node:crypto";
import React, { useMemo, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type {
  DiscoveredWiki,
  WikiWorkspaceDraft,
} from "../../linking/wiki-workspaces.js";

/**
 * Properties accepted by the interactive wiki-workspace manager.
 */
export interface WikiWorkspaceManagerProps {
  /**
   * Complete persisted workspace collection when the manager opens.
   */
  initialWorkspaces: readonly WikiWorkspaceDraft[];

  /**
   * Repository wikis found below the initial discovery directory.
   */
  initialCandidates: readonly DiscoveredWiki[];

  /**
   * Resolves an additional direct repository or directory location.
   */
  discoverLocation: (location: string) => Promise<DiscoveredWiki[]>;

  /**
   * Receives the complete final workspace collection on Finish.
   */
  onSubmit: (workspaces: WikiWorkspaceDraft[]) => void;

  /**
   * Records an explicit Ctrl-C cancellation before exit.
   */
  onCancel: () => void;
}

/**
 * Manager-only workspace with a stable React list key.
 */
interface ManagedWorkspace extends WikiWorkspaceDraft {
  /**
   * Stable existing ID or temporary local identity.
   */
  key: string;
}

/**
 * Top-level saved-workspace list screen.
 */
interface WorkspaceListScreen {
  /**
   * Screen discriminator.
   */
  kind: "workspaces";
}

/**
 * Action menu for one selected workspace.
 */
interface WorkspaceActionsScreen {
  /**
   * Screen discriminator.
   */
  kind: "actions";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Exact wiki-membership editor for one workspace.
 */
interface WorkspaceEditScreen {
  /**
   * Screen discriminator.
   */
  kind: "edit";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Destructive confirmation screen for one workspace.
 */
interface WorkspaceDeleteScreen {
  /**
   * Screen discriminator.
   */
  kind: "delete";

  /**
   * Manager identity of the selected workspace.
   */
  workspaceKey: string;
}

/**
 * Workspace creation or rename text-entry screen.
 */
interface WorkspaceNameScreen {
  /**
   * Screen discriminator.
   */
  kind: "name";

  /**
   * Whether the submitted name creates or renames a workspace.
   */
  mode: "create" | "rename";

  /**
   * Existing workspace identity required by rename mode.
   */
  workspaceKey?: string;
}

/**
 * Additional repository or directory text-entry screen.
 */
interface WorkspaceLocationScreen {
  /**
   * Screen discriminator.
   */
  kind: "location";

  /**
   * Manager identity of the workspace receiving candidates.
   */
  workspaceKey: string;
}

/**
 * Complete top-level workspace-manager screen state.
 */
type ManagerScreen =
  | WorkspaceListScreen
  | WorkspaceActionsScreen
  | WorkspaceEditScreen
  | WorkspaceDeleteScreen
  | WorkspaceNameScreen
  | WorkspaceLocationScreen;

/**
 * One selectable row in the workspace member editor.
 */
interface EditorRow {
  /**
   * Row behavior discriminator.
   */
  kind: "candidate" | "add" | "save" | "back";

  /**
   * Repository candidate associated with a candidate row.
   */
  candidate?: DiscoveredWiki;
}

/**
 * Interactive manager used by `openwiki link`.
 *
 * @param props - Initial state, discovery callback, and completion callbacks.
 * @returns Ink workspace manager view.
 */
export function WikiWorkspaceManager({
  initialWorkspaces,
  initialCandidates,
  discoverLocation,
  onSubmit,
  onCancel,
}: WikiWorkspaceManagerProps): React.JSX.Element {
  const { exit } = useApp();
  const [workspaces, setWorkspaces] = useState<ManagedWorkspace[]>(() =>
    initialWorkspaces.map((workspace) => ({
      ...workspace,
      roots: [...workspace.roots],
      key: workspace.id ?? temporaryWorkspaceKey(),
    })),
  );
  const [candidates, setCandidates] = useState<DiscoveredWiki[]>(() =>
    mergeCandidates(initialCandidates, workspaceCandidates(initialWorkspaces)),
  );
  const [screen, setScreen] = useState<ManagerScreen>({ kind: "workspaces" });
  const [cursor, setCursor] = useState(0);
  const [input, setInput] = useState("");
  const [editRoots, setEditRoots] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selectedWorkspace =
    "workspaceKey" in screen
      ? workspaces.find((workspace) => workspace.key === screen.workspaceKey)
      : undefined;
  const editorRows = useMemo<EditorRow[]>(
    () => [
      ...candidates.map((candidate) => ({
        kind: "candidate" as const,
        candidate,
      })),
      { kind: "add" },
      { kind: "save" },
      { kind: "back" },
    ],
    [candidates],
  );

  /**
   * Returns to a screen with reset navigation feedback.
   *
   * @param next - Destination manager screen.
   */
  function navigate(next: ManagerScreen): void {
    setScreen(next);
    setCursor(0);
    setInput("");
    setMessage(null);
  }

  /**
   * Opens the member editor with an isolated selection draft.
   *
   * @param workspace - Workspace whose exact membership should be edited.
   */
  function beginEditing(workspace: ManagedWorkspace): void {
    setEditRoots(new Set(workspace.roots));
    navigate({ kind: "edit", workspaceKey: workspace.key });
  }

  /**
   * Completes workspace creation or rename from the current text input.
   */
  function submitName(): void {
    const name = input.trim();
    if (!validWorkspaceName(name)) {
      setMessage("Enter a workspace name of 80 characters or fewer.");
      return;
    }
    const duplicate = workspaces.some(
      (workspace) =>
        workspace.key !== screenWorkspaceKey(screen) &&
        workspace.name.toLowerCase() === name.toLowerCase(),
    );
    if (duplicate) {
      setMessage("Workspace names must be unique.");
      return;
    }

    if (
      screen.kind === "name" &&
      screen.mode === "rename" &&
      screen.workspaceKey
    ) {
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.key === screen.workspaceKey
            ? { ...workspace, name }
            : workspace,
        ),
      );
      navigate({ kind: "actions", workspaceKey: screen.workspaceKey });
      return;
    }

    const key = temporaryWorkspaceKey();
    const workspace: ManagedWorkspace = { key, name, roots: [] };
    setWorkspaces((current) => [...current, workspace]);
    setEditRoots(new Set());
    navigate({ kind: "edit", workspaceKey: key });
  }

  /**
   * Resolves and adds candidates from the current location input.
   */
  async function submitLocation(): Promise<void> {
    if (screen.kind !== "location" || busy) return;
    const location = input.trim();
    if (!location) {
      setMessage("Enter a repository or directory path.");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const found = await discoverLocation(location);
      if (found.length === 0) {
        setMessage("No repository wikis were found at that location.");
        return;
      }
      setCandidates((current) => mergeCandidates(current, found));
      if (found.length === 1) {
        setEditRoots((current) => new Set([...current, found[0].root]));
      }
      navigate({ kind: "edit", workspaceKey: screen.workspaceKey });
      setMessage(
        found.length === 1
          ? `Added ${found[0].name}.`
          : `Found ${found.length} wikis. Select the ones to include.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Unable to inspect that location.",
      );
    } finally {
      setBusy(false);
    }
  }

  useInput((inputValue, key) => {
    if (busy) return;
    if (key.ctrl && inputValue === "c") {
      onCancel();
      exit();
      return;
    }

    if (screen.kind === "name" || screen.kind === "location") {
      if (key.escape) {
        if (screen.kind === "location") {
          navigate({ kind: "edit", workspaceKey: screen.workspaceKey });
        } else if (screen.mode === "rename" && screen.workspaceKey) {
          navigate({ kind: "actions", workspaceKey: screen.workspaceKey });
        } else {
          navigate({ kind: "workspaces" });
        }
        return;
      }
      if (key.return) {
        if (screen.kind === "name") submitName();
        else void submitLocation();
        return;
      }
      if (key.backspace || key.delete) {
        setInput((current) => current.slice(0, -1));
        setMessage(null);
        return;
      }
      if (!key.ctrl && !key.meta) {
        const printable = printableInput(inputValue);
        if (printable) {
          setInput((current) => `${current}${printable}`.slice(0, 2_000));
          setMessage(null);
        }
      }
      return;
    }

    const rowCount = managerRowCount(screen, workspaces, editorRows);
    if (key.upArrow || inputValue === "k") {
      setCursor((current) => wrapIndex(current - 1, rowCount));
      setMessage(null);
      return;
    }
    if (key.downArrow || inputValue === "j") {
      setCursor((current) => wrapIndex(current + 1, rowCount));
      setMessage(null);
      return;
    }

    if (screen.kind === "edit" && inputValue === " ") {
      const row = editorRows[cursor];
      if (row?.kind === "candidate" && row.candidate) {
        setEditRoots((current) =>
          toggleSelection(current, row.candidate!.root),
        );
        setMessage(null);
      }
      return;
    }
    if (!key.return) return;

    if (screen.kind === "workspaces") {
      if (cursor < workspaces.length) {
        navigate({ kind: "actions", workspaceKey: workspaces[cursor].key });
      } else if (cursor === workspaces.length) {
        navigate({ kind: "name", mode: "create" });
      } else {
        onSubmit(workspaces.map(managerDraft));
        exit();
      }
      return;
    }

    if (!selectedWorkspace) {
      navigate({ kind: "workspaces" });
      return;
    }
    if (screen.kind === "actions") {
      if (cursor === 0) beginEditing(selectedWorkspace);
      else if (cursor === 1) {
        setInput(selectedWorkspace.name);
        setScreen({
          kind: "name",
          mode: "rename",
          workspaceKey: selectedWorkspace.key,
        });
        setCursor(0);
        setMessage(null);
      } else if (cursor === 2) {
        navigate({ kind: "delete", workspaceKey: selectedWorkspace.key });
      } else navigate({ kind: "workspaces" });
      return;
    }
    if (screen.kind === "delete") {
      if (cursor === 0) {
        setWorkspaces((current) =>
          current.filter(
            (workspace) => workspace.key !== selectedWorkspace.key,
          ),
        );
        navigate({ kind: "workspaces" });
      } else navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
      return;
    }
    if (screen.kind === "edit") {
      const row = editorRows[cursor];
      if (row?.kind === "candidate" && row.candidate) {
        setEditRoots((current) =>
          toggleSelection(current, row.candidate!.root),
        );
      } else if (row?.kind === "add") {
        navigate({ kind: "location", workspaceKey: selectedWorkspace.key });
      } else if (row?.kind === "save") {
        if (editRoots.size < 2) {
          setMessage("Select at least two repository wikis.");
          return;
        }
        setWorkspaces((current) =>
          current.map((workspace) =>
            workspace.key === selectedWorkspace.key
              ? { ...workspace, roots: [...editRoots] }
              : workspace,
          ),
        );
        navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
      } else if (row?.kind === "back") {
        if (selectedWorkspace.roots.length === 0 && !selectedWorkspace.id) {
          setWorkspaces((current) =>
            current.filter(
              (workspace) => workspace.key !== selectedWorkspace.key,
            ),
          );
          navigate({ kind: "workspaces" });
        } else {
          navigate({ kind: "actions", workspaceKey: selectedWorkspace.key });
        }
      }
    }
  });

  return (
    <Box flexDirection="column">
      <Text bold>Wiki workspaces</Text>
      {screen.kind === "workspaces" ? (
        <WorkspaceList workspaces={workspaces} cursor={cursor} />
      ) : null}
      {screen.kind === "actions" && selectedWorkspace ? (
        <WorkspaceActions workspace={selectedWorkspace} cursor={cursor} />
      ) : null}
      {screen.kind === "edit" && selectedWorkspace ? (
        <WorkspaceEditor
          workspace={selectedWorkspace}
          rows={editorRows}
          selectedRoots={editRoots}
          cursor={cursor}
        />
      ) : null}
      {screen.kind === "delete" && selectedWorkspace ? (
        <DeleteConfirmation workspace={selectedWorkspace} cursor={cursor} />
      ) : null}
      {screen.kind === "name" ? (
        <TextEntry
          label={
            screen.mode === "create" ? "Workspace name" : "Rename workspace"
          }
          value={input}
        />
      ) : null}
      {screen.kind === "location" ? (
        <TextEntry
          label="Repository or directory path"
          value={input}
          busy={busy}
        />
      ) : null}
      {message ? <Text color="yellow">{message}</Text> : null}
      <Box marginTop={1}>
        <Text dimColor>{footerForScreen(screen)}</Text>
      </Box>
    </Box>
  );
}

/**
 * Properties accepted by the top-level workspace list.
 */
interface WorkspaceListProps {
  /**
   * Current manager workspaces.
   */
  workspaces: readonly ManagedWorkspace[];

  /**
   * Selected row index.
   */
  cursor: number;
}

/**
 * Renders existing workspaces plus Create and Finish actions.
 *
 * @param props - Workspaces and selected row.
 * @returns Ink list view.
 */
function WorkspaceList({
  workspaces,
  cursor,
}: WorkspaceListProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      {workspaces.map((workspace, index) => (
        <MenuText key={workspace.key} active={cursor === index}>
          {workspace.name} <Text dimColor>{workspace.roots.length} wikis</Text>
        </MenuText>
      ))}
      <MenuText active={cursor === workspaces.length}>
        Create workspace
      </MenuText>
      <MenuText active={cursor === workspaces.length + 1}>Finish</MenuText>
    </Box>
  );
}

/**
 * Properties accepted by the workspace action menu.
 */
interface WorkspaceActionsProps {
  /**
   * Selected workspace.
   */
  workspace: ManagedWorkspace;

  /**
   * Selected action index.
   */
  cursor: number;
}

/**
 * Renders edit, rename, delete, and back actions for one workspace.
 *
 * @param props - Selected workspace and action row.
 * @returns Ink action view.
 */
function WorkspaceActions({
  workspace,
  cursor,
}: WorkspaceActionsProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{workspace.name}</Text>
      {["Edit wikis", "Rename", "Delete", "Back"].map((label, index) => (
        <MenuText key={label} active={cursor === index}>
          {label}
        </MenuText>
      ))}
    </Box>
  );
}

/**
 * Properties accepted by the workspace member editor.
 */
interface WorkspaceEditorProps {
  /**
   * Workspace being edited.
   */
  workspace: ManagedWorkspace;

  /**
   * Candidate and action rows.
   */
  rows: readonly EditorRow[];

  /**
   * Canonical repository roots currently selected.
   */
  selectedRoots: ReadonlySet<string>;

  /**
   * Selected editor row.
   */
  cursor: number;
}

/**
 * Renders repository membership selection and editor actions.
 *
 * @param props - Workspace, rows, selection, and cursor.
 * @returns Ink editor view.
 */
function WorkspaceEditor({
  workspace,
  rows,
  selectedRoots,
  cursor,
}: WorkspaceEditorProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{workspace.name}</Text>
      <Text dimColor>Select the wikis that should be searched together.</Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, index) => {
          if (row.kind === "candidate" && row.candidate) {
            return (
              <MenuText key={row.candidate.root} active={cursor === index}>
                [{selectedRoots.has(row.candidate.root) ? "x" : " "}]{" "}
                {row.candidate.name} <Text dimColor>{row.candidate.path}</Text>
              </MenuText>
            );
          }
          return (
            <MenuText key={row.kind} active={cursor === index}>
              {editorActionLabel(row.kind)}
            </MenuText>
          );
        })}
      </Box>
    </Box>
  );
}

/**
 * Properties accepted by the delete confirmation view.
 */
interface DeleteConfirmationProps {
  /**
   * Workspace pending deletion.
   */
  workspace: ManagedWorkspace;

  /**
   * Selected confirmation row.
   */
  cursor: number;
}

/**
 * Renders an explicit destructive workspace-deletion confirmation.
 *
 * @param props - Workspace and confirmation row.
 * @returns Ink confirmation view.
 */
function DeleteConfirmation({
  workspace,
  cursor,
}: DeleteConfirmationProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Delete {workspace.name}?</Text>
      <Text dimColor>The repository wikis themselves are not changed.</Text>
      <MenuText active={cursor === 0}>Delete workspace</MenuText>
      <MenuText active={cursor === 1}>Cancel</MenuText>
    </Box>
  );
}

/**
 * Properties accepted by one raw text-entry view.
 */
interface TextEntryProps {
  /**
   * Prompt label.
   */
  label: string;

  /**
   * Current plain-text value.
   */
  value: string;

  /**
   * Whether asynchronous validation is running.
   */
  busy?: boolean;
}

/**
 * Renders one simple terminal text field.
 *
 * @param props - Prompt label, value, and busy state.
 * @returns Ink text-entry view.
 */
function TextEntry({
  label,
  value,
  busy = false,
}: TextEntryProps): React.JSX.Element {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{label}</Text>
      <Text color="cyan">
        › {value}
        {busy ? "…" : "_"}
      </Text>
    </Box>
  );
}

/**
 * Properties accepted by one consistently styled menu row.
 */
interface MenuTextProps {
  /**
   * Whether the row owns the cursor.
   */
  active: boolean;

  /**
   * Row content.
   */
  children: React.ReactNode;
}

/**
 * Renders one menu row with the shared cursor treatment.
 *
 * @param props - Active state and row content.
 * @returns Ink menu row.
 */
function MenuText({ active, children }: MenuTextProps): React.JSX.Element {
  return (
    <Text color={active ? "cyan" : undefined}>
      {active ? "›" : " "} {children}
    </Text>
  );
}

/**
 * Converts manager state back to a persistence draft.
 *
 * @param workspace - Manager-only workspace.
 * @returns Serializable workspace draft.
 */
function managerDraft(workspace: ManagedWorkspace): WikiWorkspaceDraft {
  return {
    ...(workspace.id ? { id: workspace.id } : {}),
    name: workspace.name,
    roots: [...workspace.roots],
  };
}

/**
 * Creates candidates for persisted roots outside initial discovery.
 *
 * @param workspaces - Persisted workspace drafts.
 * @returns Candidate rows for every referenced root.
 */
function workspaceCandidates(
  workspaces: readonly WikiWorkspaceDraft[],
): DiscoveredWiki[] {
  return workspaces.flatMap((workspace) =>
    workspace.roots.map((root) => ({
      root,
      name: root.split(/[\\/]/u).at(-1) ?? root,
      path: root,
    })),
  );
}

/**
 * Deduplicates candidate roots while preserving first-seen display metadata.
 *
 * @param collections - Candidate collections to merge.
 * @returns Deterministically ordered unique candidates.
 */
function mergeCandidates(
  ...collections: readonly (readonly DiscoveredWiki[])[]
): DiscoveredWiki[] {
  const byRoot = new Map<string, DiscoveredWiki>();
  for (const collection of collections) {
    for (const candidate of collection) {
      if (!byRoot.has(candidate.root)) byRoot.set(candidate.root, candidate);
    }
  }
  return [...byRoot.values()].sort(
    (left, right) =>
      left.name.localeCompare(right.name) ||
      left.root.localeCompare(right.root),
  );
}

/**
 * Returns the number of selectable rows for the active menu screen.
 *
 * @param screen - Current manager screen.
 * @param workspaces - Current workspaces.
 * @param editorRows - Current editor rows.
 * @returns Positive row count.
 */
function managerRowCount(
  screen: ManagerScreen,
  workspaces: readonly ManagedWorkspace[],
  editorRows: readonly EditorRow[],
): number {
  if (screen.kind === "workspaces") return workspaces.length + 2;
  if (screen.kind === "actions") return 4;
  if (screen.kind === "delete") return 2;
  if (screen.kind === "edit") return editorRows.length;
  return 1;
}

/**
 * Returns the addressed workspace key when a screen carries one.
 *
 * @param screen - Current manager screen.
 * @returns Workspace key or `undefined`.
 */
function screenWorkspaceKey(screen: ManagerScreen): string | undefined {
  return "workspaceKey" in screen ? screen.workspaceKey : undefined;
}

/**
 * Converts one editor action discriminator to its visible label.
 *
 * @param kind - Editor row behavior.
 * @returns Human-readable action label.
 */
function editorActionLabel(kind: EditorRow["kind"]): string {
  if (kind === "add") return "Add repository or directory";
  if (kind === "save") return "Save workspace";
  if (kind === "back") return "Back";
  return "";
}

/**
 * Returns concise keyboard guidance for one manager screen.
 *
 * @param screen - Current manager screen.
 * @returns Footer text.
 */
function footerForScreen(screen: ManagerScreen): string {
  if (screen.kind === "name" || screen.kind === "location") {
    return "Enter confirm · Esc back · Ctrl-C cancel";
  }
  if (screen.kind === "edit") {
    return "↑/↓ move · Space select · Enter choose · Ctrl-C cancel";
  }
  return "↑/↓ move · Enter choose · Ctrl-C cancel";
}

/**
 * Toggles one canonical repository root without mutating React state.
 *
 * @param current - Current selected root set.
 * @param root - Canonical root to add or remove.
 * @returns New selected root set.
 */
function toggleSelection(
  current: ReadonlySet<string>,
  root: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(root)) next.delete(root);
  else next.add(root);
  return next;
}

/**
 * Wraps one cursor index around a non-empty list.
 *
 * @param index - Proposed cursor index.
 * @param length - Candidate row count.
 * @returns Valid wrapped index.
 */
function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return (index + length) % length;
}

/**
 * Removes terminal control characters from one raw input chunk.
 *
 * @param value - Raw Ink input text.
 * @returns Printable terminal-safe text.
 */
function printableInput(value: string): string {
  return [...value]
    .filter((character) => character >= " " && character !== "\u007f")
    .join("");
}

/**
 * Validates one workspace name before it reaches persistence.
 *
 * @param value - Trimmed workspace name.
 * @returns Whether the name is non-empty, printable, and bounded.
 */
function validWorkspaceName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    [...value].every((character) => character >= " " && character !== "\u007f")
  );
}

/**
 * Creates a collision-resistant key used only during one manager session.
 *
 * @returns Temporary React identity.
 */
function temporaryWorkspaceKey(): string {
  return `draft-${randomUUID()}`;
}
