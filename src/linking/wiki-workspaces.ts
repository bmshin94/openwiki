import type { Dirent } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveOpenWikiHomeDir } from "../config/openwiki-home.js";
import { writeTextAtomic } from "../integrations/install/atomic-file.js";
import { restrictDirToCurrentUser } from "../platform/windows-acl.js";

/**
 * File containing the user's named wiki workspaces.
 */
export const WIKI_WORKSPACES_FILE = "wiki-workspaces.json";

/**
 * Current on-disk schema version for wiki workspaces.
 */
const WIKI_WORKSPACES_VERSION = 1;

/**
 * Maximum directory depth inspected by automatic wiki discovery.
 */
const MAX_DISCOVERY_DEPTH = 8;

/**
 * Maximum number of directories inspected by one discovery run.
 */
const MAX_DISCOVERY_DIRECTORIES = 20_000;

/**
 * Maximum supported serialized registry size.
 */
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;

/**
 * Maximum number of registered repository wikis.
 */
const MAX_REGISTERED_WIKIS = 10_000;

/**
 * Maximum number of named wiki workspaces.
 */
const MAX_REGISTERED_WORKSPACES = 1_000;

/**
 * Directory names that cannot contain a separately linked repository wiki.
 */
const IGNORED_DISCOVERY_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "openwiki",
]);

/**
 * Stable identifier accepted by workspace and retrieval operations.
 */
const IDENTIFIER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;

/**
 * One repository wiki found through a direct path or directory scan.
 */
export interface DiscoveredWiki {
  /**
   * Canonical absolute repository root.
   */
  root: string;

  /**
   * Human-readable repository name.
   */
  name: string;

  /**
   * Display path relative to the directory being inspected when possible.
   */
  path: string;
}

/**
 * One repository wiki stored in the global registry.
 */
export interface RegisteredWiki {
  /**
   * Stable identity accepted by retrieval tools.
   */
  id: string;

  /**
   * Human-readable repository name.
   */
  name: string;

  /**
   * Canonical absolute repository root.
   */
  root: string;
}

/**
 * One named exact union of repository wikis.
 */
export interface WikiWorkspace {
  /**
   * Stable workspace identity accepted by tools and the CLI.
   */
  id: string;

  /**
   * Human-readable globally unique workspace name.
   */
  name: string;

  /**
   * Stable IDs of the wikis included in this workspace.
   */
  wikis: string[];
}

/**
 * One repository's persistent active-workspace selection.
 */
export interface ActiveWikiWorkspace {
  /**
   * Repository wiki receiving the default selection.
   */
  wiki: string;

  /**
   * Workspace used when search does not provide an explicit workspace.
   */
  workspace: string;
}

/**
 * Strict versioned registry persisted under the OpenWiki home directory.
 */
export interface WikiWorkspaceRegistry {
  /**
   * Exact persisted schema version.
   */
  version: 1;

  /**
   * Normalized repository wiki inventory.
   */
  wikis: RegisteredWiki[];

  /**
   * Named many-to-many wiki memberships.
   */
  workspaces: WikiWorkspace[];

  /**
   * Optional persistent selection for repositories with overlapping workspaces.
   */
  active: ActiveWikiWorkspace[];
}

/**
 * Editable workspace representation used by the interactive manager.
 */
export interface WikiWorkspaceDraft {
  /**
   * Existing stable identity, omitted for a new workspace.
   */
  id?: string;

  /**
   * Human-readable workspace name.
   */
  name: string;

  /**
   * Exact canonical repository roots selected for the workspace.
   */
  roots: string[];
}

/**
 * Optional storage override used to isolate tests and embedded callers.
 */
export interface WikiWorkspaceStorageOptions {
  /**
   * OpenWiki home directory containing the workspace registry.
   */
  configDirectory?: string;
}

/**
 * Compact workspace identity returned by listing and ambiguity responses.
 */
export interface WikiWorkspaceSummary {
  /**
   * Stable workspace identity.
   */
  id: string;

  /**
   * Human-readable workspace name.
   */
  name: string;

  /**
   * Number of repository wikis in the workspace.
   */
  wikiCount: number;
}

/**
 * Wiki identity exposed to retrieval clients.
 */
export interface WikiIdentity {
  /**
   * Stable wiki identity.
   */
  id: string;

  /**
   * Human-readable repository name.
   */
  name: string;
}

/**
 * Workspaces containing one requested wiki.
 */
export interface WikiWorkspaceList {
  /**
   * Wiki whose memberships were inspected.
   */
  wiki: WikiIdentity;

  /**
   * Persistent active workspace when one is configured for the wiki.
   */
  activeWorkspace?: string;

  /**
   * Deterministically ordered containing workspaces.
   */
  workspaces: WikiWorkspaceSummary[];
}

/**
 * Member wikis returned for one workspace.
 */
export interface WorkspaceWikiList {
  /**
   * Selected workspace identity.
   */
  workspace: WikiWorkspaceSummary;

  /**
   * Deterministically ordered workspace members.
   */
  wikis: WikiIdentity[];
}

/**
 * One validated repository wiki ready for retrieval.
 */
