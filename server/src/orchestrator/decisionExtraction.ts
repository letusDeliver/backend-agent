import type { AgentType, DecisionCategory, DecisionPolarity, SpecialistReport } from "../types/index.js";
import type { ContextPackEntry } from "../memory/contextPack.js";

/**
 * Deterministic decision-comparison engine for reconciliation CONFLICT
 * detection (PHASE_30_IMPLEMENTATION_PLAN.md sections 4/5). No LLM call
 * anywhere in this file — same inputs always produce the same output
 * (section 9/17 of the phase brief: determinism).
 */
export interface ExtractedDecision {
  agent: AgentType;
  category: DecisionCategory;
  polarity: DecisionPolarity;
  text: string;
  rationale: string;
  evidence: string;
  confidence: number;
  significantTerms: Set<string>;
  memoryInfluenced: boolean;
  memoryIds: string[];
}

// Ordered most-specific-first: the first category whose keywords appear in
// the decision text wins. "architecture" has no keywords of its own — it is
// the fallback when nothing more specific matches.
const CATEGORY_KEYWORDS: Array<[DecisionCategory, string[]]> = [
  ["transaction", ["transaction", "atomicity", "atomic operation", "rollback", "commit boundary", "acid compliance"]],
  ["authentication", ["authentication", "auth token", "jwt", "oauth", "login flow", "session token"]],
  ["authorization", ["authorization", "access control", "role-based", "rbac", "permission check"]],
  ["data-model", ["schema", "data model", "migration", "table structure", "column definition", "entity relationship"]],
  [
    "database",
    ["database", "postgres", "postgresql", "mysql", "mongodb", "mongo", "redis", "sqlite", "query plan", "connection pool", "index"],
  ],
  ["api", ["endpoint", "api contract", "route handler", "rest api", "http method", "request/response"]],
  ["validation", ["validation", "input validation", "sanitize", "schema validation"]],
  ["error-handling", ["error handling", "exception handling", "retry logic", "failure mode"]],
  ["performance", ["performance", "latency", "throughput", "caching strategy", "scalability", "cache"]],
  ["testing", ["test coverage", "unit test", "integration test", "test suite"]],
  ["dependency", ["dependency", "third-party package", "external library"]],
  ["configuration", ["configuration", "environment variable", "config file", "feature flag"]],
  ["deployment", ["deployment", "ci/cd", "rollout", "container image", "infrastructure"]],
];

// Categories where a single task realistically has at most one instance of
// the concern — category match alone is enough to group decisions as "the
// same subject" (plan section 5, stage 2). Every other category additionally
// requires shared significant terms, since e.g. "database" or "api" can
// plausibly cover multiple unrelated concerns within one task.
const NARROW_CATEGORIES = new Set<DecisionCategory>(["transaction", "authentication", "authorization", "data-model"]);

const MATERIAL_CATEGORIES = new Set<DecisionCategory>([
  "architecture",
  "api",
  "database",
  "data-model",
  "transaction",
  "authentication",
  "authorization",
  "deployment",
]);

export function materialityOf(category: DecisionCategory): "material" | "non-material" {
  return MATERIAL_CATEGORIES.has(category) ? "material" : "non-material";
}

const GENERIC_NEGATION: RegExp[] = [
  /\bdo(?:es)? ?not\b/,
  /\bdon'?t\b/,
  /\bshould ?not\b/,
  /\bshouldn'?t\b/,
  /\bmust ?not\b/,
  /\bnever\b/,
  /\bavoid(?:ing)?\b/,
  /\bwithout\b/,
  /\bcannot\b/,
  /\bcan'?t\b/,
  /\bwon'?t\b/,
];

// Explicit antonym phrases for the two cases the phase brief itself names as
// canonical examples of a real conflict. Deliberately small — this is not a
// general sentiment classifier.
const CATEGORY_NEGATIVE_PHRASES: Partial<Record<DecisionCategory, string[]>> = {
  transaction: [
    "eventually consistent",
    "eventual consistency",
    "no transaction",
    "without a transaction",
    "avoid a transaction",
    "avoid transactions",
    "skip the transaction",
    "not use a transaction",
    "not wrap this in a transaction",
  ],
  architecture: ["asynchronous processing", "asynchronous boundary", "async boundary", "non-blocking processing"],
};

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "with", "this", "that",
  "is", "are", "be", "should", "must", "will", "using", "use", "existing", "repository",
  "requirement", "implement", "implementing", "add", "adding", "new", "follow", "following",
  "layer", "layering", "current", "rather", "than", "not", "do", "does", "it", "its", "as", "by",
  "from", "into", "about", "how", "what", "when", "so", "per", "any", "no",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function categoryKeywordTokens(category: DecisionCategory): Set<string> {
  const keywords = CATEGORY_KEYWORDS.find(([c]) => c === category)?.[1] ?? [];
  const tokens = new Set<string>();
  for (const phrase of keywords) {
    for (const token of tokenize(phrase)) tokens.add(token);
  }
  return tokens;
}

// Checked ahead of the ordered keyword table below: a phrase like "an
// asynchronous transaction boundary" is really a concurrency-model
// statement, not a transaction statement, even though it contains the
// substring "transaction" — without this, the two named examples in the
// phase brief's own section 3 (synchronous vs. asynchronous processing)
// would misclassify into different categories and never even be compared.
const CONCURRENCY_SIGNAL = ["synchronous processing", "asynchronous processing", "synchronous", "asynchronous", "non-blocking", "concurrency model"];

