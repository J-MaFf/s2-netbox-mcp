/**
 * One topic in the `get_guide` tool's static knowledge base (R5). `summary`
 * is the one-line description shown in the topic index; `content` is
 * returned verbatim when that topic's key is requested. Content is static,
 * generic S2 NetBox domain knowledge, compiled in as TypeScript source
 * rather than read from a file at runtime.
 */
export interface GuideTopic {
  title: string;
  summary: string;
  content: string;
}