export interface ResolvedWiki extends WikiIdentity {
  /**
   * Canonical absolute repository root.
   */
  root: string;
}

/**
 * Search scope resolved to the current wiki or one workspace.
 */
export interface ResolvedWikiSearchScope {
  /**
   * Successful resolution discriminator.
   */
  status: "ready";

  /**
   * Wiki from which the search began.
   */
  current: WikiIdentity;

  /**
   * Selected workspace, omitted for a standalone wiki.
   */
  workspace?: WikiWorkspaceSummary;

  /**
   * Validated wikis included in the exact search scope.
   */
  wikis: ResolvedWiki[];
}

/**
 * Search resolution result requiring a conversational workspace choice.
 */
export interface WikiWorkspaceRequired {
  /**
   * Ambiguous resolution discriminator.
   */
  status: "workspace_required";

  /**
   * Wiki from which the search began.
   */
  wiki: WikiIdentity;

  /**
   * Workspaces the agent can present to the user.
   */
  workspaces: WikiWorkspaceSummary[];
}

/**
 * Complete result of applying automatic workspace-selection rules.
 */
export type WikiSearchScope = ResolvedWikiSearchScope | WikiWorkspaceRequired;

/**
 * One directory pending bounded recursive discovery.
 */
interface DiscoveryDirectory {
  /**
   * Canonical absolute directory to inspect.
   */
  directory: string;

  /**
   * Descendant depth relative to the discovery root.
   */
  depth: number;
}

/**
 * Expected workspace configuration or discovery failure.
 */
export class WikiWorkspaceError extends Error {
  /**
   * Creates a caller-safe workspace error.
   *
   * @param message - Stable correction guidance safe for CLI and MCP clients.
   */
  constructor(message: string) {
    super(message);
    this.name = "WikiWorkspaceError";
  }
}

/**
 * Creates the empty supported workspace registry.
 *
 * @returns Empty versioned registry.
 */
export function emptyWikiWorkspaceRegistry(): WikiWorkspaceRegistry {
  return {
    version: WIKI_WORKSPACES_VERSION,
    wikis: [],
    workspaces: [],
    active: [],
  };
}

/**
 * Discovers Git repositories containing generated OpenWiki documentation.
 *
 * Discovery never follows symbolic links and bounds both depth and total work.
 *
 * @param startDirectory - Directory whose descendants should be inspected.
 * @returns Deterministically ordered repository wikis.
 * @throws {WikiWorkspaceError} When the directory is invalid or discovery is too broad.
 */
