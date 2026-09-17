import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { readWikiSections, searchWiki } from "../../src/retrieval/wiki.ts";

/**
 * Temporary repository roots removed after each test.
 */
const temporaryRoots: string[] = [];

/**
 * Inputs used to render one generated wiki-page fixture.
 */
interface WikiPageFixture {
  /**
   * Human-readable page title.
   */
  title: string;

  /**
   * Retrieval-oriented page description.
   */
  description: string;

  /**
   * Repository-relative source path placed in frontmatter.
   */
  source: string;

  /**
   * Authored Markdown below the page title.
   */
  body: string;
}

/**
 * Creates an isolated wiki root with an architecture directory.
 *
 * @returns Absolute temporary repository root.
 */
async function createRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-retrieval-"));
  temporaryRoots.push(root);
  await mkdir(path.join(root, "openwiki/architecture"), { recursive: true });
  return root;
}

/**
 * Renders one complete OKF wiki-page fixture.
 *
 * @param options - Page metadata, source, and authored body.
 * @returns Complete Markdown page.
 */
function page(options: WikiPageFixture): string {
  return [
    "---",
    "type: guide",
    `title: ${options.title}`,
    `description: ${options.description}`,
    "sources:",
    "  - id: source",
    `    resource: repo://${options.source}`,
    "---",
    "",
    `# ${options.title}`,
    "",
    options.body,
    "",
  ].join("\n");
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("repository wiki retrieval", () => {
  test("search returns compact section references for progressive reads", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/payments.md"),
      page({
        title: "Payment Runtime",
        description: "Payment execution, retries, and failure handling.",
        source: "src/payments/service.ts",
        body: [
          "Requests enter through the payment service.",
          "",
          "## Retry control",
          "",
          "The circuit breaker owns the retry budget and exponential backoff.",
          "",
          "This additional paragraph is intentionally absent from the compact search excerpt.",
          "",
          "## Settlement",
          "",
          "Successful authorizations are settled asynchronously.",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = await searchWiki(root, {
      query: "Where is the retry budget and circuit breaker enforced?",
    });

    expect(result.results[0]).toMatchObject({
      kind: "section",
      ref: ["openwiki/architecture/payments.md#retry-control"],
    });
    expect(result.results[0]?.content).toContain("exponential backoff");
    expect(result.results[0]?.content).not.toContain("intentionally absent");
  });

  test("source paths boost otherwise ambiguous matches", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/api.md"),
      page({
        title: "API Validation",
        description: "Request validation.",
        source: "src/api/validate.ts",
        body: "## Validation\n\nValidation rejects malformed requests.",
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "openwiki/architecture/jobs.md"),
      page({
        title: "Job Validation",
        description: "Queued job validation.",
        source: "src/jobs/validate.ts",
        body: "## Validation\n\nValidation rejects malformed queued requests.",
      }),
      "utf8",
    );

    const result = await searchWiki(root, {
      query: "validation rejects malformed requests",
      paths: ["src/jobs/validate.ts"],
      limit: 1,
    });

    expect(result.results[0]?.ref).toEqual([
      "openwiki/architecture/jobs.md#validation",
    ]);
  });

  test("read returns exact complete sections in request order", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/payments.md"),
      page({
        title: "Payment Runtime",
        description: "Payment behavior.",
        source: "src/payments.ts",
        body: [
          "## Retry control",
          "",
          "The first retry section.",
          "",
          "### Limits",
          "",
          "The child section stays with its parent.",
          "",
          "## Retry control",
          "",
          "The repeated retry section.",
        ].join("\n"),
      }),
      "utf8",
    );

    const result = await readWikiSections(root, {
      page: "openwiki/architecture/payments.md",
      sections: ["retry-control-1", "retry-control"],
    });

    expect(result.page).toBe("openwiki/architecture/payments.md");
    expect(result.sections).toEqual([
      {
        section: "retry-control-1",
        content: "## Retry control\n\nThe repeated retry section.",
      },
      {
        section: "retry-control",
        content: [
          "## Retry control",
          "",
          "The first retry section.",
          "",
          "### Limits",
          "",
          "The child section stays with its parent.",
        ].join("\n"),
      },
    ]);
  });

  test("returns no search results when the repository has no wiki", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openwiki-retrieval-"));
    temporaryRoots.push(root);
    await expect(searchWiki(root, { query: "architecture" })).resolves.toEqual({
      results: [],
    });
  });

  test("ignores hidden and deprecated pages and treats FTS operators as data", async () => {
    const root = await createRoot();
    await writeFile(
      path.join(root, "openwiki/architecture/.private.md"),
      page({
        title: "Private",
        description: "Hidden internal notes.",
        source: "src/private.ts",
        body: "## Hidden\n\nhiddenonly",
      }),
      "utf8",
    );
    await writeFile(
      path.join(root, "openwiki/architecture/retired.md"),
      page({
        title: "Retired",
        description: "Deprecated notes.",
        source: "src/retired.ts",
        body: "## Retired\n\nretiredonly",
      }).replace("type: guide", "type: guide\nstatus: deprecated"),
      "utf8",
    );

    await expect(searchWiki(root, { query: "hiddenonly" })).resolves.toEqual({
      results: [],
    });
    await expect(searchWiki(root, { query: "retiredonly" })).resolves.toEqual({
      results: [],
    });
    await expect(searchWiki(root, { query: '" OR * NOT (' })).resolves.toEqual({
      results: [],
    });
    await expect(
      readWikiSections(root, {
        page: "openwiki/architecture/.private.md",
        sections: ["hidden"],
      }),
    ).rejects.toThrow("non-structural Markdown path");
  });

  test("read rejects structural pages and unknown sections", async () => {
    const root = await createRoot();
    await writeFile(path.join(root, "openwiki/index.md"), "# Index\n", "utf8");
    await writeFile(
      path.join(root, "openwiki/architecture/runtime.md"),
      page({
        title: "Runtime",
        description: "Runtime behavior.",
        source: "src/runtime.ts",
        body: "## Startup\n\nStartup validates configuration.",
      }),
      "utf8",
    );

    await expect(
      readWikiSections(root, {
        page: "openwiki/index.md",
        sections: ["index"],
      }),
    ).rejects.toThrow("non-structural Markdown path");
    await expect(
      readWikiSections(root, {
        page: "openwiki/architecture/runtime.md",
        sections: ["missing"],
      }),
    ).rejects.toThrow("Unknown section: missing");
  });
});