function classifyCategory(text: string): DecisionCategory {
  const lower = text.toLowerCase();
  if (CONCURRENCY_SIGNAL.some((kw) => lower.includes(kw))) return "architecture";
  for (const [category, keywords] of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) return category;
  }
  return "architecture";
}

// How far past a generic negation marker (in characters) a category keyword
// must appear for the negation to count as negating *that* concept, rather
// than an unrelated word earlier or later in the sentence. This is what
// tells "do not use a transaction" (negative) apart from "so partial writes
// never occur" or "...to avoid malformed rows" (both affirmative toward the
// actual recommendation — the negation there governs a different noun
// entirely). A known limitation: a negation that grammatically precedes its
// governing keyword ("a transaction should not be used") is missed — this
// is a deliberate precision-over-recall tradeoff (plan section 5/19: false
// positives are the primary risk this algorithm must avoid).
const NEGATION_WINDOW_CHARS = 40;

function classifyPolarity(text: string, category: DecisionCategory): DecisionPolarity {
  const lower = text.toLowerCase();

  const negativePhrases = CATEGORY_NEGATIVE_PHRASES[category] ?? [];
  if (negativePhrases.some((phrase) => lower.includes(phrase))) return "negative";

  const keywords = CATEGORY_KEYWORDS.find(([c]) => c === category)?.[1] ?? [];
  if (keywords.length === 0) return "affirmative";

  for (const negation of GENERIC_NEGATION) {
    const match = negation.exec(lower);
    if (!match) continue;
    const window = lower.slice(match.index, match.index + match[0].length + NEGATION_WINDOW_CHARS);
    if (keywords.some((kw) => window.includes(kw))) return "negative";
  }
  return "affirmative";
}

function significantTerms(text: string, category: DecisionCategory): Set<string> {
  const excluded = categoryKeywordTokens(category);
  const terms = new Set<string>();
  for (const token of tokenize(text)) {
    if (token.length < 3) continue;
    if (STOPWORDS.has(token)) continue;
    if (excluded.has(token)) continue;
    terms.add(token);
  }
  return terms;
}

/** Exposes the category/polarity/subject-term classifiers for arbitrary text (review findings — see detectReviewConflicts). */
export function classifyDecisionText(text: string): { category: DecisionCategory; polarity: DecisionPolarity; significantTerms: Set<string> } {
  const category = classifyCategory(text);
  return { category, polarity: classifyPolarity(text, category), significantTerms: significantTerms(text, category) };
}

/**
 * One decision per completed report (a report carries exactly one headline
 * recommendation today — plan section 4). Non-completed reports (failed /
 * not_required / pending) never reach conflict detection, mirroring the
 * existing `reconciliation.decisions` filter.
 */
export function extractDecision(report: SpecialistReport, memoryEntries: ContextPackEntry[]): ExtractedDecision | null {
  if (report.status !== "completed") return null;

  const rationale = report.findings.map((f) => f.summary).join("; ") || report.recommendation;
  const evidence = report.findings.map((f) => f.evidence).join("; ") || "No direct repository evidence captured.";
  const fullText = [report.recommendation, rationale, evidence].join(" ");
  const category = classifyCategory(fullText);

  return {
    agent: report.agent,
    category,
    polarity: classifyPolarity(fullText, category),
    text: report.recommendation,
    rationale,
    evidence,
    confidence: report.confidence,
    significantTerms: significantTerms(fullText, category),
    memoryInfluenced: memoryEntries.length > 0,
    memoryIds: memoryEntries.map((e) => e.memoryId),
  };
}

/** Stage 2 of the algorithm (plan section 5): are these two decisions about the same subject? */
export function sameSubject(a: ExtractedDecision, b: ExtractedDecision): boolean {
  if (a.category !== b.category) return false;
  if (NARROW_CATEGORIES.has(a.category)) return true;
  if (a.significantTerms.size === 0 || b.significantTerms.size === 0) return true;
  for (const term of a.significantTerms) {
    if (b.significantTerms.has(term)) return true;
  }
  return false;
}

/**
 * Groups decisions that are all mutually about the same subject (transitive
 * via a shared category; pairwise subject-overlap is checked against the
 * group's first member, which is sufficient given decisions are already
 * restricted to one category per group).
 */
export function groupBySubject(decisions: ExtractedDecision[]): ExtractedDecision[][] {
  const byCategory = new Map<DecisionCategory, ExtractedDecision[]>();
  for (const decision of decisions) {
    const list = byCategory.get(decision.category) ?? [];
    list.push(decision);
    byCategory.set(decision.category, list);
  }

  const groups: ExtractedDecision[][] = [];
  for (const categoryDecisions of byCategory.values()) {
    const remaining = [...categoryDecisions];
    while (remaining.length > 0) {
      const seed = remaining.shift()!;
      const group = [seed];
      for (let i = remaining.length - 1; i >= 0; i -= 1) {
        if (sameSubject(seed, remaining[i])) {
          group.push(...remaining.splice(i, 1));
        }
      }
      groups.push(group);
    }
  }
  return groups;
}