export async function discoverWikiRepositories(
  startDirectory: string,
): Promise<DiscoveredWiki[]> {
  const discoveryRoot = await canonicalDirectory(startDirectory);
  const pending: DiscoveryDirectory[] = [
    { directory: discoveryRoot, depth: 0 },
  ];
  const discovered: DiscoveredWiki[] = [];
  let visitedDirectories = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visitedDirectories += 1;
    if (visitedDirectories > MAX_DISCOVERY_DIRECTORIES) {
      throw new WikiWorkspaceError(
        "Wiki discovery is too broad. Add a narrower directory.",
      );
    }

    if (await isWikiRepository(current.directory)) {
      discovered.push(discoveredWiki(discoveryRoot, current.directory));
      continue;
    }

    if (current.depth >= MAX_DISCOVERY_DEPTH) continue;
    const entries = await readDiscoveryDirectory(current.directory);
    for (const entry of [...entries]
      .sort((left, right) => left.name.localeCompare(right.name))
      .reverse()) {
      if (!isDiscoverableDirectory(entry)) continue;
      pending.push({
        directory: path.join(current.directory, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return discovered.sort((left, right) => left.path.localeCompare(right.path));
}

/**
 * Resolves one user-entered repository or directory location.
 *
 * A path inside a linkable repository returns only that repository. An ordinary
 * directory is scanned for descendant repository wikis.
 *
 * @param location - Direct repository path, nested path, or directory to scan.
 * @param baseDirectory - Directory used to resolve a relative location.
 * @returns Deterministically ordered repository wikis found at the location.
 */
export async function discoverWikiLocation(
  location: string,
  baseDirectory: string = process.cwd(),
): Promise<DiscoveredWiki[]> {
  const resolved = resolveUserPath(location, baseDirectory);
  const directory = await canonicalDirectory(resolved);
  const containingRepository = await findContainingGitRepository(directory);
  if (containingRepository) {
    if (!(await isWikiRepository(containingRepository))) {
      throw new WikiWorkspaceError(
        "That repository does not contain openwiki/quickstart.md. Initialize its OpenWiki before linking it.",
      );
    }
    return [discoveredWiki(directory, containingRepository)];
  }
  return discoverWikiRepositories(directory);
}

/**
 * Reads and strictly validates the user's global workspace registry.
 *
 * @param options - Optional OpenWiki home override.
 * @returns Parsed registry or an empty registry when none exists.
 */
export async function readWikiWorkspaceRegistry(
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceRegistry> {
  const registryPath = workspaceRegistryPath(options);
  let content: string;
  try {
    const metadata = await lstat(registryPath);
    if (!metadata.isFile() || metadata.size > MAX_REGISTRY_BYTES) {
      throw invalidRegistryError();
    }
    content = await readFile(registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyWikiWorkspaceRegistry();
    }
    if (error instanceof WikiWorkspaceError) throw error;
    throw invalidRegistryError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw invalidRegistryError();
  }
  if (!isWikiWorkspaceRegistry(parsed)) throw invalidRegistryError();
  return parsed;
}

/**
 * Atomically replaces the complete named workspace collection.
 *
 * Stable workspace and wiki IDs are retained whenever their logical object
 * remains present. Active selections invalidated by an edit are removed.
 *
 * @param drafts - Complete final workspace collection from the manager.
 * @param options - Optional OpenWiki home override.
 * @returns Persisted normalized registry.
 */
export async function saveWikiWorkspaces(
  drafts: readonly WikiWorkspaceDraft[],
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceRegistry> {
  if (drafts.length > MAX_REGISTERED_WORKSPACES) {
    throw new WikiWorkspaceError("Too many wiki workspaces are configured.");
  }
  const previous = await readWikiWorkspaceRegistry(options);
  validateDraftNames(drafts);
  const canonicalDrafts = await Promise.all(
    drafts.map(async (draft) => ({
      ...draft,
      roots: await canonicalWikiRoots(draft.roots),
    })),
  );
  const roots = [
    ...new Set(canonicalDrafts.flatMap((draft) => draft.roots)),
  ].sort((left, right) => left.localeCompare(right));
  if (roots.length > MAX_REGISTERED_WIKIS) {
    throw new WikiWorkspaceError("Too many repository wikis are configured.");
  }

  const wikis = assignRegisteredWikis(roots, previous.wikis);
  const wikiIdByRoot = new Map(wikis.map((wiki) => [wiki.root, wiki.id]));
  const workspaces = assignWorkspaces(
    canonicalDrafts,
    wikiIdByRoot,
    previous.workspaces,
  );
  const membershipByWorkspace = new Map(
    workspaces.map((workspace) => [workspace.id, new Set(workspace.wikis)]),
  );
  const wikiIds = new Set(wikis.map((wiki) => wiki.id));
  const active = previous.active
    .filter(
      (selection) =>
        wikiIds.has(selection.wiki) &&
        membershipByWorkspace.get(selection.workspace)?.has(selection.wiki),
    )
    .sort((left, right) => left.wiki.localeCompare(right.wiki));
  const registry: WikiWorkspaceRegistry = {
    version: WIKI_WORKSPACES_VERSION,
    wikis,
    workspaces,
    active,
  };
  await writeWorkspaceRegistry(registry, options);
  return registry;
}

/**
 * Lists the workspaces containing the current or explicitly addressed wiki.
 *
 * @param repositoryRoot - Repository from which the tool call originates.
 * @param wikiId - Optional known wiki ID; omitted for the current repository.
 * @param options - Optional OpenWiki home override.
 * @returns Target wiki, its active selection, and containing workspaces.
 */
export async function listWikiWorkspaces(
  repositoryRoot: string,
  wikiId?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceList> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const wiki = wikiId
    ? findReachableWiki(context.registry, context.current, wikiId)
    : context.current;
  const workspaces = containingWorkspaces(context.registry, wiki.id);
  const activeWorkspace = context.registry.active.find(
    (selection) => selection.wiki === wiki.id,
  )?.workspace;
  return {
    wiki: wikiIdentity(wiki),
    ...(activeWorkspace ? { activeWorkspace } : {}),
    workspaces: workspaces.map(workspaceSummary),
  };
}

/**
 * Lists every wiki in one workspace containing the current repository.
 *
 * @param repositoryRoot - Repository from which the tool call originates.
 * @param workspaceReference - Workspace ID or unique case-insensitive name.
 * @param options - Optional OpenWiki home override.
 * @returns Selected workspace and its member wiki identities.
 */
export async function listWorkspaceWikis(
  repositoryRoot: string,
  workspaceReference: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WorkspaceWikiList> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const workspace = resolveContainingWorkspace(
    context.registry,
    context.current,
    workspaceReference,
  );
  return {
    workspace: workspaceSummary(workspace),
    wikis: workspace.wikis.map((id) =>
      wikiIdentity(requireRegisteredWiki(context.registry, id)),
    ),
  };
}

/**
 * Applies explicit, active, and implicit workspace selection for search.
 *
 * @param repositoryRoot - Repository from which search begins.
 * @param requestedWorkspace - Optional explicit workspace ID or name.
 * @param options - Optional OpenWiki home override.
 * @returns A ready exact scope or structured ambiguity choices.
 */
export async function resolveWikiSearchScope(
  repositoryRoot: string,
  requestedWorkspace?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiSearchScope> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const containing = containingWorkspaces(context.registry, context.current.id);
  if (requestedWorkspace) {
    return materializeSearchScope(
      context.registry,
      context.current,
      resolveContainingWorkspace(
        context.registry,
        context.current,
        requestedWorkspace,
      ),
    );
  }
  if (containing.length === 0) {
    return {
      status: "ready",
      current: wikiIdentity(context.current),
      wikis: [{ ...wikiIdentity(context.current), root: context.current.root }],
    };
  }
  if (containing.length === 1) {
    return materializeSearchScope(
      context.registry,
      context.current,
      containing[0],
    );
  }

  const activeWorkspaceId = context.registry.active.find(
    (selection) => selection.wiki === context.current.id,
  )?.workspace;
  const activeWorkspace = containing.find(
    (workspace) => workspace.id === activeWorkspaceId,
  );
  if (activeWorkspace) {
    return materializeSearchScope(
      context.registry,
      context.current,
      activeWorkspace,
    );
  }
  return {
    status: "workspace_required",
    wiki: wikiIdentity(context.current),
    workspaces: containing.map(workspaceSummary),
  };
}

/**
 * Resolves one exact wiki that the current repository is allowed to read.
 *
 * @param repositoryRoot - Repository from which the read originates.
 * @param wikiId - Optional target wiki ID; omitted for the current repository.
 * @param options - Optional OpenWiki home override.
 * @returns Validated target repository wiki.
 */
export async function resolveReadableWiki(
  repositoryRoot: string,
  wikiId?: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<ResolvedWiki> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  if (!wikiId || wikiId === context.current.id) {
    return { ...wikiIdentity(context.current), root: context.current.root };
  }
  return materializeWiki(
    findReachableWiki(context.registry, context.current, wikiId),
  );
}

/**
 * Sets the active workspace for one repository wiki.
 *
 * @param repositoryRoot - Current repository root or nested directory.
 * @param workspaceReference - Containing workspace ID or unique name.
 * @param options - Optional OpenWiki home override.
 * @returns Newly active workspace summary.
 */
export async function setActiveWikiWorkspace(
  repositoryRoot: string,
  workspaceReference: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<WikiWorkspaceSummary> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const workspace = resolveContainingWorkspace(
    context.registry,
    context.current,
    workspaceReference,
  );
  const active = context.registry.active.filter(
    (selection) => selection.wiki !== context.current.id,
  );
  active.push({ wiki: context.current.id, workspace: workspace.id });
  active.sort((left, right) => left.wiki.localeCompare(right.wiki));
  await writeWorkspaceRegistry({ ...context.registry, active }, options);
  return workspaceSummary(workspace);
}

/**
 * Clears the active workspace for one repository wiki.
 *
 * @param repositoryRoot - Current repository root or nested directory.
 * @param options - Optional OpenWiki home override.
 * @returns Whether a persistent selection was removed.
 */
export async function clearActiveWikiWorkspace(
  repositoryRoot: string,
  options: WikiWorkspaceStorageOptions = {},
): Promise<boolean> {
  const context = await loadRepositoryContext(repositoryRoot, options);
  const active = context.registry.active.filter(
    (selection) => selection.wiki !== context.current.id,
  );
  if (active.length === context.registry.active.length) return false;
  await writeWorkspaceRegistry({ ...context.registry, active }, options);
  return true;
}

/**
 * Converts the persisted registry into editable manager drafts.
 *
 * @param registry - Strict workspace registry.
 * @returns Workspaces containing canonical repository roots.
 */
export function workspaceDrafts(
  registry: WikiWorkspaceRegistry,
): WikiWorkspaceDraft[] {
  const wikiById = new Map(registry.wikis.map((wiki) => [wiki.id, wiki]));
  return registry.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    roots: workspace.wikis.map((id) => {
      const wiki = wikiById.get(id);
      if (!wiki) throw invalidRegistryError();
      return wiki.root;
    }),
  }));
}

/**
 * Repository and registry context shared by workspace operations.
 */
interface RepositoryContext {
  /**
   * Strict global registry.
   */
  registry: WikiWorkspaceRegistry;

  /**
   * Current repository wiki, registered or local-only.
   */
  current: RegisteredWiki;
}

/**
 * Loads the registry and identifies the canonical current repository.
 *
 * @param repositoryRoot - Repository root or nested directory.
 * @param options - Optional OpenWiki home override.
 * @returns Shared operation context.
 */
async function loadRepositoryContext(
  repositoryRoot: string,
  options: WikiWorkspaceStorageOptions,
): Promise<RepositoryContext> {
  const root = await canonicalDirectory(repositoryRoot);
  const registry = await readWikiWorkspaceRegistry(options);
  const current =
    registry.wikis.find((wiki) => wiki.root === root) ?? localWiki(root);
  return { registry, current };
}

/**
 * Resolves one requested wiki while keeping traversal within shared workspaces.
 *
 * @param registry - Strict global registry.
 * @param current - Current repository wiki.
 * @param wikiId - Requested stable wiki ID.
 * @returns Reachable registered wiki.
 */
function findReachableWiki(
  registry: WikiWorkspaceRegistry,
  current: RegisteredWiki,
  wikiId: string,
): RegisteredWiki {
  if (wikiId === current.id) return current;
  const target = registry.wikis.find((wiki) => wiki.id === wikiId);
  if (!target) {
    throw new WikiWorkspaceError(
      "Unknown wiki ID. Use an ID returned by OpenWiki search or listing.",
    );
  }
  const shared = registry.workspaces.some(
    (workspace) =>
      workspace.wikis.includes(current.id) &&
      workspace.wikis.includes(target.id),
  );
  if (!shared) {
    throw new WikiWorkspaceError(
      "The requested wiki does not share a workspace with the current repository.",
    );
  }
  return target;
}

/**
 * Resolves a workspace reference and verifies current-wiki membership.
 *
 * @param registry - Strict global registry.
 * @param current - Current repository wiki.
 * @param reference - Stable ID or case-insensitive workspace name.
 * @returns Matching containing workspace.
 */
function resolveContainingWorkspace(
  registry: WikiWorkspaceRegistry,
  current: RegisteredWiki,
  reference: string,
): WikiWorkspace {
  const normalized = reference.trim().toLowerCase();
  const workspace = registry.workspaces.find(
    (candidate) =>
      candidate.id === normalized ||
      candidate.name.toLowerCase() === normalized,
  );
  if (!workspace || !workspace.wikis.includes(current.id)) {
    throw new WikiWorkspaceError(
      "Unknown workspace for this repository. Use openwiki_list_workspaces to choose one.",
    );
  }
  return workspace;
}

/**
 * Returns every workspace containing one wiki in deterministic order.
 *
 * @param registry - Strict global registry.
 * @param wikiId - Stable wiki identity.
 * @returns Containing workspaces sorted by name and ID.
 */
function containingWorkspaces(
  registry: WikiWorkspaceRegistry,
  wikiId: string,
): WikiWorkspace[] {
  return registry.workspaces
    .filter((workspace) => workspace.wikis.includes(wikiId))
    .sort(compareWorkspaces);
}

/**
 * Materializes every member of one selected search workspace.
 *
 * @param registry - Strict global registry.
 * @param current - Current repository wiki.
 * @param workspace - Selected containing workspace.
 * @returns Ready exact search scope.
 */
async function materializeSearchScope(
  registry: WikiWorkspaceRegistry,
  current: RegisteredWiki,
  workspace: WikiWorkspace,
): Promise<ResolvedWikiSearchScope> {
  const wikis = await Promise.all(
    workspace.wikis.map((id) =>
      materializeWiki(requireRegisteredWiki(registry, id)),
    ),
  );
  return {
    status: "ready",
    current: wikiIdentity(current),
    workspace: workspaceSummary(workspace),
    wikis,
  };
}

/**
 * Validates one persisted repository path immediately before retrieval.
 *
 * @param wiki - Persisted wiki entry.
 * @returns Wiki with a verified canonical repository root.
 */
async function materializeWiki(wiki: RegisteredWiki): Promise<ResolvedWiki> {
  let canonical: string;
  try {
    canonical = await realpath(wiki.root);
  } catch {
    throw staleWorkspaceError();
  }
  if (canonical !== wiki.root || !(await isWikiRepository(canonical))) {
    throw staleWorkspaceError();
  }
  return { ...wikiIdentity(wiki), root: canonical };
}

/**
 * Finds one registered wiki by stable identity.
 *
 * @param registry - Strict global registry.
 * @param wikiId - Referenced wiki identity.
 * @returns Matching registered wiki.
 */
function requireRegisteredWiki(
  registry: WikiWorkspaceRegistry,
  wikiId: string,
): RegisteredWiki {
  const wiki = registry.wikis.find((candidate) => candidate.id === wikiId);
  if (!wiki) throw invalidRegistryError();
  return wiki;
}

/**
 * Creates a client-facing wiki identity without exposing its local path.
 *
 * @param wiki - Registered or local wiki.
 * @returns Stable ID and display name.
 */
function wikiIdentity(wiki: RegisteredWiki): WikiIdentity {
  return { id: wiki.id, name: wiki.name };
}

/**
 * Creates a compact workspace description.
 *
 * @param workspace - Persisted workspace.
 * @returns Client-facing workspace identity and member count.
 */
function workspaceSummary(workspace: WikiWorkspace): WikiWorkspaceSummary {
  return {
    id: workspace.id,
    name: workspace.name,
    wikiCount: workspace.wikis.length,
  };
}

/**
 * Assigns stable IDs to the final unique repository root collection.
 *
 * @param roots - Canonical selected repository roots.
 * @param previous - Prior registered wiki entries.
 * @returns Deterministically ordered normalized wiki entries.
 */
function assignRegisteredWikis(
  roots: readonly string[],
  previous: readonly RegisteredWiki[],
): RegisteredWiki[] {
  const previousByRoot = new Map(previous.map((wiki) => [wiki.root, wiki]));
  const retainedIds = new Set(
    roots
      .map((root) => previousByRoot.get(root)?.id)
      .filter((id): id is string => id !== undefined),
  );
  const used = new Set(retainedIds);
  return roots.map((root) => {
    const retained = previousByRoot.get(root);
    if (retained) return retained;
    const name = path.basename(root);
    const id = uniqueIdentifier(slugIdentifier(name, "wiki"), used);
    used.add(id);
    return { id, name, root };
  });
}

/**
 * Assigns stable workspace IDs and maps canonical roots to wiki IDs.
 *
 * @param drafts - Canonical validated workspace drafts.
 * @param wikiIdByRoot - Stable wiki identity lookup.
 * @param previous - Previous workspace collection.
 * @returns Deterministically ordered normalized workspaces.
 */
function assignWorkspaces(
  drafts: readonly WikiWorkspaceDraft[],
  wikiIdByRoot: ReadonlyMap<string, string>,
  previous: readonly WikiWorkspace[],
): WikiWorkspace[] {
  const previousIds = new Set(previous.map((workspace) => workspace.id));
  const retainedIds = drafts
    .map((draft) => draft.id)
    .filter((id): id is string => id !== undefined && previousIds.has(id));
  if (new Set(retainedIds).size !== retainedIds.length) {
    throw new WikiWorkspaceError("Duplicate wiki workspace identity.");
  }
  const used = new Set(retainedIds);
  const emittedRetained = new Set<string>();
  return drafts
    .map((draft) => {
      const retained = draft.id && previousIds.has(draft.id) ? draft.id : null;
      const id = retained
        ? retained
        : uniqueIdentifier(slugIdentifier(draft.name, "workspace"), used);
      if (retained && emittedRetained.has(id)) {
        throw new WikiWorkspaceError("Duplicate wiki workspace identity.");
      }
      used.add(id);
      if (retained) emittedRetained.add(retained);
      return {
        id,
        name: draft.name.trim(),
        wikis: draft.roots
          .map((root) => {
            const wikiId = wikiIdByRoot.get(root);
            if (!wikiId) throw invalidRegistryError();
            return wikiId;
          })
          .sort((left, right) => left.localeCompare(right)),
      };
    })
    .sort(compareWorkspaces);
}

/**
 * Canonicalizes, deduplicates, and verifies one workspace's selected roots.
 *
 * @param roots - User-selected repository roots.
 * @returns Deterministically ordered canonical roots.
 */
async function canonicalWikiRoots(roots: readonly string[]): Promise<string[]> {
  const canonical = [
    ...new Set(await Promise.all(roots.map(canonicalDirectory))),
  ].sort((left, right) => left.localeCompare(right));
  if (canonical.length < 2) {
    throw new WikiWorkspaceError(
      "Each wiki workspace must contain at least two repository wikis.",
    );
  }
  for (const root of canonical) {
    if (!(await isWikiRepository(root))) {
      throw new WikiWorkspaceError(
        "Every selected repository must contain openwiki/quickstart.md.",
      );
    }
  }
  return canonical;
}

/**
 * Validates workspace names before filesystem work begins.
 *
 * @param drafts - Complete final workspace collection.
 */
function validateDraftNames(drafts: readonly WikiWorkspaceDraft[]): void {
  const names = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    const normalized = name.toLowerCase();
    if (!isDisplayName(name) || names.has(normalized)) {
      throw new WikiWorkspaceError(
        "Workspace names must be unique, printable, and at most 80 characters.",
      );
    }
    names.add(normalized);
  }
}

/**
 * Atomically persists one already validated registry with private permissions.
 *
 * @param registry - Complete strict registry.
 * @param options - Optional OpenWiki home override.
 */
async function writeWorkspaceRegistry(
  registry: WikiWorkspaceRegistry,
  options: WikiWorkspaceStorageOptions,
): Promise<void> {
  if (!isWikiWorkspaceRegistry(registry)) throw invalidRegistryError();
  const registryPath = workspaceRegistryPath(options);
  const directory = path.dirname(registryPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  await restrictDirToCurrentUser(directory);
  await writeTextAtomic(
    registryPath,
    `${JSON.stringify(registry, null, 2)}\n`,
    0o600,
  );
  await chmod(registryPath, 0o600);
}

/**
 * Resolves the private workspace-registry path.
 *
 * @param options - Optional OpenWiki home override.
 * @returns Absolute registry path.
 */
function workspaceRegistryPath(options: WikiWorkspaceStorageOptions): string {
  const directory = path.resolve(
    options.configDirectory ?? resolveOpenWikiHomeDir(),
  );
  return path.join(directory, WIKI_WORKSPACES_FILE);
}

/**
 * Strictly validates the complete persisted registry shape and references.
 *
 * @param value - Unknown parsed JSON value.
 * @returns Whether the value is a supported registry.
 */
function isWikiWorkspaceRegistry(
  value: unknown,
): value is WikiWorkspaceRegistry {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["version", "wikis", "workspaces", "active"]) ||
    value.version !== WIKI_WORKSPACES_VERSION ||
    !Array.isArray(value.wikis) ||
    !Array.isArray(value.workspaces) ||
    !Array.isArray(value.active) ||
    value.wikis.length > MAX_REGISTERED_WIKIS ||
    value.workspaces.length > MAX_REGISTERED_WORKSPACES ||
    value.active.length > MAX_REGISTERED_WIKIS
  ) {
    return false;
  }

  const wikiIds = new Set<string>();
  const wikiRoots = new Set<string>();
  for (const wiki of value.wikis) {
    if (!isRegisteredWiki(wiki, wikiIds, wikiRoots)) return false;
    wikiIds.add(wiki.id);
    wikiRoots.add(wiki.root);
  }

  const workspaceIds = new Set<string>();
  const workspaceNames = new Set<string>();
  const memberships = new Map<string, Set<string>>();
  for (const workspace of value.workspaces) {
    if (!isWikiWorkspace(workspace, wikiIds, workspaceIds, workspaceNames)) {
      return false;
    }
    workspaceIds.add(workspace.id);
    workspaceNames.add(workspace.name.toLowerCase());
    memberships.set(workspace.id, new Set(workspace.wikis));
  }

  const activeWikis = new Set<string>();
  for (const selection of value.active) {
    if (
      !isRecord(selection) ||
      !hasOnlyKeys(selection, ["wiki", "workspace"]) ||
      typeof selection.wiki !== "string" ||
      typeof selection.workspace !== "string" ||
      activeWikis.has(selection.wiki) ||
      !memberships.get(selection.workspace)?.has(selection.wiki)
    ) {
      return false;
    }
    activeWikis.add(selection.wiki);
  }
  return true;
}

/**
 * Validates one persisted registered wiki and its uniqueness.
 *
 * @param value - Unknown wiki entry.
 * @param ids - IDs already observed.
 * @param roots - Roots already observed.
 * @returns Whether the entry is canonical and unique.
 */
function isRegisteredWiki(
  value: unknown,
  ids: ReadonlySet<string>,
  roots: ReadonlySet<string>,
): value is RegisteredWiki {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "name", "root"]) &&
    typeof value.id === "string" &&
    IDENTIFIER_PATTERN.test(value.id) &&
    !ids.has(value.id) &&
    typeof value.name === "string" &&
    isDisplayName(value.name) &&
    typeof value.root === "string" &&
    isCanonicalAbsolutePath(value.root) &&
    !roots.has(value.root)
  );
}

