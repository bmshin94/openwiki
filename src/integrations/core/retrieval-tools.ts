import { z } from "zod";
import {
  ClaimsError,
  ClaimsPageMissingError,
} from "../../claims/core/errors.js";
import {
  readWikiSections,
  searchWiki,
  WIKI_RETRIEVAL_LIMITS,
  WikiRetrievalError,
} from "../../retrieval/wiki.js";
import { HostIntegrationError } from "./errors.js";
import type { ProtocolTool } from "./protocol.js";
import { resolveRepositoryRoot } from "./repository-root.js";

/**
 * Shared non-empty string boundary for retrieval tool inputs.
 */
const CanonicalString = z.string().trim().min(1);

/**
 * Strict schema for compact repository wiki search.
 */
export const SearchInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    query: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.queryCharacters).describe(
      "Repository question, behavior, or concept to find in the wiki.",
    ),
    paths: z
      .array(CanonicalString.max(WIKI_RETRIEVAL_LIMITS.sourcePathCharacters))
      .max(WIKI_RETRIEVAL_LIMITS.sourcePathHints)
      .optional()
      .describe(
        "Optional repository-relative source paths that boost related wiki sections.",
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(WIKI_RETRIEVAL_LIMITS.searchResults)
      .optional()
      .describe("Optional number of ranked results to return."),
  })
  .strict();

/**
 * Strict schema for exact section reads from search references.
 */
export const ReadInput = z
  .object({
    root: CanonicalString.describe(
      "Absolute Git repository root containing openwiki/.",
    ),
    page: CanonicalString.max(WIKI_RETRIEVAL_LIMITS.pageCharacters).describe(
      'Wiki page from a search ref, e.g. "openwiki/architecture/jobs.md".',
    ),
    sections: z
      .array(CanonicalString.max(WIKI_RETRIEVAL_LIMITS.sectionAnchorCharacters))
      .min(1)
      .max(WIKI_RETRIEVAL_LIMITS.sectionAnchors)
      .describe('Heading anchors from search refs, e.g. ["retry-control"].'),
  })
  .strict();

/**
 * Creates read-only repository memory tools independent of generation sessions.
 *
 * @returns Ordered search and exact-section read tool definitions.
 */
export function createRetrievalTools(): ProtocolTool[] {
  return [
    {
      name: "openwiki_search",
      description: [
        "Search an existing repository OpenWiki without a model call or generation run.",
        "Returns compact ranked results as {results:[{kind,ref,content}]}; split each ref at # into the page and exact heading anchor for openwiki_read.",
        "Optional source paths boost related sections but do not filter other matches.",
        "Empty results are valid.",
      ].join(" "),
      schema: SearchInput,
      handle: async (input) => {
        const request = SearchInput.parse(input);
        return runRetrieval("search", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return searchWiki(root, request);
        });
      },
    },
    {
      name: "openwiki_read",
      description: [
        "Read one or more complete Markdown sections selected from openwiki_search refs.",
        "Pass the ref's page and heading anchors exactly; sections are returned separately in request order.",
        "No model call or generation run is required.",
      ].join(" "),
      schema: ReadInput,
      handle: async (input) => {
        const request = ReadInput.parse(input);
        return runRetrieval("read", async () => {
          const root = await resolveRepositoryRoot(request.root);
          return readWikiSections(root, request);
        });
      },
    },
  ];
}

/**
 * Executes retrieval and maps expected failures to bounded host errors.
 *
 * @param operation - Retrieval operation used for error classification.
 * @param task - Deferred repository retrieval operation.
 * @returns Successful retrieval result.
 * @throws {HostIntegrationError} For expected input or repository-state errors.
 */
async function runRetrieval<T>(
  operation: "read" | "search",
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof HostIntegrationError) throw error;
    if (error instanceof WikiRetrievalError) {
      throw new HostIntegrationError("invalid_input", error.message);
    }
    if (operation === "read" && error instanceof ClaimsPageMissingError) {
      throw new HostIntegrationError(
        "invalid_input",
        "The requested OpenWiki page does not exist.",
      );
    }
    if (error instanceof ClaimsError) {
      throw new HostIntegrationError(
        "invalid_state",
        `Unable to ${operation} the repository OpenWiki safely. Check the wiki and retry.`,
      );
    }
    throw error;
  }
}
