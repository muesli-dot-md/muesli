// REST data layer for the cross-document link graph (ADR 0015;
// internal/design/wikilinks-and-link-graph.md).
//
// Deliberately DOM-free and self-contained (no relative imports), so the
// headless integration test (scripts/graph-e2e.mjs) can import this file
// directly under node 22 type-stripping and drive the EXACT functions the UI
// uses against a live server — same convention as collabApi.ts/workspaceApi.ts.
//
// Server contract (crates/muesli-server/src/links.rs):
//   GET /api/graph                       → { nodes, edges, unresolved }
//   GET /api/documents/{slug}/links      → { outgoing, incoming }
// Requests carry credentials; a share token (per-document routes) rides in
// the X-Muesli-Share header — never the query string, so the capability token
// stays out of access logs and browser history (security review finding 28).
// Non-2xx responses throw GraphApiError (status + plain-text body):
// 401/403 → sign in, 503 → volatile mode (graph hidden).

export type GraphNode = {
  document_id: string;
  slug: string;
  title: string;
  /** Resolved outgoing/incoming edge counts (unresolved targets not included). */
  links_out: number;
  links_in: number;
  /** null for ownerless/open-mode documents — mirrors DocumentSummary.workspace_id. */
  workspace_id: string | null;
};

export type GraphEdge = { src: string; dst: string; raw_target: string };

/** A link whose target doesn't resolve to a document (yet) — a ghost node. */
export type UnresolvedLink = { src: string; raw_target: string };

export type Graph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedLink[];
};

export type OutgoingLink = {
  raw_target: string;
  resolved: boolean;
  document_id: string | null;
  slug: string | null;
};

export type IncomingLink = { document_id: string; slug: string; raw_target: string };

export type DocumentLinks = { outgoing: OutgoingLink[]; incoming: IncomingLink[] };

export class GraphApiError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(bodyText.trim() || `HTTP ${status}`);
    this.name = "GraphApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export type GraphApiConfig = {
  httpBase: string;
  shareToken?: string | null;
  /** Override fetch (tests); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
};

export function createGraphApi(cfg: GraphApiConfig) {
  const fetchFn = cfg.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function req<T>(path: string, withShare = false): Promise<T> {
    const url = new URL(`${cfg.httpBase}${path}`);
    // Share token rides in a header, NOT the query string (finding 28).
    const headers: Record<string, string> | undefined =
      withShare && cfg.shareToken ? { "X-Muesli-Share": cfg.shareToken } : undefined;
    const res = await fetchFn(url.toString(), { credentials: "include", headers });
    const text = await res.text();
    if (!res.ok) throw new GraphApiError(res.status, text);
    return JSON.parse(text) as T;
  }

  return {
    /** The whole graph visible to the caller (open mode: everything). */
    getGraph: () => req<Graph>("/api/graph"),
    /** Outgoing + incoming links of one document (the backlinks panel). */
    getDocumentLinks: (slug: string) =>
      req<DocumentLinks>(`/api/documents/${encodeURIComponent(slug)}/links`, true),
  };
}

export type GraphApi = ReturnType<typeof createGraphApi>;