/**
 * Validates one persisted workspace and all membership references.
 *
 * @param value - Unknown workspace entry.
 * @param wikiIds - Complete registered wiki identities.
 * @param ids - Workspace IDs already observed.
 * @param names - Normalized workspace names already observed.
 * @returns Whether the workspace is canonical and unique.
 */
function isWikiWorkspace(
  value: unknown,
  wikiIds: ReadonlySet<string>,
  ids: ReadonlySet<string>,
  names: ReadonlySet<string>,
): value is WikiWorkspace {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "wikis"]) ||
    typeof value.id !== "string" ||
    !IDENTIFIER_PATTERN.test(value.id) ||
    ids.has(value.id) ||
    typeof value.name !== "string" ||
    !isDisplayName(value.name) ||
    names.has(value.name.toLowerCase()) ||
    !Array.isArray(value.wikis) ||
    value.wikis.length < 2 ||
    value.wikis.length > MAX_REGISTERED_WIKIS
  ) {
    return false;
  }
  const members = new Set<string>();
  for (const wiki of value.wikis) {
    if (typeof wiki !== "string" || !wikiIds.has(wiki) || members.has(wiki)) {
      return false;
    }
    members.add(wiki);
  }
  return true;
}

/**
 * Determines whether one display name is bounded and free of control text.
 *
 * @param value - Candidate human-readable name.
 * @returns Whether the name is safe for storage and terminal display.
 */
function isDisplayName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 80 &&
    value.trim() === value &&
    isTerminalSafeText(value)
  );
}

/**
 * Determines whether one path is already canonical, absolute, and bounded.
 *
 * @param value - Candidate persisted repository root.
 * @returns Whether the path is safe to resolve later.
 */
function isCanonicalAbsolutePath(value: string): boolean {
  return (
    value.length > 1 &&
    value.length <= 2_000 &&
    path.isAbsolute(value) &&
    path.normalize(value) === value &&
    isTerminalSafeText(value)
  );
}

/**
 * Checks whether an unknown value is a non-array object.
 *
 * @param value - Candidate value.
 * @returns Whether string-keyed property checks are safe.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Checks that an object has exactly the allowed own enumerable keys.
 *
 * @param value - Object under validation.
 * @param allowed - Complete allowed key set.
 * @returns Whether no required or extra key is present.
 */
function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === allowed.length && keys.every((key) => allowed.includes(key))
  );
}

/**
 * Canonicalizes and validates one directory.
 *
 * @param directory - Resolvable directory path.
 * @returns Canonical absolute directory path.
 */
async function canonicalDirectory(directory: string): Promise<string> {
  try {
    const canonical = await realpath(path.resolve(directory));
    if (!(await lstat(canonical)).isDirectory())
      throw new Error("not directory");
    return canonical;
  } catch {
    throw new WikiWorkspaceError("The wiki location does not exist.");
  }
}

/**
 * Finds the nearest containing Git repository without crossing the root.
 *
 * @param directory - Canonical directory at which to begin.
 * @returns Canonical repository root or `null` when the path is not in one.
 */
async function findContainingGitRepository(
  directory: string,
): Promise<string | null> {
  let candidate = directory;
  while (true) {
    if (await isGitRepository(candidate)) return candidate;
    const parent = path.dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

/**
 * Checks whether a directory is a Git repository with an OpenWiki quickstart.
 *
 * @param directory - Canonical candidate repository root.
 * @returns Whether the directory exposes a linkable repository wiki.
 */
async function isWikiRepository(directory: string): Promise<boolean> {
  return (
    (await isGitRepository(directory)) &&
    (await isRegularFile(path.join(directory, "openwiki", "quickstart.md")))
  );
}

/**
 * Checks for a directory or worktree-file Git marker.
 *
 * @param directory - Canonical candidate repository root.
 * @returns Whether the directory has a Git marker.
 */
async function isGitRepository(directory: string): Promise<boolean> {
  try {
    const marker = await lstat(path.join(directory, ".git"));
    return marker.isDirectory() || marker.isFile();
  } catch {
    return false;
  }
}

/**
 * Checks whether one path is an ordinary file without following a final symlink.
 *
 * @param filePath - Absolute candidate file path.
 * @returns Whether the path is a regular file.
 */
async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isFile();
  } catch {
    return false;
  }
}

/**
 * Reads one discovery directory while tolerating inaccessible descendants.
 *
 * @param directory - Canonical directory being traversed.
 * @returns Directory entries available to the current user.
 */
async function readDiscoveryDirectory(
  directory: string,
): Promise<Dirent<string>[]> {
  try {
    return await readdir(directory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") return [];
    throw new WikiWorkspaceError("Unable to inspect the wiki location.");
  }
}

/**
 * Determines whether one directory entry is safe and useful to traverse.
 *
 * @param entry - Candidate child entry.
 * @returns Whether discovery may inspect the child directory.
 */
function isDiscoverableDirectory(entry: Dirent<string>): boolean {
  return (
    entry.isDirectory() &&
    !entry.isSymbolicLink() &&
    !entry.name.startsWith(".") &&
    isTerminalSafeText(entry.name) &&
    !IGNORED_DISCOVERY_DIRECTORIES.has(entry.name)
  );
}

/**
 * Creates one display-oriented discovered wiki entry.
 *
 * @param displayRoot - Directory against which the path should be displayed.
 * @param repositoryRoot - Canonical repository root.
 * @returns Discovered wiki metadata.
 */
function discoveredWiki(
  displayRoot: string,
  repositoryRoot: string,
): DiscoveredWiki {
  const relative = path.relative(displayRoot, repositoryRoot);
  const name = path.basename(repositoryRoot);
  const displayPath =
    relative && !relative.startsWith("..") ? relative : repositoryRoot;
  if (!isTerminalSafeText(name) || !isTerminalSafeText(displayPath)) {
    throw new WikiWorkspaceError(
      "A repository path contains terminal control characters and cannot be linked safely.",
    );
  }
  return {
    root: repositoryRoot,
    name,
    path: displayPath,
  };
}

/**
 * Checks that filesystem text cannot inject terminal control sequences.
 *
 * @param value - Candidate display text.
 * @returns Whether every character is printable terminal text.
 */
function isTerminalSafeText(value: string): boolean {
  return [...value].every(
    (character) => character >= " " && character !== "\u007f",
  );
}

/**
 * Resolves a user path with explicit home-directory expansion.
 *
 * @param value - User-entered path.
 * @param baseDirectory - Base for relative paths.
 * @returns Absolute lexical path.
 */
function resolveUserPath(value: string, baseDirectory: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.resolve(os.homedir(), trimmed.slice(2));
  }
  return path.resolve(baseDirectory, trimmed || ".");
}

/**
 * Creates a local-only wiki identity for an unregistered repository.
 *
 * @param root - Canonical repository root.
 * @returns Ephemeral client-facing wiki entry.
 */
function localWiki(root: string): RegisteredWiki {
  const name = path.basename(root);
  return { id: slugIdentifier(name, "wiki"), name, root };
}

/**
 * Converts a display name to a bounded stable identifier base.
 *
 * @param value - Human-readable name.
 * @param fallback - Identifier used when no alphanumeric text remains.
 * @returns Lowercase identifier base.
 */
function slugIdentifier(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 56)
    .replace(/-+$/u, "");
  return slug || fallback;
}

/**
 * Adds the smallest numeric suffix needed for uniqueness.
 *
 * @param preferred - Preferred bounded identifier.
 * @param used - IDs already assigned.
 * @returns Unique identifier.
 */
function uniqueIdentifier(
  preferred: string,
  used: ReadonlySet<string>,
): string {
  if (!used.has(preferred)) return preferred;
  let suffix = 2;
  while (used.has(`${preferred}-${suffix}`)) suffix += 1;
  return `${preferred}-${suffix}`;
}

/**
 * Sorts workspaces by human name and stable identity.
 *
 * @param left - First workspace.
 * @param right - Second workspace.
 * @returns Locale comparison result.
 */
function compareWorkspaces(left: WikiWorkspace, right: WikiWorkspace): number {
  return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
}

/**
 * Creates stable repair guidance for malformed persisted state.
 *
 * @returns Bounded workspace registry error.
 */
function invalidRegistryError(): WikiWorkspaceError {
  return new WikiWorkspaceError(
    `The ${WIKI_WORKSPACES_FILE} file is invalid. Fix or remove it, then rerun openwiki link.`,
  );
}

/**
 * Creates stable repair guidance for unavailable registered repositories.
 *
 * @returns Bounded stale-workspace error.
 */
function staleWorkspaceError(): WikiWorkspaceError {
  return new WikiWorkspaceError(
    "A selected workspace contains an unavailable repository wiki. Repair it with openwiki link.",
  );
}
